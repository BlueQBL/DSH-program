// 版本（「页」）相关的纯决策逻辑
//
// 抽出来的理由：这几个判断是「编辑后重新回答」功能里最容易错的地方 ——
// 什么时候该新增一页、什么时候原地替换、总共几页、当前该显示哪一页。
// 它们不碰 DOM，所以可以在 Node 里直接测，不必依赖浏览器模拟。
//
// 术语：一条消息可以有多个**版本**，界面上呈现为「第 N 页」。

import { composeUserContent } from './quote.js';
import { coveredCount, summaryBlock } from './compress.js';
import { isValidReference } from './reference.js';

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
 * 压缩过的部分（`options.summary`）换成一条 system 摘要放在最前面，
 * 被它覆盖的那几条就不再逐条发送 —— 这是「压缩」唯一真正起作用的地方：
 * **只改发给模型的那一份**，本地消息一条不动。
 *
 * @param {Array} messages 会话里的消息（提问与回答交替）
 * @param {object} lastUserMessage 末尾那条提问
 * @param {object} [answerMessage] 与它配对的那条助手消息（用来取旧版本的回答）
 * @param {{summary?: object|null, reference?: object|null}} [options]
 *   `summary` 是本会话的压缩摘要；`reference` 是挂着的背景材料（会话引用，见 lib/reference.js）。
 *   两者都只进请求、不进本地消息。
 * @returns {Array<{role: string, content: string, images: string[]}>}
 */
export function buildRequestHistory(messages, lastUserMessage, answerMessage = null, options = {}) {
  const { summary = null, reference = null } = options;
  const history = [];
  const answerVersions = Array.isArray(answerMessage?.versions) ? answerMessage.versions : [];

  // 被压缩覆盖的那几条不再逐条发，改为最前面一条摘要。
  //
  // 两处防守，都是「宁可多发几条也不能发出一个坏请求」：
  //  · 摘要正文为空 = 没有摘要（否则会塞一条空的 system 进去）；
  //  · **绝不允许压掉这一轮要回答的那条提问**。请求必须以 user 消息结尾，
  //    把提问也压进摘要的话服务端会直接 400（手改过的 localStorage 就可能这样）。
  const all = messages ?? [];
  const total = all.length;
  const lastIndex = all.indexOf(lastUserMessage);
  const ceiling = lastIndex >= 0 ? lastIndex : Math.max(0, total - 1);
  const covered = Math.min(coveredCount(all, summary), ceiling);
  const block = summaryBlock(summary);

  // 打头的 system 消息：**背景材料 + 本会话摘要合成一条**。
  //
  // 为什么必须合成一条：服务端只认打头的那一条 system（后面再冒出来的会被丢掉，
  // 见 server.mjs 的 normalizeMessages）。两份分开塞的话，后一份就白写了。
  //
  // 顺序也有讲究：背景材料在最外面，本会话摘要在它后面、紧贴正文 ——
  // 摘要替代的正是正文的开头那一段，贴着正文读才顺。
  const material = isValidReference(reference) ? String(reference.text).trim() : '';
  const summaryPart = covered > 0 ? block : '';
  const prefix = [material, summaryPart].filter(Boolean).join('\n\n');
  if (prefix) {
    history.push({ role: 'system', content: prefix, images: [] });
  }

  for (let index = 0; index < all.length; index += 1) {
    const m = all[index];
    if (index < covered) continue; // 已经进了摘要
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
      // 到这里就**停**：这一问之后的轮次不属于这次要走的这条线。
      //
      // 「改更早的那一页会生成新的一页」意味着会话里那一问之后还挂着**旧那条线**的轮次
      // （我们永远不删消息）。如果把它们也发出去，两个后果都很糟：
      //   · 请求会以一条 assistant 结尾 —— 服务端直接 400「messages 必须以一条 user 消息结尾」；
      //   · 就算服务端收下，模型也会以为那些轮次接在这一问后面，等于把两条线混在一起。
      break;
    }

    const current = versions[versions.length - 1];
    if (!versionHasContent(current)) continue;
    // 图片只跟「末尾那条提问」一起发：历史里重复回传图片既费 token，也更容易被上游拒
    const images = [];
    history.push({ role: m.role, content: outboundContent(m.role, current), images });
  }

  // 最后一道保险：请求**必须**以一条 user 消息结尾（服务端就是这么校验的）。
  // 正常路径上面那个 break 已经保证了这点；万一「末尾那条提问」按引用找不到
  // （调用方传进来的不是 messages 里的那个对象），就会漏到这里 ——
  // 与其把一条坏请求发出去换个看不懂的 400，不如把尾巴上多出来的回答削掉。
  while (history.length > 1 && history[history.length - 1].role !== 'user') history.pop();

  return history;
}
