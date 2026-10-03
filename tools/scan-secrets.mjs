// 敏感信息排查扫描器
//
//   node scan-secrets.mjs [根目录]
//
// 设计要点：
//  · 不打印命中的明文，只截前几位 + 长度 —— 排查过程本身不能二次泄露
//  · 覆盖常见的密钥形态（各家 cloud / LLM / 社交 / 支付 / 私钥 / JWT / 连接串）
//  · 同时报告「疑似」和「高危」：占位符要能区分出来，否则报告没法用
//  · 排除依赖与构建产物目录，否则全是噪声

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || '.');
const MAX_BYTES = 2 * 1024 * 1024; // 超大文件跳过（多半是产物）

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'target', 'dist', 'build', 'out', '.m2-repo', '.npm-cache',
  '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'coverage', '.next', '.nuxt',
  '.turbo', '.cache', '.screens', 'vendor',
]);

// 只扫文本类扩展名（以及无扩展名的常见配置文件）
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.json', '.jsonl', '.md', '.markdown',
  '.html', '.htm', '.css', '.scss', '.less', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf',
  '.xml', '.properties', '.env', '.example', '.txt', '.sh', '.bash', '.ps1', '.psm1', '.bat',
  '.cmd', '.py', '.java', '.kt', '.go', '.rs', '.rb', '.php', '.sql', '.gradle', '.gitignore',
  '.gitattributes', '.editorconfig', '.lock', '.hbs', '.ejs', '.pug', '.svelte', '.astro',
]);

