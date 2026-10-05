// 服务端日志：只管「出事了要留痕」这一件事（纯函数 + 一点点 IO，都好测）。
//
// 为什么要有它：本地跑的 `node server.mjs` 是**一个终端里的一次性进程**，
// 出问题时的线索只有那个终端窗口里的滚动文字 —— 窗口一关、滚过去，就什么都查不到了。
// 实际遇到过的两次：一次是 400 被误报成「连不上服务端」（那是文案问题），
// 另一次是进程整个不见了，谁也不知道它是崩了还是被谁结束了。
//
// 所以这里记三类东西，都写进同一个文件（默认 `data/server.log`）：
//   1. **启动**：什么时候起的、端口、用哪个模型、在线还是离线 —— 至少知道它曾经起过；
//   2. **崩溃**：未捕获异常 / 未处理的 Promise 拒绝，连堆栈一起留下；
//   3. **结束**：退出码，或者收到了哪个信号（SIGTERM 多半是终端被关掉/有人手动结束）。
//
// 怎么读它：**日志里没有崩溃记录，却也没有结束记录** → 说明进程是被外部直接干掉的
// （Windows 上关掉控制台窗口就是这样，收不到任何信号）。这本身就是答案。

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';

/** 日志文件多大就轮转（留一份 .1，不无限长） */
export const CRASH_LOG_MAX_BYTES = 1024 * 1024;

/** 崩溃风暴：这个窗口内崩超过这么多次，就记完最后一条退出 —— 免得无限刷日志、状态还不可信 */
export const CRASH_LOOP_WINDOW_MS = 60_000;
export const CRASH_LOOP_LIMIT = 10;

/** 本地时间前缀：和终端里看到的时间对得上，别用 ISO（那是 UTC，对不上会误判顺序） */
export function stamp(at = Date.now()) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 一行普通日志 */
export function logLine(text, at = Date.now()) {
  return `[${stamp(at)}] ${text}`;
}

/** 启动那一行：知道它什么时候起过、拿的是什么配置 */
export function startEntry({ port = 0, model = '', mode = 'model', baseUrl = '' } = {}, at = Date.now()) {
  const where = mode === 'mock' ? '离线回答（没有可用模型）' : `模型 ${model || '(默认)'}`;
  const upstream = baseUrl ? ` · 上游 ${baseUrl}` : '';
  return logLine(`启动：端口 ${port} · ${where}${upstream}`, at);
}

/** 崩溃那一行：堆栈必须留下，否则下次还是只能猜 */
export function crashEntry(kind, error, at = Date.now()) {
  const label = kind === 'unhandledRejection' ? '未处理的 Promise 拒绝' : '未捕获异常';
  const err = error ?? {};
  // 非 Error 的拒绝理由（字符串、对象）也要能落下来
  const detail = typeof err === 'string' ? err : err.stack || err.message || String(err);
  const cause = err.cause?.code || err.code || '';
  return logLine(`${label}${cause ? `（${cause}）` : ''}：\n${detail}`, at);
}

/** 结束那一行：退出码 / 信号 */
export function exitEntry(code = 0, signal = null, at = Date.now()) {
  return logLine(`进程结束：退出码 ${code}${signal ? ` · 信号 ${signal}` : ''}`, at);
}

/**
 * 崩溃风暴判定：窗口内崩了几次、要不要就此退出。
 * 不退出的话，一个"每次请求都炸"的状态会无限刷日志，而且服务的回答已经不可信了。
 */
export function crashLoop(times, { now = Date.now(), windowMs = CRASH_LOOP_WINDOW_MS, limit = CRASH_LOOP_LIMIT } = {}) {
  const recent = (Array.isArray(times) ? times : []).filter((t) => now - t <= windowMs);
  return { count: recent.length, exceeded: recent.length > limit };
}

/** 日志文件要不要轮转 */
export function shouldRotate(size, max = CRASH_LOG_MAX_BYTES) {
  return Number(size) > max;
}

/**
 * 把日志装上：写文件 + 注册进程事件。
 *
 * 为什么这些 IO 放在 lib 里（而不是留在 server.mjs）：**不这样就测不了**。
 * Windows 上 `child.kill()` 是硬终止，子进程收不到任何信号 —— 起个真服务再弄死它这条路
 * 在 Windows 上根本走不通（实测：日志里只剩启动那一行）。放进模块之后，
 * 测试可以用 `process.emit('SIGINT')` 合成一个信号，把这条最关键的路径真正跑一遍。
 *
 * @param {object} options
 * @param {string} options.logFile 日志文件路径
 * @param {string} [options.dir] 目录（默认取 logFile 的目录）
 * @param {(code: number) => void} [options.onFatal] 该退出时怎么退（测试用它观察，不去真退）
 */
export function installCrashLog({
  logFile,
  dir,
  onFatal = (code) => process.exit(code),
  // 默认顺手注册进程事件；测「写不进去也不吵」时要关掉 ——
  // 否则测试进程会被装上一个 uncaughtException 处理器，反而把真异常吞掉
  watchProcess = true,
} = {}) {
  const directory = dir || (logFile ? logFile.replace(/[\\/][^\\/]*$/, '') : '.');
  let crashTimes = [];

  /** 同步写是有意的：崩溃兜底里等异步落盘，很可能一个字都没写出去进程就没了 */
  function writeLog(line) {
    try {
      mkdirSync(directory, { recursive: true });
      const size = existsSync(logFile) ? statSync(logFile).size : 0;
      if (shouldRotate(size)) renameSync(logFile, `${logFile}.1`);
      appendFileSync(logFile, `${line}\n`, 'utf8');
    } catch {
      /* 日志是附件，不是功能：写不进去也绝不影响服务本身 */
    }
  }

  function handleCrash(kind, error) {
    const at = Date.now();
    const { count, exceeded } = crashLoop(crashTimes, { now: at });
    crashTimes = [...crashTimes, at];

    writeLog(crashEntry(kind, error, at));
    if (!exceeded) return;

    // 一直崩说明状态已经不可信了：记完最后一条就退出，让用户看见、去重启。
    // 硬撑着的服务会给出看起来正常、其实是错的回答，那比停下来更糟。
    writeLog(logLine(`一分钟内崩了 ${count} 次 —— 记完这一条就退出；请重启：node server.mjs`, at));
    onFatal(1);
  }

  if (watchProcess) {
    process.on('uncaughtException', (error) => handleCrash('uncaughtException', error));
    // Promise 拒绝不留痕是最难查的：注册这个之后 Node 不再默认打印/退出，所以必须自己记下来
    process.on('unhandledRejection', (reason) => handleCrash('unhandledRejection', reason));
    // 信号 = 外面结束的（关终端、Ctrl+C），和「自己崩了」区分开。
    // 注意：Windows 上关掉控制台窗口是**硬终止**，收不到信号 —— 那种情况日志里会干干净净，
    // 「没有崩溃记录、也没有结束记录」本身就是判断依据。
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        writeLog(logLine(`收到 ${signal}：进程被外部结束（关终端窗口 / Ctrl+C / 被杀进程）`));
        onFatal(0);
      });
    }
    process.on('exit', (code) => writeLog(exitEntry(code)));
  }

  return {
    writeLog,
    /** 启动那一行：知道它什么时候起过、拿的是什么配置 */
    start(info) {
      writeLog(startEntry(info));
    },
    /** 供测试直接触发一次崩溃（不必真把进程炸掉） */
    crash: handleCrash,
  };
}
