// 复制反馈的文案与状态映射
//
// 抽成纯函数的原因：这一小块逻辑（按钮该显示什么字、用什么状态类）是
// 「复制成功看不出来」这个缺陷的修复核心，值得被断言守住。
// 它不碰 DOM，所以能在 Node 里直接测，不必依赖浏览器模拟。

/** 成功 / 失败时按钮上显示的字 */
export const COPY_LABELS = {
  idle: {
    code: '复制代码',
    answer: '复制回答',
    full: '复制全文',
  },
  copied: '已复制',
  failed: '复制失败',
};

/**
 * 复制完成后的反馈状态。
 *
 * @param {boolean} ok 是否复制成功
 * @returns {{label: string, className: string, tone: 'success'|'failure'}}
 */
export function copyFeedbackState(ok) {
  return ok
    ? { label: COPY_LABELS.copied, className: 'is-copied', tone: 'success' }
    : { label: COPY_LABELS.failed, className: 'is-copy-failed', tone: 'failure' };
}

/** 底部提示文字；失败时同时给出补救办法，成功时只报结果 */
export function copyHint(ok, label = '内容') {
  return ok ? `${label}已复制` : '复制失败，请手动选择';
}

/** 反馈持续多久（毫秒）。失败给更长时间，让用户来得及看清并手动复制 */
export function copyFeedbackDuration(ok) {
  return ok ? 1600 : 4000;
}

/** 按钮的初始文案：用于还原时取回原标题 */
export function defaultCopyLabel(kind) {
  return COPY_LABELS.idle[kind] ?? COPY_LABELS.idle.code;
}
