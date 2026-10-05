// 服务端日志的变异测试：确认「出事要留痕」那批断言真的抓得住缺陷
//
//   node test/log-mutations.mjs
//
// 骨架在 test/mutation-harness.mjs（快照、还原、崩溃判定、收尾都在那边）。
// 这一套跑的是 test/run-tests.mjs —— 它会真起服务、也会用子脚本合成信号与异常。

import { createMutationRunner } from './mutation-harness.mjs';

const LOG = 'lib/crash-log.mjs';
const SERVER = 'server.mjs';

const runner = createMutationRunner({
  label: '服务端日志',
  suite: 'test/run-tests.mjs',
  files: [LOG, SERVER],
});

runner.run('崩溃不留堆栈（只剩一句「出事了」，还是查不了）', LOG, (src) =>
  src.replace("const detail = typeof err === 'string' ? err : err.stack || err.message || String(err);", 'const detail = String(err?.message ?? "");'),
);

runner.run('未处理的 Promise 拒绝不留痕（那是最难查的一类）', LOG, (src) =>
  src.replace("  process.on('unhandledRejection', (reason) => handleCrash('unhandledRejection', reason));", ''),
);

runner.run('收到信号也不记（分不清「自己崩了」和「被外部结束」）', LOG, (src) =>
  src.replace("  for (const signal of ['SIGINT', 'SIGTERM']) {", '  for (const signal of []) {'),
);

runner.run('崩到上限也不退出（状态不可信还硬撑，会给出看起来正常的错回答）', LOG, (src) =>
  src.replace('    onFatal(1);', '    void count;'),
);

runner.run('日志文件不再轮转（越长越大）', LOG, (src) =>
  src.replace('  return Number(size) > max;', '  return false;'),
);

runner.run('启动那一行不写（下次不知道它什么时候起过）', LOG, (src) =>
  src.replace('    start(info) {\n      writeLog(startEntry(info));\n    },', '    start(info) {\n      void info;\n    },'),
);

runner.run('日志写失败就抛出去（附件把功能拖垮）', LOG, (src) =>
  src.replace(
    '    } catch {\n      /* 日志是附件，不是功能：写不进去也绝不影响服务本身 */\n    }',
    '    } catch (err) {\n      throw err;\n    }',
  ),
);

runner.run('服务启动时不写启动行（接不上日志这条路）', SERVER, (src) =>
  src.replace(
    "  serverLog.start({ port: PORT, model: API_MODEL, mode: MODE, baseUrl: HAS_MODEL ? API_BASE : '' });",
    '  void serverLog;',
  ),
);

runner.finish();
