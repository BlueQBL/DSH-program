// 对回答的评价：点赞 / 拉踩 + 意见反馈
//
// 参考 ChatGPT 的做法，但修掉它两个被用户抱怨很久的地方：
//  1. **点错了能改**。ChatGPT 的踩/赞点下去就改不了（社区里那条「no way to edit or reverse
//     a response once it is clicked」说的就是这个）。这里是**再点一次取消**、点另一边就是改判，
//     每次变化都往服务端追加一条事件，所以日志仍然说实话。
//  2. **点了赞不等于必须填字**。点下去就是一次完整的反馈（这一下的信号本身就有用），
//     下面那个框是「可选补充」：拉踩时给一排常见原因，点赞时只留一个可选的说明框 ——
//     跟 ChatGPT 一样，好评不再多问一层，否则点赞会变成负担。
//
// 数据形状：{ rating: 'up'|'down', reasons: string[], note: string, at: number }
// 这个文件是纯函数，服务端也 import（校验与摘要两边共用一份规则）。

/** 两个评价按钮 */
export const RATINGS = [
  { id: 'up', icon: '👍', label: '有用', title: '这条回答有用' },
  { id: 'down', icon: '👎', label: '没用', title: '这条回答没帮上忙' },
];

/**
 * 拉踩的原因。对应 ChatGPT 那套选项：
 * Not factually correct / Didn't fully follow instructions / Was lazy, didn't give details /
 * Refused when it shouldn't have / Other。
 */
export const DOWN_REASONS = [
  { id: 'wrong', label: '事实有错' },
  { id: 'ignored', label: '没按我的要求来' },
  { id: 'incomplete', label: '该答的没答全' },
  { id: 'refused', label: '不该拒绝却拒绝了' },
  { id: 'verbose', label: '太啰嗦' },
  { id: 'other', label: '其他' },
];

/** 好评不给选项：一个「有用」已经说明了问题，再多问一层只会让人懒得点 */
export const UP_REASONS = [];

export const MAX_NOTE_CHARS = 500;
export const MAX_REASONS = 3;

export const isRating = (value) => value === 'up' || value === 'down';

/** 这个评价是哪一档的按钮信息（找不到就回落到第一档，界面不该因为脏数据白屏） */
export function ratingInfo(rating) {
  return RATINGS.find((r) => r.id === rating) ?? RATINGS[0];
}

/** 这一档可选的原因 */
export function reasonsFor(rating) {
  return rating === 'down' ? DOWN_REASONS : UP_REASONS;
}

/**
 * 规整一条评价。`rating` 不是 up/down 就返回 null（等于「没有评价」）。
 *
 * 只认识得的原因 id：脏数据（手改的 localStorage、别的版本写的字段）一律丢掉，
 * 免得界面上冒出一排没有名字的空标签。
 */
export function normalizeFeedback(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isRating(raw.rating)) return null;

  const known = new Set(reasonsFor(raw.rating).map((r) => r.id));
  const reasons = [];
  for (const item of Array.isArray(raw.reasons) ? raw.reasons : []) {
    if (typeof item !== 'string' || !known.has(item) || reasons.includes(item)) continue;
    reasons.push(item);
    if (reasons.length >= MAX_REASONS) break;
  }

  const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, MAX_NOTE_CHARS) : '';

  return {
    rating: raw.rating,
    reasons,
    note,
    at: Number(raw.at) || Date.now(),
  };
}

/** 再点一次同一个按钮 = 取消；点另一边 = 改判 */
export function toggleRating(current, clicked) {
  if (!isRating(clicked)) return null;
  return current === clicked ? null : clicked;
}

/** 原因是可以多选的，再点一次取消这一项 */
export function toggleReason(list, id) {
  const current = Array.isArray(list) ? list : [];
  if (current.includes(id)) return current.filter((x) => x !== id);
  if (current.length >= MAX_REASONS) return current;
  return [...current, id];
}

/** 「👍 有用」这种短标签 */
export function feedbackLabel(feedback) {
  if (!feedback) return '';
  const info = ratingInfo(feedback.rating);
  return `${info.icon} ${info.label}`;
}

/** 原因的中文标签，例如「事实有错、太啰嗦」 */
export function reasonLabels(feedback) {
  const options = reasonsFor(feedback?.rating);
  return (feedback?.reasons ?? [])
    .map((id) => options.find((r) => r.id === id)?.label)
    .filter(Boolean);
}

/** 一行摘要，给导出与日志用 */
export function feedbackSummary(feedback) {
  if (!feedback) return '';
  const parts = [feedbackLabel(feedback)];
  const reasons = reasonLabels(feedback);
  if (reasons.length) parts.push(reasons.join('、'));
  if (feedback.note) parts.push(`补充：${feedback.note}`);
  return parts.join(' · ');
}

/** 两条评价是不是同一个东西：一样就不必再往服务端发一遍 */
export function sameFeedback(a, b) {
  if (!a || !b) return a === b;
  return (
    a.rating === b.rating &&
    a.note === (b.note ?? '') &&
    a.reasons.length === b.reasons.length &&
    a.reasons.every((r, i) => r === b.reasons[i])
  );
}

/**
 * 发给服务端的那一条。
 *
 * 带上答案开头的一小段：只记「用户点了踩」而不知道踩的是什么，那条日志没有任何用。
 * 截断到 300 字，够定位、又不至于把整篇回答写进去。
 *
 * `action: 'clear'` 是「用户把评价撤回了」——这时没有 rating，
 * 但它**仍然要发出去**：日志是追加写的，只有记下这一次撤回，
 * 读日志的人才能算出「他最后到底是赞还是踩」。（这个分支一开始漏了，
 * 表现是撤回只在本地生效、服务端永远不知道 —— ui-tests 里那条断言抓出来的。）
 */
export function feedbackPayload({
  feedback,
  sessionId = '',
  messageId = '',
  version = 1,
  model = '',
  mode = '',
  question = '',
  answer = '',
  action = 'set',
} = {}) {
  const cut = (text, max) => {
    const one = String(text ?? '').replace(/\s+/g, ' ').trim();
    return one.length <= max ? one : `${one.slice(0, max)}…`;
  };
  const context = {
    sessionId,
    messageId,
    version,
    model: model || null,
    mode: mode || null,
    questionExcerpt: cut(question, 200),
    answerExcerpt: cut(answer, 300),
  };

  if (action === 'clear') {
    return { action: 'clear', rating: null, reasons: [], note: '', ...context };
  }

  if (!feedback) return null;
  return {
    action: 'set',
    rating: feedback.rating,
    reasons: feedback.reasons,
    note: feedback.note,
    ...context,
  };
}
