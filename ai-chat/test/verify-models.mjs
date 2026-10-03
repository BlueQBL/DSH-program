// 验证模型选择框的端到端行为
const BASE = process.argv[2] || 'http://127.0.0.1:5270';

async function ask(model, question = '只回三个字：收到了') {
  const started = Date.now();
  const body = {
    messages: [{ role: 'user', content: question }],
    sessionId: `pick_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
  };
  if (model !== undefined) body.model = model;

  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const rd = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let meta = null;
  let modelFrame = null;
  let error = null;
  let done = null;
  for (;;) {
    const { value, done: finished } = await rd.read();
    if (finished) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const p of parts)
      for (const line of p.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        let ev;
        try {
          ev = JSON.parse(raw);
        } catch {
          continue;
        }
        if (ev.type === 'meta') meta = ev;
        if (ev.type === 'model') modelFrame = ev;
        if (ev.type === 'error') error = ev.message;
        if (ev.type === 'delta') text += ev.text;
        if (ev.type === 'done') done = ev;
      }
  }
  return { text: text.trim(), meta, modelFrame, error, done, ms: Date.now() - started };
}

const results = [];

// 1. 不带 model：应使用服务端默认
{
  const r = await ask(undefined);
  console.log(`① 不指定模型          → 默认 ${r.meta?.model}  实际 ${r.modelFrame?.model ?? '(未换)'}  ${r.ms}ms`);
  console.log(`   回答: ${JSON.stringify(r.text.slice(0, 40))}${r.error ? `  错误: ${r.error}` : ''}`);
  results.push(['默认模型生效', r.meta?.model === 'deepseek-v4.1-flash' || Boolean(r.modelFrame?.model), r.meta?.model]);
  results.push(['确实产出了内容', r.text.length > 0, `${r.text.length} 字`]);
}

// 2. 指定另一个模型：必须**真的**用这一个，不许偷偷换
{
  const r = await ask('deepseek-v4-flash');
  const actuallyUsed = r.modelFrame?.model ?? r.meta?.model;
  console.log(`\n② 指定 deepseek-v4-flash → meta.requestedModel=${r.meta?.requestedModel}  实际 ${actuallyUsed}  ${r.ms}ms`);
  console.log(`   回答: ${JSON.stringify(r.text.slice(0, 40))}${r.error ? `  错误: ${r.error}` : ''}`);
  results.push(['请求里的模型被服务端采纳', r.meta?.requestedModel === 'deepseek-v4-flash', r.meta?.requestedModel]);
  // 这条断言早先写得太松（!r.modelFrame || ...），把「悄悄换模型」的 bug 放过去了。
  // 现在钉死：用户选的模型，要么就是它，要么明确报错，不许出现第三个模型。
  results.push(
    ['用户指定的模型就是实际用的那个（不许静默替换）',
      actuallyUsed === 'deepseek-v4-flash',
      `实际用了 ${actuallyUsed}`],
  );
  results.push(['没有发生模型替换事件', !r.modelFrame?.switchedFrom, JSON.stringify(r.modelFrame)]);
}

// 3. 指定一个不存在的模型：应报错并把原因说清楚
{
  const r = await ask('definitely-not-a-real-model-xyz');
  console.log(`\n③ 指定不存在的模型      → ${r.error ? `错误: ${r.error.slice(0, 90)}` : `居然成功了: ${r.text.slice(0, 30)}`}`);
  results.push(['不存在的模型报错且说明可操作', Boolean(r.error) && /模型|模型选择框|不存在|无可用渠道/.test(r.error), r.error?.slice(0, 60)]);
  results.push(['失败时 done.reason 是 error', r.done?.reason === 'error', r.done?.reason]);
}

// 4. 换回默认：应恢复
{
  const r = await ask('deepseek-v4.1-flash');
  console.log(`\n④ 换回 deepseek-v4.1-flash → 实际 ${r.modelFrame?.model ?? r.meta?.model}  ${r.ms}ms${r.error ? `  错误: ${r.error.slice(0, 60)}` : ''}`);
  results.push(['换回后正常出内容', r.text.length > 0, `${r.text.length} 字`]);
}

console.log('');
let ok = true;
for (const [name, pass, detail] of results) {
  if (!pass) ok = false;
  console.log(pass ? '  ✓' : '  ✗', name, pass ? '' : `—— ${JSON.stringify(detail)}`);
}
console.log(ok ? '\n模型选择功能正常' : '\n有未通过项');
process.exit(ok ? 0 : 1);