/** 已知的密钥形态 */
const RULES = [
  { id: 'openai-style', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, level: 'high', what: 'OpenAI 风格密钥' },
  { id: 'hk-proxy', re: /\bhk-[A-Za-z0-9]{16,}\b/g, level: 'high', what: 'hk 代理密钥' },
  { id: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, level: 'high', what: 'Anthropic 密钥' },
  { id: 'aws-akid', re: /\bAKIA[0-9A-Z]{16}\b/g, level: 'high', what: 'AWS Access Key ID' },
  { id: 'google-api', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, level: 'high', what: 'Google API Key' },
  { id: 'github-pat', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, level: 'high', what: 'GitHub Token' },
  { id: 'gitlab-pat', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, level: 'high', what: 'GitLab Token' },
  { id: 'slack', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, level: 'high', what: 'Slack Token' },
  { id: 'stripe', re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{20,}\b/g, level: 'high', what: 'Stripe 密钥' },
  { id: 'sendgrid', re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, level: 'high', what: 'SendGrid Key' },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, level: 'medium', what: 'JWT / 长 token' },
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, level: 'high', what: '私钥文件内容' },
  { id: 'conn-string', re: /\b(mongodb(\+srv)?|postgres(ql)?|mysql|redis|amqp):\/\/[^\s"'`]*:[^\s"'`@]+@/gi, level: 'high', what: '带密码的连接串' },
  { id: 'alibaba-ak', re: /\bLTAI[0-9A-Za-z]{12,}\b/g, level: 'high', what: '阿里云 AccessKey' },
  { id: 'tencent-ak', re: /\bAKID[0-9A-Za-z]{28,}\b/g, level: 'high', what: '腾讯云 SecretId' },
];

/** 赋值式的密钥：KEY/TOKEN/SECRET/PASSWORD ... = "值" */
const ASSIGN_RULE = {
  id: 'assigned-secret',
  re: /(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|passwd|password|passphrase)\s*[:=]\s*['"`]([^'"`\n]{8,})['"`]/gi,
  level: 'medium',
  what: '疑似写死的凭据赋值',
};

const STRICT = process.argv.includes('--strict');

/**
 * 明显的占位 / 伪造值。
 *
 * 识别得准一点很重要：如果测试用的假 Key 也被报出来，报告全是噪声，
 * 人就学会无视这个工具了 —— 那比没有扫描器更糟。
 * 想一个不漏地看所有东西（包括占位符），用 --strict。
 */
const PLACEHOLDER = new RegExp(
  [
    '^(\\$\\{|\\$env|<|%|\\*+|\\.\\.\\.)?$',
    '(your|my|our|the)[_-]?(api|secret|access|auth|private|client)?[_-]?(key|token|secret|id|password)',
    'xxx+|yyy+|zzz+|\\*{3,}',
    'abc123|changeme|change[_-]?me|replace[_-]?me|fill[_-]?in|insert[_-]?here|redacted',
    'example|placeholder|dummy|sample|fake|mock|stub|fixture',
    'not[_-]?a[_-]?real|not[_-]?real|not[_-]?valid|invalid[_-]?key|no[_-]?key|none|nil|null|undefined',
    'todo|fixme|test[_-]?only|for[_-]?testing|testing[_-]?only',
  ].join('|'),
  'i',
);

function mask(value) {
  const v = String(value);
  if (v.length <= 8) return `${v.slice(0, 2)}***(长度 ${v.length})`;
  return `${v.slice(0, 5)}…${v.slice(-2)}（长度 ${v.length}）`;
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      const noExt = ext === '';
      if (!TEXT_EXT.has(ext) && !noExt) continue;
      const info = await stat(full).catch(() => null);
      if (!info || info.size > MAX_BYTES) continue;
      yield { full, size: info.size };
    }
  }
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

const findings = [];
const scanned = [];

for await (const { full, size } of walk(ROOT)) {
  let text;
  try {
    text = await readFile(full, 'utf8');
  } catch {
    continue;
  }
  // 二进制嗅探：出现 NUL 就跳过
  if (text.includes('\u0000')) continue;
  const rel = path.relative(ROOT, full);
  scanned.push({ rel, size, lines: text.split('\n').length });

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      findings.push({
        level: rule.level,
        what: rule.what,
        file: rel,
        line: lineOf(text, m.index ?? 0),
        sample: mask(m[0]),
      });
    }
  }

  ASSIGN_RULE.re.lastIndex = 0;
  for (const m of text.matchAll(ASSIGN_RULE.re)) {
    const value = m[2];
    if (!STRICT && PLACEHOLDER.test(value)) continue;
    // 值明显是代码引用而非字面量
    if (/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(value) && value.length < 24) continue;
    findings.push({
      level: 'medium',
      what: `${ASSIGN_RULE.what}（字段 ${m[1]}）`,
      file: rel,
      line: lineOf(text, m.index ?? 0),
      sample: mask(value),
    });
  }
}

// ---------------------------------------------------------------- 报告

const byLevel = { high: [], medium: [] };
for (const f of findings) byLevel[f.level]?.push(f);

console.log(`扫描根目录：${ROOT}`);
console.log(`扫描文件数：${scanned.length}（已排除 node_modules / .git / target / dist 等）`);
if (STRICT) console.log('模式：strict（占位符也一并列出）');
console.log('');
console.log(`高危命中：${byLevel.high.length}    疑似命中：${byLevel.medium.length}`);
console.log('');

for (const level of ['high', 'medium']) {
  const list = byLevel[level];
  if (!list.length) continue;
  console.log(`── ${level === 'high' ? '高危' : '疑似'} ──`);
  for (const f of list) {
    console.log(`  [${f.what}] ${f.file}:${f.line}  →  ${f.sample}`);
  }
  console.log('');
}

// 顺带点出容易被误提交的运行时数据目录
const noisy = scanned.filter((s) => /(^|\/)(data|logs?|\.screens|cache)\//.test(s.rel));
if (noisy.length) {
  console.log('── 运行时数据目录（应确认已在 .gitignore 中）──');
  const dirs = [...new Set(noisy.map((n) => n.rel.split('/').slice(0, 2).join('/')))];
  for (const d of dirs) console.log(`  ${d}/  （${noisy.filter((n) => n.rel.startsWith(d)).length} 个文件）`);
  console.log('');
}

if (!findings.length) {
  console.log('结论：没有发现写死的密钥或凭据。');
  process.exit(0);
}
console.log('结论：上述位置需要人工确认。');
process.exit(1);
