// 版本（「页」）相关的纯决策逻辑
//
// 抽出来的理由：这几个判断是「编辑后重新回答」功能里最容易错的地方 ——
// 什么时候该新增一页、什么时候原地替换、总共几页、当前该显示哪一页。
// 它们不碰 DOM，所以可以在 Node 里直接测，不必依赖浏览器模拟。
//
// 术语：一条消息可以有多个**版本**，界面上呈现为「第 N 页」。

import { composeUserContent } from './quote.js';

/**
 * 该显示第几页。
 *
 * 提问决定页数（因为「页」是按提问的版本切的），回答跟着显示同一页。
 *
 * @param {{versions: unknown[]}} question
 * @param {number} want 用户点选的页码（1 起），不合法时回落到最后一页
 */
export function resolveShownPage(question, want) {
  const total = Array.isArray(question?.versions) ? question.versions.length : 1;
  const n = Number(want);
  if (!Number.isFinite(n) || n < 1) return total;
  return Math.min(Math.floor(n), total);
}

/** 总页数：取提问与回答里更大的那个，避免出现「有页但没内容可显示」 */
export function totalPages(question, answer) {
  const q = Array.isArray(question?.versions) ? question.versions.length : 1;
  const a = Array.isArray(answer?.versions) ? answer.versions.length : 1;
  return Math.max(1, q, a);
}

/**
 * 生成页码按钮的数据。
 * 只有一页时返回空数组 —— 界面据此把整条版本栏隐藏掉，不给用户制造噪音。
 */
export function versionBarItems(count, shown) {
  const total = Math.max(1, Number(count) || 1);
  if (total <= 1) return [];
  const current = Math.max(1, Math.min(Number(shown) || total, total));
  return Array.from({ length: total }, (_, i) => ({
    page: i + 1,
    label: String(i + 1),
    title: `查看第 ${i + 1} 页`,
    active: i + 1 === current,
  }));
}

/**
 * 编辑后重新发送会产生什么后果。
 *
 * **永远是追加新页，绝不覆盖。**
 *
 * 这里我走过一个弯路，记下来免得再犯：最初按「改的是最新一页就原地覆盖」实现，
 * 理由是「用户就是在改当前这一页，没必要多出一页」。但实测被指出这是错的 ——
 * 「编辑后重新回答」这个动作的**全部意义**就在于保留旧版本、能对比着看。
 * 覆盖之后旧内容就找不回来了，功能等于没做。
 *
 * 所以语义现在很明确：
 *   · 每次「编辑 → 重新回答」都新增一页，旧页原样保留
 *   · 想要「同一个问题再答一遍、不新增页」，用「重新生成」那个按钮
 *
 * @returns {'append'} 恒为 'append'；保留返回值形态是为了让调用方读起来仍能表达意图
 */
export function editOutcome() {
  return 'append';
}

/** 版本栏的说明文字 */
export function versionLabel(shown, count) {
  const total = Math.max(1, Number(count) || 1);
  const current = Math.max(1, Math.min(Number(shown) || total, total));
  return total <= 1 ? '' : `第 ${current} / ${total} 页`;
}

/**
 * 发送前给用户的提示：让用户知道这一按会发生什么。
 * 什么都没变时返回空串。
 */
export function editHint(outcome, shown, count) {
  if (outcome === 'append') {
    return `将生成第 ${Math.max(1, Number(count) || 1) + 1} 页，当前这一页会保留`;
  }
  // replace 分支已不再产生（编辑一律追加），保留兜底以防别处误用
  if (outcome === 'replace') return `将覆盖第 ${shown} 页的回答`;
  return '';
}

function versionText(v) {
  return typeof v?.content === 'string' ? v.content : '';
}

function versionImages(v) {
  return (v?.attachments ?? []).map((a) => a.dataUrl).filter(Boolean);
}

/** 这一版有没有东西可发（文字 / 图片 / 引用） */
function versionHasContent(v) {
  return Boolean(versionText(v)) || versionImages(v).length > 0 || Boolean(v?.quote?.text);
}

/**
 * 这一版发给上游时的正文。
 *
 * 用户消息要把引用拼进去（见 lib/quote.js）；助手回答原样发 ——
 * 引用只可能是用户引了回答里的一段，反过来没有意义。
 */
function outboundContent(role, version) {
  if (role !== 'user') return versionText(version);
  return composeUserContent(versionText(version), version.quote);
}

/**
 * 构造发给服务端的对话历史。
 *
 * 规则：
 *  · 除「末尾那条提问」外，每条消息只取它最新的一版；
 *  · 末尾那条提问要**额外补上它的历史版本**，每版后面跟上它当时得到的回答。
 *
 * 为什么要带历史版本：编辑一版等于在原对话上追加一次修正。
 * 只发新文本会让模型看到「我问了 A，它答了 B，然后我又问 B」这种自问自答；
 * 带上旧版本，上下文才自洽 —— 这是这个功能能不能用好的关键。
 *
 * 引用也是在这里拼进正文的（`composeUserContent`）：库里存的 content 是用户
 * 自己打的那句话，只有发给模型的这一份带上被引用的原文 ——
 * 界面、导出看到的都是原话，而模型知道自己被引的是哪一段。
 *
 * @param {Array} messages 会话里的消息（提问与回答交替）
 * @param {object} lastUserMessage 末尾那条提问
 * @param {object} [answerMessage] 与它配对的那条助手消息（用来取旧版本的回答）
 * @returns {Array<{role: string, content: string, images: string[]}>}
 */
export function buildRequestHistory(messages, lastUserMessage, answerMessage = null) {
  const history = [];
  const answerVersions = Array.isArray(answerMessage?.versions) ? answerMessage.versions : [];

  for (const m of messages ?? []) {
    const versions = Array.isArray(m?.versions) ? m.versions : [];
    if (!versions.length) continue;

    if (m === lastUserMessage) {
      // 历史版本（不含最新那版），每版后面跟上它对应的旧回答
      for (let i = 0; i < versions.length - 1; i += 1) {
        const v = versions[i];
        if (versionHasContent(v)) {
          history.push({
            role: 'user',
            content: outboundContent('user', v),
            images: versionImages(v),
          });
        }
        const oldAnswer = answerVersions[i];
        if (oldAnswer && versionText(oldAnswer)) {
          history.push({ role: 'assistant', content: versionText(oldAnswer), images: [] });
        }
      }
      const latest = versions[versions.length - 1];
      history.push({
        role: 'user',
        content: outboundContent('user', latest),
        images: versionImages(latest),
      });
      continue;
    }

    const current = versions[versions.length - 1];
    if (!versionHasContent(current)) continue;
    // 图片只跟「末尾那条提问」一起发：历史里重复回传图片既费 token，也更容易被上游拒
    const images = [];
    history.push({ role: m.role, content: outboundContent(m.role, current), images });
  }

  return history;
}
