// 线上字节核对：用原始 socket 打一次 /api/chat，直接看服务端到底写出了什么。
//
//   node test/verify-sse.mjs [base]
//
// 存在的理由：undici 的 fetch 会把多个响应块合并成一次 reader.read()，
// 于是「逐字流式」在 fetch 层量不出来。要确认服务端真的在逐段 flush，必须看 TCP 层。

import net from 'node:net';

const BASE = process.argv[2] || process.env.DSH_TEST_BASE || 'http://127.0.0.1:5250';
const url = new URL('/api/chat', BASE);
const payload = JSON.stringify({
  messages: [{ role: 'user', content: process.argv[3] || '闭包是什么' }],
  sessionId: `raw_${Date.now().toString(36)}`,
});

const socket = net.connect(Number(url.port), url.hostname);
const segments = [];
const startedAt = Date.now();

socket.setTimeout(30000, () => {
  console.log('超时终止');
  socket.destroy();
});

socket.on('connect', () => {
  socket.write(
    'POST /api/chat HTTP/1.1\r\n' +
      `Host: ${url.host}\r\n` +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
      'Accept: text/event-stream\r\n' +
      'Connection: close\r\n\r\n' +
      payload,
  );
});

socket.on('data', (chunk) => {
  segments.push({ at: Date.now() - startedAt, bytes: chunk.length, text: chunk.toString('utf8') });
  if (chunk.includes('"type":"done"')) socket.end();
});

socket.on('close', () => {
  const body = segments.map((s) => s.text).join('');
  const frames = [...body.matchAll(/data: (\{.*?\})\r?\n/g)].map((m) => JSON.parse(m[1]));
  const deltas = frames.filter((f) => f.type === 'delta');
  const deltaSegments = segments.filter((s) => s.text.includes('"type":"delta"'));

  console.log(`连接：${BASE}`);
  console.log(`TCP 数据段总数：${segments.length}`);
  console.log(`其中含 delta 的数据段：${deltaSegments.length}`);
  console.log(`解析出的事件：meta ${frames.filter((f) => f.type === 'meta').length} / `
    + `delta ${deltas.length} / done ${frames.filter((f) => f.type === 'done').length}`);

  if (deltaSegments.length > 1) {
    const span = deltaSegments.at(-1).at - deltaSegments[0].at;
    console.log(`首个 delta 段 @${deltaSegments[0].at}ms，末个 @${deltaSegments.at(-1).at}ms，跨越 ${span}ms`);
    const gaps = deltaSegments.slice(1).map((s, i) => s.at - deltaSegments[i].at);
    console.log(`最大段间隔：${Math.max(...gaps)}ms`);
  }

  const text = deltas.map((d) => d.text).join('');
  console.log(`拼接后的回答（${text.length} 字）：`);
  console.log(text.slice(0, 160).replace(/\n/g, '⏎') + (text.length > 160 ? '…' : ''));

  const ok = frames[0]?.type === 'meta' && deltas.length > 10 && frames.at(-1)?.type === 'done';
  console.log(ok ? '\n结论：流式正常（meta → 多个 delta → done）' : '\n结论：流式不正常');
  process.exit(ok ? 0 : 1);
});
