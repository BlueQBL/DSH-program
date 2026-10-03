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
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
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
