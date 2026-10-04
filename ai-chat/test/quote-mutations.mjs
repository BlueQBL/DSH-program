// 引用回答的变异测试：确认那批断言真的抓得住缺陷
//
//   node test/quote-mutations.mjs
//
// 骨架在 test/mutation-harness.mjs（快照、还原、崩溃判定、收尾都在那边）。

import { createMutationRunner } from './mutation-harness.mjs';

const QUOTE = 'public/lib/quote.js';
const STORE = 'public/lib/store.js';
const VERSIONS = 'public/lib/versions.js';
const EXPORTERS = 'public/lib/exporters.js';

const runner = createMutationRunner({
  label: '引用回答',
  suite: 'test/quote-tests.mjs',
  files: [QUOTE, STORE, VERSIONS, EXPORTERS],
});

// ---- 拼装：引用必须真的进请求体，且不能把用户的话弄丢

runner.run('引用不拼进请求体（等于功能没做）', VERSIONS, (src) =>
  src.replace("  if (role !== 'user') return versionText(version);", '  return versionText(version);'),
);

runner.run('引用只拼给最后一轮，历史里的引用被丢掉', VERSIONS, (src) =>
  src.replace(
    '    history.push({ role: m.role, content: outboundContent(m.role, current), images });',
    '    history.push({ role: m.role, content: versionText(current), images });',
  ),
);

runner.run('拼装时把用户自己说的话丢了', QUOTE, (src) =>
  src.replace("  const question = typeof text === 'string' ? text : '';", "  const question = '';"),
);

runner.run('引用块不用 Markdown 引用符（模型分不清是转引还是用户在说话）', QUOTE, (src) =>
  src.replace("    .map((line) => (line ? `> ${line}` : '>'))", '    .map((line) => line)'),
);

runner.run('引用不带出处（多页时不知道引的是哪一页）', QUOTE, (src) =>
  src.replace('  return `> 【${quoteLabel(quote)}】\\n${body}`;', '  return body;'),
);

// ---- 规整：空白与超长是真实选区里最常见的两种脏数据

runner.run('空白选区也算引用（会挂上一条空的引用条）', QUOTE, (src) =>
  src.replace('  if (!full) return null;', '  if (false) return null;'),
);

runner.run('不截断超长引用（上下文会被一段长回答翻倍）', QUOTE, (src) =>
  src.replace(
    '  const text = full.length > MAX_QUOTE_CHARS ? full.slice(0, MAX_QUOTE_CHARS).trimEnd() : full;',
    '  const text = full;',
  ),
);

runner.run('引用自己的提问也允许（「引用」的语义就散了）', QUOTE, (src) =>
  src.replace('  if (!inAnswer) return null;', '  if (false) return null;'),
);

// ---- 存储：引用要跟着版本走，不能串页

runner.run('新提问沿用上一条的引用（引用会串到下一轮）', STORE, (src) =>
  src.replace('            quote: cleanQuote,', '            quote: null ?? session.messages.at(-1)?.quote ?? null,'),
);

runner.run('编辑重发时不继承引用（新一页会把引用弄丢）', STORE, (src) =>
  src.replace('          quote: edit.versions[target - 1]?.quote ?? null,', '          quote: null,'),
);

runner.run('存储时不规整引用（脏数据会被原样落盘）', STORE, (src) =>
  src.replace('      const cleanQuote = normalizeQuote(quote);', '      const cleanQuote = quote ?? null;'),
);

// ---- 导出：引用丢了，「这句话在问什么」就读不出来

runner.run('Markdown 导出丢掉引用', EXPORTERS, (src) =>
  src.replace('        lines.push(...quoteLines(msg.quote));', '        lines.push(...[]);'),
);

runner.run('JSON 导出把引用混进 content（导入方再也分不开）', EXPORTERS, (src) =>
  src.replace(
    '          content: m.content,\n          // 引用单独一个字段',
    '          content: [m.quote?.text, m.content].filter(Boolean).join("\\n"),\n          // 引用单独一个字段',
  ),
);

runner.finish();
