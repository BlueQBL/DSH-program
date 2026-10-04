// 复现用户报的问题：编辑重发把上一次的内容覆盖了，应该保留
//
// 走的是 app.js 真实的调用顺序与参数，不是简化版。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_LIB = path.resolve(HERE, '../public/lib');

// ---- 环境替身
const backing = new Map();
globalThis.localStorage = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear(),
};
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
globalThis.document = { addEventListener() {}, visibilityState: 'visible' };
globalThis.window = { addEventListener() {} };

async function loadModule(file) {
  let source = readFileSync(path.join(PUBLIC_LIB, file), 'utf8');
  source = source.replace(/from\s+'\.\/([\w.-]+)'/g, (_m, dep) => {
    const abs = path.join(PUBLIC_LIB, dep).replace(/\\/g, '/');
    return `from 'file:///${abs}'`;
  });
  return import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`);
}

const { createStore } = await loadModule('store.js');
const { resolveShownPage, editOutcome } = await loadModule('versions.js');

const store = createStore();

console.log('复现路径：发第一版 → 得到回答 → 编辑 → 重新回答\n');

// ① 用户发第一条消息（app.js: send() 里 pushUser 不带 edit）
const first = store.pushUser('第一版问题');
const q = first.message;
console.log(`① 发送后：versions=${q.versions.length}  内容=${JSON.stringify(q.versions.map((v) => v.content))}`);

// ② 回答落在第 1 版
const a = store.pushAssistant({ question: q, version: 1 }).message;
store.appendDelta(a, '第一版回答');
store.finish(a, 'done');
console.log(`② 回答后：回答 versions=${a.versions.length}  内容=${JSON.stringify(a.versions.map((v) => v.content))}`);

// ③ 用户点「编辑」。app.js 的 edit 处理：
//    shown = store.viewVersion(question)  → 只有一版时是 1
const shownBefore = store.viewVersion(q);
console.log(`③ 点编辑时：显示的页 = ${shownBefore}，共 ${q.versions.length} 页`);

// ④ 用户改文字后点「重新回答」。app.js:
//    resendEdited(question, shown, newText) → send(text, { edit: question, version: shown })
const editedText = '第二版问题（改过的）';
console.log(`   编辑框里输入：${JSON.stringify(editedText)}`);

const outcome = editOutcome(shownBefore, q.versions.length);
console.log(`   预期后果（editOutcome）：${outcome}`);

// 模拟 app.js 的 resendEdited → send(text, {edit, version})
const second = store.pushUser(editedText, { edit: q, version: shownBefore });
const q2 = second.message;

console.log(`④ 重发后：versions=${q2.versions.length}  内容=${JSON.stringify(q2.versions.map((v) => v.content))}`);
console.log(`   replaced=${second.replaced}  version=${second.version}`);

// ⑤ 新回答
const a2 = store.pushAssistant({ question: q2, version: second.version }).message;
store.appendDelta(a2, '第二版回答');
store.finish(a2, 'done');
console.log(`⑤ 新回答后：回答 versions=${a2.versions.length}  内容=${JSON.stringify(a2.versions.map((v) => v.content))}`);

console.log('\n--- 判定 ---');
const problems = [];
if (q2.versions.length !== 2) problems.push(`提问应该有 2 版，实际 ${q2.versions.length}`);
if (q2.versions[0]?.content !== '第一版问题') problems.push(`第 1 版被覆盖了：${JSON.stringify(q2.versions[0]?.content)}`);
if (q2.versions[1]?.content !== editedText) problems.push(`第 2 版内容不对：${JSON.stringify(q2.versions[1]?.content)}`);
if (a2.versions.length !== 2) problems.push(`回答应该有 2 版，实际 ${a2.versions.length}`);
if (a2.versions[0]?.content !== '第一版回答') problems.push(`第 1 版回答被覆盖了：${JSON.stringify(a2.versions[0]?.content)}`);
if (a2.versions[1]?.content !== '第二版回答') problems.push(`第 2 版回答不对：${JSON.stringify(a2.versions[1]?.content)}`);

if (problems.length) {
  console.log('✗ 复现成功 —— 确实有问题：');
  for (const p of problems) console.log(`   · ${p}`);
} else {
  console.log('✓ 存储层行为正确：两版都在，旧版没被覆盖');
  console.log(`   页码：第 1 页 = 「第一版问题 / 第一版回答」`);
  console.log(`         第 2 页 = 「${editedText} / 第二版回答」`);
}
process.exit(problems.length ? 1 : 0);
