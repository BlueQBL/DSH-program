// 少量 HTTP 工具：JSON 响应、请求体读取、SSE 通道。
// 单独成文件是为了让 server.mjs 的路由部分保持可读。

export function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function readJsonBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflow = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // 超限**不**立刻砍连接：把后面来的数据丢进垃圾桶、让请求读完，
        // 这样那句 413 才真的发得出去（以前是 req.destroy()，客户端只看到连接被重置，
        // 读不到任何解释 —— 「笔记本太大存不进去」就变成了一句没有原因的失败）。
        // 但也不能无限收：超过 4 倍上限就当是有人在灌数据，直接砍掉。
        overflow = true;
        chunks.length = 0;
        if (size > limit * 4) req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) {
        reject(Object.assign(new Error(`请求体过大（上限 ${Math.round(limit / 1024)}KB）`), { status: 413 }));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 打开一条 SSE 通道。返回的 send() 会在连接已关闭时静默失败，
 * 这样上层循环不必到处判断 res.writableEnded。
 */
export function openEventStream(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;
  return {
    get closed() {
      return closed;
    },
    send(type, payload = {}) {
      if (closed || res.writableEnded) return false;
      res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
      return true;
    },
    end() {
      if (closed) return;
      closed = true;
      if (!res.writableEnded) res.end();
    },
  };
}

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });

export const isAbort = (err) => err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
