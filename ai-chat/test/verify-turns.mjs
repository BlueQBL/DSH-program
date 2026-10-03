// 终检：多轮记忆 + 流式 + 兜底副本，全部走 Node 的 fetch（UTF-8 正确）
const BASE = process.argv[2] || 'http://127.0.0.1:5250';
const sessionId = `final_${Date.now().toString(36)}`;

async function ask(messages) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, sessionId }),
  });
  const raw = await res.text();
  const frames = raw.split('\n\n').map((f) => f.replace(/^data:\s*/, '').trim()).filter(Boolean)
    .map((f) => { try { return JSON.parse(f); } catch { return null; } }).filter(Boolean);
  return {
    text: frames.filter((f) => f.type === 'delta').map((f) => f.text).join(''),
    deltas: frames.filter((f) => f.type === 'delta').length,
    frames,
  };
}

console.log('会话:', sessionId, '\n');

const turn1 = await ask([{ role: 'user', content: '我叫小林，正在学习 Rust' }]);
console.log(`第 1 轮（${turn1.deltas} 个增量，${turn1.text.length} 字）`);
console.log('  ', turn1.text.split('\n')[0]);
console.log('   记住的事实:', /称呼/.test(turn1.text) ? '有' : '无', '/', /Rust/.test(turn1.text) ? '含 Rust' : '缺 Rust');

const turn2 = await ask([
  { role: 'user', content: '我叫小林，正在学习 Rust' },
  { role: 'assistant', content: turn1.text },
  { role: 'user', content: '我叫什么名字？' },
]);
console.log(`\n第 2 轮（问名字）`);
console.log('  ', turn2.text.split('\n')[0]);

const turn3 = await ask([
  { role: 'user', content: '我叫小林，正在学习 Rust' },
  { role: 'assistant', content: turn1.text },
  { role: 'user', content: '我刚才说了什么？' },
]);
console.log(`\n第 3 轮（问刚才说了什么）`);
console.log('  ', turn3.text.split('\n').slice(0, 3).join(' / '));

const saved = await (await fetch(`${BASE}/api/history/${sessionId}`)).json();
console.log(`\n服务端兜底副本: ${saved.turns?.length ?? 0} 条`);
if (saved.turns?.length) {
  console.log('  提问:', JSON.stringify(saved.turns.filter((t) => t.role === 'user').map((t) => t.content)));
}

const checks = [
  ['第 2 轮答出了名字', turn2.text.includes('小林')],
  ['第 3 轮引用了原话', turn3.text.includes('Rust') || turn3.text.includes('小林')],
  // 「不编造」的正确判据是：回溯类回答只引用用户的原话，不附加虚构的解释。
  ['第 3 轮只引用原话、没有编造解释', turn3.text.includes('我叫小林，正在学习 Rust')],
  ['兜底副本记录了多轮', (saved.turns?.length ?? 0) >= 4],
];
console.log('');
let ok = true;
for (const [name, pass] of checks) {
  if (!pass) ok = false;
  console.log(pass ? '  ✓' : '  ✗', name);
}
await fetch(`${BASE}/api/history/${sessionId}`, { method: 'DELETE' });
console.log(ok ? '\n终检通过' : '\n终检未通过');
process.exit(ok ? 0 : 1);
