// 导出对话记录
//
// 三种格式各有用途，不是重复功能：
//   Markdown —— 拿去读、贴进笔记
//   JSON     —— 留着以后导入、做数据处理
//   纯文本   —— 贴进任何地方都不会带格式噪声
//
// 图片只导出文件名与尺寸：base64 写进导出文件会让它大到没法用。
// 引用（用户划中回答里的一段接着问）在三种格式里都保留 ——
// 少了它，「这句话在问什么」就读不出来了。
// 评价（赞/踩 + 补充说明）同理：它是对这一轮回答的判断，也是这份记录的一部分。

import { hasQuote, quoteLabel } from './quote.js';
import { feedbackSummary } from './feedback.js';

const pad = (n) => String(n).padStart(2, '0');

export function formatStamp(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fileStamp(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** 附件在文字导出里的表示 */
function attachmentNote(attachments) {
  if (!attachments?.length) return '';
  return attachments
    .map((a) => `[图片：${a.name}${a.width ? ` ${a.width}×${a.height}` : ''}]`)
    .join(' ');
}

/** 引用在文字导出里的表示：一行出处 + 引用块 */
function quoteLines(quote) {
  if (!hasQuote(quote)) return [];
  const body = quote.text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
  return [`> 【${quoteLabel(quote)}】`, body, ''];
}

/** 导出为 Markdown */
export function toMarkdown(session, { exportAll = false, sessions = [] } = {}) {
  const list = exportAll ? sessions : [session];
  const lines = [];

  lines.push(`# ${exportAll ? '对谈录 · 全部对话' : session.title || '对谈录'}`);
  lines.push('');
  lines.push(`导出时间：${formatStamp(Date.now())}`);
  if (!exportAll) {
    lines.push(`创建时间：${formatStamp(session.createdAt)}`);
    if (session.personaName) lines.push(`角色：${session.personaName}`);
  }
  lines.push(`会话数：${list.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const item of list) {
    if (exportAll) {
      lines.push(`## ${item.title || '未命名对话'}`, '');
      lines.push(`创建于 ${formatStamp(item.createdAt)}${item.personaName ? ` · ${item.personaName}` : ''}`, '');
    }

    let turn = 0;
    for (const msg of item.messages ?? []) {
      const note = attachmentNote(msg.attachments);
      if (msg.role === 'user') {
        turn += 1;
        lines.push(`### ${String(turn).padStart(2, '0')} · 问`, '');
        lines.push(`*${formatStamp(msg.createdAt)}*`, '');
        lines.push(...quoteLines(msg.quote));
        if (msg.content) lines.push(msg.content, '');
        if (note) lines.push(`> ${note}`, '');
      } else {
        lines.push('**答**', '');
        if (msg.content) lines.push(msg.content, '');
        if (msg.status === 'interrupted') lines.push('> （这条回答被中断了，以上是已写出的部分）', '');
        if (msg.error) lines.push(`> 出错：${msg.error}`, '');
        // 用户的评价：导出的记录里也该看得出「这一条我当时满不满意」
        const verdict = feedbackSummary(msg.feedback);
        if (verdict) lines.push(`> 评价：${verdict}`, '');
        lines.push('');
      }
    }
    if (exportAll) lines.push('---', '');
  }

  return lines.join('\n');
}

/** 导出为纯文本 */
export function toPlainText(session) {
  const lines = [`${session.title || '对谈录'}`, `导出时间：${formatStamp(Date.now())}`, ''];
  let turn = 0;
  for (const msg of session.messages ?? []) {
    const note = attachmentNote(msg.attachments);
    if (msg.role === 'user') {
      turn += 1;
      const quoted = hasQuote(msg.quote)
        ? `（${quoteLabel(msg.quote)}：${msg.quote.text.replace(/\s+/g, ' ')}）`
        : '';
      lines.push(`【问 ${turn}】${quoted}${msg.content || ''}${note ? ` ${note}` : ''}`);
    } else {
      lines.push(`【答】${msg.content || ''}`);
      if (msg.error) lines.push(`（出错：${msg.error}）`);
      const verdict = feedbackSummary(msg.feedback);
      if (verdict) lines.push(`（评价：${verdict}）`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 导出为 JSON。
 *
 * 带上 schemaVersion 和导出元信息 —— 以后想写导入功能时，没有版本号的
 * JSON 只能靠猜结构。
 */
export function toJson(session, { exportAll = false, sessions = [] } = {}) {
  const list = exportAll ? sessions : [session];
  return JSON.stringify(
    {
      schema: 'duitanlu.export',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      count: list.length,
      sessions: list.map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: new Date(s.createdAt).toISOString(),
        updatedAt: new Date(s.updatedAt).toISOString(),
        personaId: s.personaId ?? null,
        personaName: s.personaName ?? null,
        systemPrompt: s.systemPrompt || '',
        model: s.model || '',
        messages: (s.messages ?? []).map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          // 引用单独一个字段：导入方要的是「用户说了什么」和「他引用了哪一段」两件事，
          // 拼进 content 就再也分不开了
          quote: hasQuote(m.quote)
            ? { text: m.quote.text, page: m.quote.page ?? 1, truncated: Boolean(m.quote.truncated) }
            : null,
          // 评价也一样单独一个字段：导入方要能把「回答」和「对回答的判断」分开
          feedback: m.feedback
            ? {
                rating: m.feedback.rating,
                reasons: [...(m.feedback.reasons ?? [])],
                note: m.feedback.note ?? '',
                at: new Date(m.feedback.at ?? Date.now()).toISOString(),
              }
            : null,
          createdAt: new Date(m.createdAt).toISOString(),
          status: m.status,
          error: m.error ?? null,
          model: m.model ?? null,
          attachments: (m.attachments ?? []).map((a) => ({
            name: a.name,
            mime: a.mime,
            width: a.width,
            height: a.height,
            // 刻意不导 base64：文件会大到没法用
          })),
        })),
      })),
    },
    null,
    2,
  );
}

/** 触发浏览器下载 */
export function download(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function suggestedFilename(title, ext, ts = Date.now()) {
  const safe = String(title || '对谈录')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || '对谈录';
  return `${safe}-${fileStamp(ts)}.${ext}`;
}
