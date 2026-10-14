/*! 三易 · 智能写作台 —— 离线写作引擎（mock-writer.js）
 *
 * 没配大模型 Key 时，服务端把同一个请求转到这儿：模式、角度、语气、篇幅都不变，
 * 用纯规则 + 素材特征拼出一篇能直接用的中文稿，保证演示时六个模式都有像样的产出。
 *
 * 三条设计原则（决定了代码为什么长这样）：
 *   1. 句子不是空模板——关键词、数字、原句的语气都会从素材里抽出来织进产出，
 *      同一个素材换角度换的是切入点和段落动线，不是同篇里改几个词；
 *   2. 所有随机都走 seededRandom，种子由 mode + 素材 + 版本号派生，
 *      同参数同稿——演示可复现，测试也能断言；
 *   3. 只做有把握的修改（校对）和写得住的句子（生成），宁可少，不产出像机器翻译的中文。
 *
 * 纯函数、零依赖：浏览器挂 window.WriterMock，Node 走 module.exports。
 */
(function (root, factory) {
  const api = factory(
    typeof module === 'object' && module.exports ? require('./modes.js') : root.WriterModes
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WriterMock = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Modes) {
  'use strict';

  /* ══════════════════════════════════════════════════════════
   * 一、随机：确定性是硬要求
   * ══════════════════════════════════════════════════════════ */

  /** FNV-1a：种子必须稳定，不能借引擎自带的哈希（各浏览器结果未必一致） */
  function hashText(text) {
    const str = String(text == null ? '' : text);
    let h = 2166136261;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** mulberry32：几十行以外的随机数发生器没必要，这个够小够均匀 */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function random() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 种子可以是字符串或数字，同一颗种子永远给出同一条随机序列 */
  function seededRandom(seed) {
    if (typeof seed === 'number' && Number.isFinite(seed)) {
      return mulberry32(Math.floor(Math.abs(seed)) >>> 0);
    }
    return mulberry32(hashText(seed));
  }

  function pick(rnd, list) {
    if (!list || !list.length) return null;
    return list[Math.floor(rnd() * list.length) % list.length];
  }

  function shuffle(rnd, list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      const t = out[i];
      out[i] = out[j];
      out[j] = t;
    }
    return out;
  }

  /* ══════════════════════════════════════════════════════════
   * 二、文本工具
   * ══════════════════════════════════════════════════════════ */

  const HARD_END = '。！？!?；;…';
  const CLOSERS = '」』”"\'）)】]》';

  function plain(text) {
    return String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  }

  function squash(text) {
    return plain(text).replace(/[ \t\u3000]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  }

  /** 分句：中文标点是可靠的边界，换行也算一句，句末的引号跟着上一句走 */
  function splitSentences(text) {
    const src = plain(text);
    if (!src.trim()) return [];
    const out = [];
    let buf = '';
    const flush = () => {
      const s = buf.replace(/^[\s　]+|[\s　]+$/g, '');
      if (s) out.push(s);
      buf = '';
    };
    for (let i = 0; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '\n') {
        flush();
        continue;
      }
      buf += ch;
      if (HARD_END.indexOf(ch) >= 0) {
        let j = i + 1;
        while (j < src.length && CLOSERS.indexOf(src[j]) >= 0) {
          buf += src[j];
          j += 1;
        }
        i = j - 1;
        flush();
      }
    }
    flush();
    return out;
  }

  /** 篇幅按"非空白字符"算：与界面上显示的"约 X 字"对得上 */
  function charCount(text) {
    return plain(text).replace(/\s+/g, '').length;
  }

  function clip(text, n) {
    const s = squash(text);
    if (s.length <= n) return s;
    return s.slice(0, n);
  }

  /** 截到 n 字以内，尽量不把词切两半（优先停在标点上） */
  function clipSoft(text, n) {
    const s = squash(text);
    if (s.length <= n) return s;
    const head = s.slice(0, n);
    let cut = -1;
    for (let i = head.length - 1; i >= Math.floor(n * 0.5); i -= 1) {
      if ('。！？，、；：,;:'.indexOf(head[i]) >= 0) {
        cut = i;
        break;
      }
    }
    return cut > 0 ? head.slice(0, cut + 1) : head;
  }

  function mentions(text, words) {
    return (words || []).some((w) => text.indexOf(w) >= 0);
  }

  /* ══════════════════════════════════════════════════════════
   * 三、素材分析：关键词 / 数字 / 语气 / 体裁
   * ══════════════════════════════════════════════════════════ */

  /* 小词典：中文没有空格，靠 n-gram 抽出来的"关键词"经常是半截词，
     所以先用一份常用词表做最长匹配，匹配不到的再用 n-gram 兜底。 */
  const DICT_WORDS = (
    '供应商|客户|用户|读者|粉丝|同事|团队|公司|部门|领导|老板|甲方|乙方|上游|下游|渠道|品牌|市场|行业|趋势|机会|风险|挑战|困难|' +
    '合同|订单|报价|预算|费用|成本|利润|收入|业绩|指标|数据|转化|流量|曝光|点击|留存|活跃|增长|运营|推广|发布|上线|迭代|版本|功能|需求|' +
    '方案|计划|目标|结果|效果|效率|质量|标准|规范|流程|环节|步骤|阶段|节点|期限|进度|排期|工期|货期|交付|验收|返工|复盘|总结|报告|纪要|' +
    '会议|周会|例会|汇报|沟通|反馈|协作|分工|责任|安排|调整|优化|提升|提高|降低|减少|增加|解决|处理|应对|评估|测试|验证|检查|审核|审批|' +
    '内容|素材|文案|标题|正文|结构|逻辑|细节|思路|框架|大纲|初稿|定稿|修改|润色|表达|语气|风格|节奏|主题|观点|结论|依据|建议|措施|案例|' +
    '场景|痛点|卖点|优势|价值|体验|服务|产品|课程|学员|老师|学生|作业|练习|讲义|考试|成绩|方法|技巧|经验|习惯|状态|情绪|心态|关系|信任|' +
    '故事|经历|过程|选择|决定|判断|认识|理解|思考|想法|感受|希望|担心|焦虑|压力|家庭|生活|工作|健康|睡眠|运动|饮食|孩子|父母|朋友|' +
    '城市|学校|医院|机场|车站|办公室|会议室|家里|路上|早上|晚上|周末|假期|春节|年初|年底|月底|月初|下周|本周|上周|明天|后天|昨天|今天|' +
    '目前|现在|未来|过去|以后|之前|之后|期间|同时|另外|此外|因此|但是|不过|然而|如果|只要|只有|无论|虽然|即使|已经|正在|将要|必须|' +
    '应该|需要|可以|能够|避免|确保|落实|推进|协调|确认|回复|通知|说明|解释|承诺|保证|支持|配合|协助|负责|承担|参与|组织|推动|梳理|' +
    '拆解|对齐|闭环|沉淀|复用|开始|结束|完成|达成|实现|负责|电话|邮件|附件|时间|地点|人员|原因|影响|变化|重点|关键|基础|前提|条件|资源|能力|水平|' +
    '文档|句子|段落|开头|结尾|文字|写作|第一句|主题|观点|取舍|标准|判断|标准|习惯|节奏'
  ).split('|');

  const DICT = (function () {
    const set = Object.create(null);
    DICT_WORDS.forEach((w) => {
      if (w && w.length >= 2) set[w] = true;
    });
    return set;
  })();

  const BANNED_ANY = '的了是在和与或而吗呢吧啊呀嗯我你他她它们么';
  const BOUNDARY_FUNC = '就都还又只把被这那有不很太更最之其着过要会能可对从到向给让使得地上里外个一二三四五六七八九十';
  const FILLER_GRAMS = {
    一个: 1, 这个: 1, 那个: 1, 什么: 1, 怎么: 1, 这样: 1, 那样: 1, 这些: 1, 那些: 1,
    一下: 1, 一直: 1, 还有: 1, 而且: 1, 但是: 1, 因为: 1, 所以: 1, 如果: 1, 只是: 1,
    就是: 1, 不是: 1, 没有: 1, 比较: 1, 非常: 1, 可能: 1, 应该: 1, 进行: 1, 作为: 1,
    关于: 1, 对于: 1, 通过: 1, 根据: 1, 由于: 1, 以及: 1, 同时: 1, 然后: 1, 接着: 1,
    一些: 1, 很多: 1, 各种: 1, 我们: 1, 你们: 1, 他们: 1, 大家: 1, 东西: 1, 时候: 1,
  };

  function usableGram(gram) {
    if (FILLER_GRAMS[gram]) return false;
    if (BOUNDARY_FUNC.indexOf(gram[0]) >= 0) return false;
    if (BOUNDARY_FUNC.indexOf(gram[gram.length - 1]) >= 0) return false;
    for (let i = 0; i < gram.length; i += 1) {
      if (BANNED_ANY.indexOf(gram[i]) >= 0) return false;
    }
    return true;
  }

  /** 词典匹配：从长到短试，命中就跳过整个词，避免"供应商"被拆成"供应" */
  function dictMatches(text) {
    const seen = Object.create(null);
    const list = [];
    let i = 0;
    while (i < text.length) {
      let hit = '';
      for (let n = 4; n >= 2; n -= 1) {
        const gram = text.slice(i, i + n);
        if (gram.length === n && DICT[gram]) {
          hit = gram;
          break;
        }
      }
      if (hit) {
        if (!seen[hit]) {
          seen[hit] = { w: hit, count: 0, at: i };
          list.push(seen[hit]);
        }
        seen[hit].count += 1;
        i += hit.length;
      } else {
        i += 1;
      }
    }
    // 出现次数 > 词长 > 出现位置：重复出现的词才是这篇的"主题词"
    list.sort((a, b) => b.count - a.count || b.w.length - a.w.length || a.at - b.at);
    return list.map((o) => o.w);
  }

  /** n-gram 兜底：只收出现过两次以上的说法，一次性的多半是"多人卡"这种半截词 */
  function ngramKeywords(text, max) {
    const runs = text.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    const counts = Object.create(null);
    const first = Object.create(null);
    runs.forEach((run) => {
      for (let n = 2; n <= 4; n += 1) {
        for (let i = 0; i + n <= run.length; i += 1) {
          const gram = run.slice(i, i + n);
          if (!usableGram(gram)) continue;
          counts[gram] = (counts[gram] || 0) + 1;
          if (first[gram] === undefined) first[gram] = text.indexOf(gram);
        }
      }
    });
    const scored = Object.keys(counts)
      .filter((gram) => counts[gram] >= 2)
      .map((gram) => ({
        gram,
        n: gram.length,
        count: counts[gram],
        score: counts[gram] * 1.6 + (gram.length === 3 ? 1.4 : 0) + (counts[gram] >= 3 ? 1 : 0),
      }));
    scored.sort((a, b) => b.score - a.score || b.n - a.n || (a.gram < b.gram ? -1 : 1));
    const out = [];
    scored.forEach((item) => {
      if (out.length >= (max || 6)) return;
      // 已选中的词和候选词互相包含就跳过，否则会选出"交付"和"交付顺延"这种重叠项
      if (out.some((g) => g.indexOf(item.gram) >= 0 || item.gram.indexOf(g) >= 0)) return;
      out.push(item.gram);
    });
    return out;
  }

  /** 时间与数字：中文稿里最需要原样保留的东西，摘要和邮件都要用 */
  function numberTokens(text) {
    const out = [];
    const push = (s) => {
      const v = squash(s);
      if (v && out.indexOf(v) < 0) out.push(v);
    };
    const ascii = text.match(/\d+(?:\.\d+)?\s*(?:年|月|日|号|天|周|小时|分钟|秒|个工作日|个|次|倍|成|分|元|万元|%|％|人)?/g) || [];
    ascii.forEach(push);
    const han = text.match(/[一二三四五六七八九十百千万两]{1,3}(?:年|月|日|号|天|周|小时|分钟|个工作日|次|倍|成|人|元|点)/g) || [];
    han.forEach(push);
    const rel = text.match(/(?:下周|本周|上周|下个月|上个月|明天|后天|昨天|今天|月初|月底|年初|年底|下周一|下周三|下周五)/g) || [];
    rel.forEach(push);
    return out.slice(0, 6);
  }

  /** 主题短语：拿来做标题、主题行、大纲的一级标题，太长就截 */
  function topicOf(text, n) {
    const s = squash(text).replace(/^[#>\-\s]+/, '');
    if (!s) return '';
    const first = splitSentences(s)[0] || s;
    const cut = clipSoft(first, n || 22).replace(/[，、；：,;:]+$/, '');
    return cut.replace(/[。！？!?]$/, '');
  }

  /** 大纲/文案的题目常写成指令句（"写一篇讲……的演讲稿"），标题里只要剩下那件事 */
  function cleanTopic(text) {
    const raw = squash(text);
    if (!raw) return '';
    let out = raw.replace(/^(帮我|帮忙|请|麻烦)?(写|做|拟|起草)(一篇|一个|一份|一则)/, '');
    if (out !== raw) out = out.replace(/^(讲|说说|聊聊|谈谈|关于)/, '');
    out = out.replace(/(的演讲稿|的文章|的长文|的稿子|的文案|的邮件|的初稿|的大纲)$/, '');
    return out.trim() || raw;
  }

  /** 叙述片还是说明片：续写的动线完全不同，必须先分出来 */
  function detectRegister(text) {
    // "后来"不能单独当叙述信号——说明文里也天天出现
    const narrative = /(那天|当时|记得|曾经|忽然|突然|一路上|回到家|坐在|走在|抬起头|低下头|谁也没|那天之后|那一年)/.test(text);
    const expository = /(如何|怎样|方法|步骤|要点|建议|应该|需要|流程|分析|总结|报告|方案|原则|原因|影响|策略|框架|清单|问题|效果|做法|经验|复盘|会议|团队|目标|标准|重点|关键)/.test(text);
    if (expository) return 'exposition';
    if (narrative) return 'narration';
    return /(我|他|她)[^。]{0,8}(了|着)/.test(text) ? 'narration' : 'exposition';
  }

  function analyze(text) {
    const src = squash(text);
    const sentences = splitSentences(src);
    const dict = dictMatches(src);
    const kws = dict.slice(0, 8);
    ngramKeywords(src, 10).forEach((w) => {
      if (kws.length >= 8) return;
      if (kws.indexOf(w) >= 0) return;
      if (kws.some((k) => k.indexOf(w) >= 0 || w.indexOf(k) >= 0)) return;
      kws.push(w);
    });
    return {
      src,
      sentences,
      kws,
      nums: numberTokens(src),
      topic: cleanTopic(topicOf(src, 22)),
      register: src ? detectRegister(src) : 'exposition',
    };
  }

  /* ══════════════════════════════════════════════════════════
   * 四、上下文与槽位填充
   * ══════════════════════════════════════════════════════════ */

  /** 语气不改内容，只改"怎么说"：选句偏好 + 称呼/落款/语气词 */
  const VOICE = {
    plain: { prefer: [], particle: '' },
    professional: { prefer: ['标准', '流程', '口径', '依据', '评估', '成本', '风险', '节点', '闭环', '拆解'], particle: '', lead: ['按标准来判断，这件事可以分三层看。', '先说结论，再谈依据。'] },
    warm: { prefer: ['其实', '不妨', '一起', '慢慢', '不用', '先', '你'], particle: '吧', lead: ['说句实在话，这件事没那么吓人。', '别急着改，先把最烦的那一步找出来就行。'] },
    crisp: { prefer: [], particle: '', short: true, lead: ['直接说重点。'] },
    same: { prefer: [], particle: '' },
    vivid: { prefer: ['桌上', '手边', '路上', '窗', '门口', '风', '杯', '一眼'], particle: '', lead: ['换个更具体的说法。'] },
    formal: { prefer: ['依据', '现', '事宜', '敬请', '妥否', '逐一'], particle: '' },
    sincere: { prefer: ['说实话', '我自己', '说句实话', '不算'], particle: '' },
    lively: { prefer: ['直接', '马上', '一秒', '干脆'], particle: '', lead: ['不绕弯子，直接说。'] },
    pro: { prefer: ['对比', '实测', '流程', '标准', '拆开'], particle: '' },
    story: { prefer: ['那天', '第一次', '后来'], particle: '' },
    polite: { prefer: ['麻烦', '感谢', '方便', '如果', '辛苦'], particle: '' },
    direct: { prefer: [], particle: '', short: true },
  };

  function voiceOf(tone) {
    return VOICE[tone] || VOICE.plain;
  }

  const MODE_FALLBACK_TOPIC = {
    continue: '往下写的那件事',
    rewrite: '这段话',
    copywriting: '这款产品',
    email: '这次要沟通的事',
    summary: '这份材料',
    outline: '这篇文章',
  };

  function makeCtx(p, mode, angle, src, rnd) {
    // 邮件素材常写成"通知供应商……"，先剥掉执行动词，关键词才不会被"通知"占住
    const analysisText = mode.id === 'email' ? stripInstruction(src) || src : src;
    const info = analyze(analysisText);
    const topic = info.topic || MODE_FALLBACK_TOPIC[mode.id] || mode.name;
    const shortTopic = clipSoft(info.topic || topic, 14).replace(/[，、。；：]$/, '');
    const kws = info.kws.length ? info.kws : [];
    const ctx = {
      params: p,
      mode,
      angle,
      rnd,
      src,
      info,
      sentences: info.sentences,
      nums: info.nums,
      kws,
      topic,
      register: info.register,
      fields: p.fields || {},
      voice: voiceOf(p.tone),
      empty: !src,
    };
    // 文案的素材本身就是"产品/主题"，短素材直接整条当名字用
    const nameFromInput = mode.id === 'copywriting' && src && src.length <= 24;
    ctx.product = mode.id === 'copywriting' ? productName(src, topic) : topic;
    ctx.kw = mode.id === 'copywriting' ? ctx.product
      : (kws[0] || shortTopic || topic);
    ctx.kw2 = nameFromInput ? (kws[0] || topic) : (kws[1] || kws[0] || shortTopic || topic);
    ctx.kw3 = kws[2] || kws[1] || kws[0] || shortTopic || topic;
    ctx.topic = topic;
    ctx.num = info.nums[0] || '';
    ctx.num2 = info.nums[1] || info.nums[0] || '';
    ctx.lead = info.sentences[0] || topic;
    ctx.tail = info.sentences[info.sentences.length - 1] || topic;
    ctx.time = timePhrase(ctx);
    return ctx;
  }

  /** 把"两天/下周三"这类数字词接成一个能直接放进句子的时间短语 */
  function timePhrase(ctx) {
    const num = ctx.num;
    if (!num) return '往后挪一点';
    if (/(年|月|日|号|周|下周|本周|上周|月底|月初|年初|年底)/.test(num) && !/^[0-9]/.test(num)) return '定在' + num;
    if (/(天|小时|分钟|个工作日|周)/.test(num)) return '往后顺延' + num;
    return '调整为' + num;
  }

  /** 槽位填不上就丢掉整句：宁可少一句，也不要留着 {kw} 或半截话 */
  function fill(tpl, ctx) {
    let missing = false;
    const out = String(tpl).replace(/\{(\w+)\}/g, (m, key) => {
      const v = ctx[key];
      if (v === undefined || v === null || v === '') {
        missing = true;
        return '';
      }
      return String(v);
    });
    if (missing) return null;
    return out
      .replace(/([，。！？；：、]){2,}/g, '$1')
      .replace(/^[，、；：\s]+/, '')
      .trim();
  }

  function poolLines(templates, ctx) {
    const out = [];
    (templates || []).forEach((tpl) => {
      const s = typeof tpl === 'function' ? tpl(ctx) : fill(tpl, ctx);
      if (s && out.indexOf(s) < 0) out.push(s);
    });
    return out;
  }

  /** 语气不能只改选句：开头先来一句带语气的话，读者才认得出这是"亲切"还是"专业" */
  function toneLead(ctx) {
    const lead = (ctx.voice.lead || []);
    if (!lead.length) return '';
    return pick(ctx.rnd, poolLines(lead, ctx));
  }

  /** 按语气给句子排序：同一批句子换个语气，读起来就不一样 */
  function orderByTone(rnd, sentences, voice) {
    return sentences
      .map((s, i) => {
        let score = rnd() * 0.35;
        (voice.prefer || []).forEach((w) => {
          if (s.indexOf(w) >= 0) score += 1;
        });
        if (voice.short) score += Math.max(0, (40 - charCount(s)) / 60);
        return { s, score, i };
      })
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((o) => o.s);
  }

  /** 换个起点：同一个池子从不同位置起头，读起来就是另起一段 */
  function rotate(rnd, list) {
    if (!list || list.length < 2) return (list || []).slice();
    const k = Math.floor(rnd() * list.length);
    return list.slice(k).concat(list.slice(0, k));
  }

  function pushUnique(list, item) {
    if (item && list.indexOf(item) < 0) list.push(item);
    return list;
  }

  /** 两句里出现 8 个字以上的相同片段，就当成"换汤不换药"的同义重复剔掉 */
  function sharesLongRun(a, b, min) {
    const len = min || 8;
    if (a === b) return true;
    if (a.length < len || b.length < len) return false;
    for (let i = 0; i + len <= a.length; i += 1) {
      if (b.indexOf(a.slice(i, i + len)) >= 0) return true;
    }
    return false;
  }

  /** 篇幅控制：先取到目标，太短用备选池补，太长从尾部删。重复的句子一律不要 */
  function fitTarget(blocks, target, reserve) {
    const kept = [];
    const used = [];
    let len = 0;
    const lo = target * 0.9;
    const hi = target * 1.18;
    const take = (b) => {
      if (!b || used.indexOf(b) >= 0) return false;
      if (kept.some((k) => sharesLongRun(k, b))) return false;
      used.push(b);
      kept.push(b);
      len += charCount(b);
      return true;
    };
    blocks.forEach((b) => {
      if (len >= lo) return;
      if (len + charCount(b) > hi && len > target * 0.6) return;
      take(b);
    });
    (reserve || []).forEach((b) => {
      if (len >= target * 0.88) return;
      take(b);
    });
    while (kept.length > 1 && len > target * 1.3) {
      len -= charCount(kept[kept.length - 1]);
      kept.pop();
    }
    return kept;
  }

  /** 中文段落靠标点分段，句子之间不空格 */
  function joinParagraphs(sentences, size) {
    const out = [];
    let buf = [];
    sentences.forEach((s, i) => {
      buf.push(s);
      const want = size[i % size.length];
      if (buf.length >= want) {
        out.push(buf.join(''));
        buf = [];
      }
    });
    if (buf.length) out.push(buf.join(''));
    return out.filter(Boolean).join('\n\n');
  }

  /* ══════════════════════════════════════════════════════════
   * 五、续写语料
   * ══════════════════════════════════════════════════════════ */

  /* 场景与动作：只在叙述片里用，接在原文后面不换人称 */
  const CONTINUE_SCENE = [
    '那天散场以后，谁都没先开口，走廊的灯只亮了一半。',
    '回去的路上我一直在想一句话：这件事到底是从哪一步开始不对的。',
    '第二天照旧，地铁还是那个点挤，人也还是那些人，只是心里多了一点事。',
    '我把那段话在心里过了两遍，第二遍才读出来一点味道。',
    '有人递过来一杯水，我接住了，没喝，放在手边一直放着。',
    '桌上摊着三份文件，边角都卷了，最上面那份的日期被人划掉，改成了新的。',
    '他说话的时候习惯先把杯子转半圈，说完再喝一口，那天上午他一共转了七次。',
    '出门前我把要说的三句话记在手机备忘录里，真到了门口，一句也没用上。',
    '窗外的雨下到一半停了，楼下有人收起伞，抖了两下，走得很慢。',
    '我把外套的领子立起来，风从背后过来，吹得后颈发凉。',
    '走到路口的时候红灯特别长，我就站在那儿把那件事又想了一遍。',
    '第二天早上我到得比平时早一刻钟，办公室的灯是我开的。'
  ];

  /* 立论与方法：说明性质的素材用这一组，接上去像是同一个人接着讲道理。
     句式不依赖先后顺序——语气排序会把它们重新排过一遍。 */
  const CONTINUE_FRAME = [
    '顺着这个思路往下走，还有一层更实际的考虑。',
    '把{kw}拆开看，无非三件事：做什么、谁来做、做到什么程度算完。',
    '先说得直白一点：结果从来不是当场产生的，产生结果的是之前那些没人看见的准备。',
    '这里面最容易混淆的一点是，忙不等于有用，频繁也不等于有效。',
    '要把标准写下来，写得越具体越好，具体到换个人来做也能照着走。',
    '每一步都该配一个看得见的产出，没有产出就等于没做。',
    '留一段固定的复盘时间，二十分钟就够，看哪一步是多余的。',
    '如果某个环节每次都要重新解释一遍，那说明它本来就不该靠人去记。',
    '能重复的事情就做成模板，第一次搭模板会慢，往后每一次都会快。',
    '一个常见的反例是：流程越加越多，事情反而越拖越久。',
    '工具能解决的是记录和提醒，解决不了的是到底由谁拍板。',
    '把标准定得低一点，先跑通一轮，通常比一次做到完美更划算。',
    '真正卡住人的往往不是难度，是每一步都要重新做一次决定。',
    '把决定变成习惯，事情才开始变轻。',
    '讨论的时间该花在标准上，而不是花在具体的那一件事上。',
    '安排落到人头上才算数，写在群公告里的，多数不会被执行。'
  ];

  /* 两种体裁通用的思考句：收束与转折都靠它，不挑场景 */
  const CONTINUE_SHARED = [
    '说到底，问题不在能力上，在愿不愿意先把话说清楚。',
    '真正难的不是开始，是每天都按同一套做法重复一遍。',
    '把标准写下来，比在群里讨论十遍都管用。',
    '衡量有没有效果好办：看结果变没变，不看过程热不热闹。',
    '不用一次改到位，先改最影响结果的那一处。',
    '先把最难的那一步放在精力最好的时段，剩下的按顺序走就行。',
    '很多改进之所以没效果，是因为改的是形式，没动到底层的那一步。',
    '事情过去很久了，我偶尔还会翻到当时记的那一页。',
    '如果只记住一句，就记这一句：先把标准定下来。',
    '这句话当时听着像安慰，后来才知道是提醒。',
    '同一件事做第二遍的时候，如果还要重新想一遍，那第一遍就白做了。',
    '很多麻烦不是解决不了，是没人愿意先花十分钟把它写清楚。',
    '看起来是效率问题，拆到最后还是分工和标准的问题。',
    '先把话说透，再谈怎么快。'
  ];

  const CONTINUE_OPEN = {
    narration: {
      flow: [
        '后来的几天，事情没有变好，也没有一下子变坏，就是那么拖着。',
        '我把那句话念了一遍，没接话，低头把桌上的东西收了收。'
      ],
      detail: [
        '真正让人记住的是第二天早上。',
        '我把{kw}那一段又读了一遍，读到第三遍才发现，前后两句话说的其实不是一回事。'
      ],
      twist: [
        '如果那天换个人坐在那个位置上，结果大概会不一样。',
        '这件事还有另外一面，只是当时谁都没往那边想。'
      ],
      land: [
        '后来我常想起那个下午，想起来的时候心里是平的。',
        '事情到这一步，其实已经没有多少可争的了。'
      ]
    },
    exposition: {
      flow: [
        '顺着这个思路往下说，还有一层更实际的考虑。',
        '先说结论：{kw}这件事，关键不在方法多，而在能不能每天都照做。'
      ],
      detail: [
        '把其中一个环节放大来看，问题会清楚得多。',
        '这里值得停一下，把{kw}单独拎出来说清楚。'
      ],
      twist: [
        '换一个角度看，结论可能正好相反。',
        '不过，多数人给出的答案恰好把因果说反了。'
      ],
      land: [
        '说到底，{kw}这件事的答案很朴素，难的是每天都照做。',
        '到这一步可以收一下：剩下的都是执行问题。'
      ]
    }
  };

  const CONTINUE_CLOSE = {
    narration: {
      flow: ['后面的事就顺着这个节奏走下去了。', '那天之后，日子还是照常过，只是我心里有数了。'],
      detail: ['这些细节比任何总结都说明问题。', '我把这几件小事记了下来，后来一直没删。'],
      twist: ['所以真正需要回答的问题不是怎么做，而是谁来做。', '想到这里，前面的那些道理忽然都轻了。'],
      land: ['那天之后，我按这句话做了很久。', '能把这件事做完的人，比懂这件事的人少得多。']
    },
    exposition: {
      flow: ['把这几步排上顺序，剩下的就是执行和微调。', '照这个顺序走一轮，效果一般不会太差。'],
      detail: ['把这一处改掉，{kw}这件事就顺了大半。', '先动最影响结果的那一步，其他的往后放。'],
      twist: ['所以要先回答的问题不是怎么做，而是这件事该不该做。', '顺序一换，轻重也跟着换了。'],
      land: ['如果只落一条，就落这一条：先把标准定下来。', '剩下的交给时间，也交给习惯。']
    }
  };

  function composeContinue(p, mode, angle, ctx, target) {
    const reg = ctx.register === 'narration' ? 'narration' : 'exposition';
    const opener = orderByTone(ctx.rnd, poolLines(CONTINUE_OPEN[reg][angle.id] || CONTINUE_OPEN[reg].flow, ctx), ctx.voice).slice(0, 1);
    const body = reg === 'narration'
      ? [CONTINUE_SCENE, CONTINUE_SHARED]
      : [CONTINUE_FRAME, CONTINUE_SHARED];
    // 角度决定动线：先场景后道理，还是先道理后场景，读起来完全不是一篇
    const groups = angle.id === 'detail' ? [body[0], body[1], body[0]]
      : angle.id === 'twist' ? [body[1], body[0]]
        : angle.id === 'land' ? [body[1], body[1], body[0]]
          : [body[0], body[1]];
    const bridge = reg === 'narration'
      ? pick(ctx.rnd, [
        `我心里翻来覆去的，还是${ctx.kw}那件事。`,
        `真正让我在意的是${ctx.kw}这一块，别的都好说。`
      ])
      : pick(ctx.rnd, [
        `那我们回到${ctx.kw}这件事上。`,
        `具体到${ctx.kw}，情况是这样。`
      ]);
    const blocks = [];
    groups.forEach((g) => {
      // 先按语气定序，再整体错开一个起点：语气进得来，叙述的先后不乱
      rotate(ctx.rnd, orderByTone(ctx.rnd, poolLines(g, ctx), ctx.voice)).forEach((s) => {
        if (opener.indexOf(s) < 0) pushUnique(blocks, s);
      });
    });
    const close = pick(ctx.rnd, poolLines(CONTINUE_CLOSE[reg][angle.id] || CONTINUE_CLOSE[reg].flow, ctx));
    const tail = close ? [close] : [];
    const lead = toneLead(ctx);
    const head = lead ? opener.concat([lead]) : opener;
    const budget = Math.max(90, target - charCount(tail.join('')) - charCount(head.join('')));
    const kept = fitTarget([bridge].concat(blocks), budget, poolLines(CONTINUE_SHARED, ctx));
    return joinParagraphs(head.concat(kept, tail), [2, 3, 2]);
  }

  /* ══════════════════════════════════════════════════════════
   * 六、改写语料与变换
   * ══════════════════════════════════════════════════════════ */

  /* 同义换词表：只收"换了不改变原意"的对。
     单字词（与/及/其）一律不进表——它们在"参与""以及"里会把人写笑。 */
  const SYNONYMS = [
    ['提升', '提高'], ['提高', '提升'], ['目前', '眼下'], ['因此', '所以'],
    ['但是', '不过'], ['并且', '而且'], ['通过', '靠'], ['利用', '用'],
    ['帮助', '帮'], ['达到', '达成'], ['具备', '有'], ['拥有', '有'],
    ['逐渐', '慢慢'], ['立即', '马上'], ['如果', '要是'], ['以及', '和'],
    ['由于', '因为'], ['对于', '对'], ['应当', '应该'], ['能够', '能'],
    ['是否', '是不是'], ['显著', '明显'], ['大量', '很多'], ['进行', '做'],
    ['务必', '一定要'], ['非常', '很'], ['才能', '才可以'],
    ['总是', '往往'], ['发现', '看出'], ['效果', '成效'], ['方法', '做法'],
    ['认为', '觉得'], ['觉得', '认为'],
    ['重要', '要紧'], ['复杂', '麻烦'], ['清楚', '明白'],
    ['保证', '确保'], ['完成', '做完'], ['处理', '应对'], ['解决', '处理'],
    ['计划', '打算'], ['尝试', '试着'], ['选择', '挑'], ['建议', '提议'],
    ['讨论', '商量'], ['确认', '核实'], ['通知', '告知'],
    ['缩短', '压短'], ['每个人', '人人'], ['不好', '不理想'], ['试过', '试了'], ['记得', '记住'],
  ];

  const SYN_RE = new RegExp(SYNONYMS.map((p) => p[0]).join('|'), 'g');
  const SYN_MAP = (function () {
    const map = Object.create(null);
    SYNONYMS.forEach((p) => {
      map[p[0]] = p[1];
    });
    return map;
  })();

  const NUMERAL = '0-9一二三四五六七八九十百千万两几';

  /** 数字旁边不动手：把"四十分钟"改成"四相当钟"是这类替换最典型的翻车 */
  function safeToSwap(text, at, word) {
    const prev = at > 0 ? text[at - 1] : '';
    const next = text[at + word.length] || '';
    if (prev && NUMERAL.indexOf(prev) >= 0) return false;
    if (word.length === 1) return false;
    if (next === '的' && /^(进行|帮助|通过|利用)$/.test(word)) return false;
    return true;
  }

  const FILLER_WORDS = ['其实', '基本上', '实际上', '说实话', '可以说', '我个人认为', '总的来说', '严格来说', '其实呢'];

  /** 一趟扫完，不复扫替换结果——否则"提升→提高"会被下一轮再换回去 */
  function applySynonyms(text, rnd, rate) {
    const keep = rate === undefined ? 0.75 : rate;
    return text.replace(SYN_RE, (word, at) => {
      if (!safeToSwap(text, at, word)) return word;
      // 只换一部分：让同一素材的不同版本在措辞上错开
      return rnd() < keep ? SYN_MAP[word] : word;
    });
  }

  function dropFillers(text) {
    let out = text;
    FILLER_WORDS.forEach((w) => {
      out = out.split(w + '，').join('');
      out = out.split(w + ',').join('');
      out = out.split(w).join('');
    });
    return out.replace(/^[，、\s]+/, '');
  }

  /** 一句拆成两句：长句读着累，改写时最常用的一招 */
  function splitLongSentence(s) {
    if (charCount(s) < 46) return s;
    const cutAt = s.indexOf('，', Math.floor(s.length * 0.35));
    if (cutAt < 0) return s;
    return s.slice(0, cutAt).replace(/[，,]$/, '。') + s.slice(cutAt + 1);
  }

  function shiftPerson(text) {
    return text
      .split('我们').join('你')
      .split('大家').join('你')
      .split('我认为').join('照我看')
      .split('我觉得').join('照我看')
      .split('我们可以看到').join('你能看到')
      .split('需要').join('建议你')
      .replace(/建议你你/g, '建议你');
  }

  /** 找出最像"结论"的一句，重排结构时提到最前面 */
  function conclusionSentence(sentences) {
    const marks = ['因此', '所以', '结论', '建议', '关键', '重点', '需要', '应该', '总之', '最终', '问题', '不在', '真正'];
    let best = null;
    let bestScore = -1;
    sentences.forEach((s, i) => {
      let score = -i * 0.1;
      marks.forEach((m) => {
        if (s.indexOf(m) >= 0) score += 1;
      });
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    });
    return best;
  }

  /** 删掉可删的虚词：压缩篇幅那条角度主要靠它 */
  function trimModifiers(s) {
    return s
      .replace(/(其实|基本上|实际上|真的|大概|可能|比较|总是|同样)/g, '')
      .replace(/[，、]{2,}/g, '，')
      .replace(/^[，、]+/, '')
      .replace(/，(?=[。！？])/g, '');
  }

  /** 把相邻的短句并成一句：只会并，不会拆，意思不会走样 */
  function mergeShort(rnd, sentences) {
    const out = [];
    sentences.forEach((s) => {
      const prev = out[out.length - 1];
      if (prev && rnd() < 0.5 && charCount(prev) + charCount(s) <= 52 && /[。]$/.test(prev)) {
        out[out.length - 1] = prev.replace(/。$/, '，') + s;
        return;
      }
      out.push(s);
    });
    return out;
  }

  /** 给句子接一个过渡词：换一种说法，读起来就不是原句了 */
  const TRANSITIONS = ['换句话说，', '换个说法，', '说白一点，', '再往下看，', '顺着说，'];

  function withTransition(rnd, sentences, angleId) {
    return sentences.map((s, i) => {
      if (i === 0 || rnd() > 0.34) return s;
      const t = pick(rnd, TRANSITIONS);
      return t + s;
    });
  }

  function composeRewrite(p, mode, angle, ctx, target) {
    const source = ctx.sentences.slice();
    if (!source.length) return composeFallback(p, mode, angle, ctx, target);
    const strength = ctx.fields.strength || 'medium';
    const rnd = ctx.rnd;

    let work;
    if (angle.id === 'restructure') {
      const head = conclusionSentence(source);
      const rest = source.filter((s) => s !== head);
      work = (head ? [applySynonyms(head, rnd)] : []).concat(rest.map((s) => applySynonyms(s, rnd)));
    } else if (angle.id === 'person') {
      work = source.map((s) => applySynonyms(shiftPerson(s), rnd));
    } else if (angle.id === 'tighten') {
      work = source.map((s) => trimModifiers(dropFillers(applySynonyms(s, rnd)))).map(splitLongSentence);
    } else {
      work = source.map((s) => applySynonyms(s, rnd));
    }

    if (strength === 'heavy') {
      work = mergeShort(rnd, work);
    } else if (strength === 'medium') {
      work = withTransition(rnd, work, angle.id);
    }
    if (angle.id === 'tighten' || p.tone === 'crisp') {
      work = work.map(trimModifiers).map(splitLongSentence);
    }
    if (p.tone === 'vivid') {
      const frames = ['说白了，', '换个说法，', '落到实处看，'];
      work = work.map((s, i) => (i % 3 === 0 ? pick(rnd, frames) + s : s));
    }
    if (p.tone === 'formal') {
      work = work.map((s) => s.replace(/^说白了，/, '').replace(/吧([。！])/g, '$1'));
    }

    const budget = Math.max(90, target);
    const kept = fitTarget(work, budget, []);
    const free = ctx.fields.keep === 'freeStructure' && angle.id !== 'faithful';
    return joinParagraphs(kept, free ? [1, 2, 3] : [2, 2, 3]);
  }

  /* ══════════════════════════════════════════════════════════
   * 七、文案语料
   * ══════════════════════════════════════════════════════════ */

  const EMOJI = {
    pain: ['😮‍💨', '🙃', '😭'],
    scene: ['🌿', '☀️', '🪴'],
    compare: ['📊', '🆚', '✨'],
    ask: ['🙋', '💬', '👇'],
  };

  const COPY_HOOK = {
    pain: [
      '在{kw}上我换过好几样，最后留下来的只有一个。',
      '{kw}最让人头疼的地方不是贵，是买回来才发现跟想的不一样。',
      '关于{kw}，我踩过的坑大概能写满两页纸。',
      '如果你也在{kw}上反复花冤枉钱，这篇大概是写给你的。'
    ],
    scene: [
      '上周下雨那天，我第一次把{kw}带出门。',
      '{kw}最好用的那一刻，是某个特别赶时间的早上。',
      '把{kw}放进一天里看，它出现的次数比想象中多。',
      '第一次拿到{kw}的时候，我没抱太大期待，毕竟这类东西十有八九用两天就放着。'
    ],
    compare: [
      '同样价位的{kw}，差别到底在哪，我把两个都用了两周。',
      '以前我用的是另一种{kw}，换了之后差别挺明显。',
      '不比不知道：{kw}差的不是花哨，是好不好用。',
      '关于{kw}，我把“看起来好用”和“真的顺手”分开了。'
    ],
    ask: [
      '问你一个问题：你用过的{kw}里，有几个是真的用下去了？',
      '先别急着下单，想想你上一次买{kw}是因为什么。',
      '{kw}上，你更在意好用，还是更在意便宜？',
      '有没有一种可能：不是{kw}不好用，只是一直没挑对。'
    ]
  };

  const COPY_BODY = {
    pain: [
      '麻烦的地方从来不是花钱，是买回来以后每天都要迁就它。',
      '真正的浪费不在单价上，在买回来之后闲置的那几个月。',
      '所以我现在只看一个标准：它能不能让我少将就一次。',
      '挑对之后，最直接的变化是——我不用再想着它了。',
      '我不太会用形容词夸东西，就说三个我实际在意的：好不好用、耐不耐用、值不值这个价。',
      '最怕的是那种“看起来很值”的东西：买的时候省了钱，用的时候每天都别扭。',
      '如果你也在同一类东西上反复试错，先说一句：这不怪你。',
      '问题多半不在预算，而在买之前没人把真实的使用场景讲清楚。'
    ],
    scene: [
      '它最好用的地方是不用适应——拿到手就会用，不用翻说明书。',
      '第一次用的时候我没抱期待，因为这类东西十有八九用两天就放着了。',
      '真正让我留下它的，是某个赶时间的早上，它替我把最麻烦的那一步省掉了。',
      '它解决不了所有问题，但它把最常卡住的那一环接住了。',
      '后来我把它推荐给了同事，理由很简单：这种顺手的东西不用挑时机安利。',
      '现在它不是“要记得用”，是“顺手就拿起来”。',
      '早上出门前花十秒钟就收好了，比以前省事太多。',
      '用了一个多月，最明显的变化是我一次都没想过换回原来那个。'
    ],
    compare: [
      '以前那个是硬扛：能用，但每次都要迁就它。',
      '差别在头三天看不出来，用满一个月就很明显了。',
      '便宜和划算之间差一步：前者省在付钱那一刻，后者省在每一天。',
      '同样一件事，一次做对和每次都做对，费的力气完全不是一回事。',
      '我不信“一劳永逸”，但至少可以做到不用每次都重新适应。',
      '前后对比下来，省的不是钱，是每天那几次将就。',
      '如果你也试过几样都没留下，多半是挑的时候标准没定对。',
      '把标准定成“我愿意天天用它”，选择立刻就少了。'
    ],
    ask: [
      '如果只能保留一个功能，你会留哪个？',
      '你也可以先试一次，再决定要不要留下它。',
      '有想法欢迎在评论区说，我看到都会回。',
      '把你最不满意的地方写下来，说不定别人已经找到替代方案了。',
      '你平时是怎么用这类东西的？我挺想知道有没有更顺手的做法。',
      '先别急着下结论，用满一周再看。',
      '如果这篇对你有用，转给同样在挑的人。',
      '评论区告诉我你的场景，我可以帮你看看适不适合。'
    ]
  };

  /* 各角度都适用的补充：长篇时用来填到目标字数，不至于一直重复前面的话 */
  const COPY_SHARED = [
    '我不太信“一步到位”，更信“每天少一次将就”。',
    '真正用得久的东西，通常都不需要下决心去坚持。',
    '别把它当成一件大事，它就是个顺手的小工具。',
    '说到底，省下来的不是钱，是心力。',
    '如果要给个建议：先想清楚你最常碰到的那个场景，别的慢慢来。',
    '这不是什么大道理，就是我自己用过之后留下来的判断。',
    '该说的都说了，剩下的看你自己合不合用。',
    '合适就用，不合适就换一种，没必要为难自己。'
  ];

  const COPY_TAGS = ['好物推荐', '经验分享', '好物分享', '生活记录', '新手必看', '真实体验', '避坑指南', '选购建议'];

  /* 话题标签是给人搜的：虚词、时间词、代词都不该变成标签 */
  const TAG_STOPWORDS = new Set([
    '只有', '其实', '所以', '因为', '但是', '如果', '就是', '可以', '需要', '什么', '怎么', '为什么', '这个', '那个',
    '这样', '那样', '一下', '一定', '真的', '还是', '或者', '然后', '已经', '没有', '不是', '这些', '那些', '自己',
    '大家', '时候', '地方', '东西', '事情', '问题', '情况', '内容', '方面', '相关', '本周', '下周', '上周', '今天',
    '明天', '昨天', '上午', '下午', '晚上',
  ]);

  function isTagWorthy(word) {
    const w = String(word || '').trim();
    if (w.length < 2 || w.length > 6) return false;
    if (TAG_STOPWORDS.has(w)) return false;
    // 纯数字或带标点的都不适合当标签
    return !/^[0-9]+$/.test(w) && !/[，。！？、；：""''（）]/.test(w);
  }

  /** 文案的题目常写成"一款……的便携录音笔"，标题里只需要最后那个名字 */
  function productName(src, topic) {
    const tail = squash(topic).split(/[的｜|、，（(]/).filter(Boolean).pop() || topic;
    const name = tail.length >= 3 && tail.length <= 16 ? tail : clipSoft(topic, 14);
    return (
      name
        // "一款静音咖啡机"里的量词不是名字的一部分
        .replace(/^(这是|那是|一款|一个|一种|这款|那款|一套|一件|一份|一次|一款的)/, '')
        .replace(/[。！？、，]+$/, '') || clipSoft(src || topic, 12)
    );
  }

  function copyTitle(platform, angle, ctx, emoji) {
    const k = ctx.kw;
    const selling = ctx.fields.selling ? clip(ctx.fields.selling, 14) : '';
    const audience = ctx.fields.audience ? clip(ctx.fields.audience, 10) : '';
    const rnd = ctx.rnd;
    if (platform === 'wechat') {
      return pick(rnd, [
        `关于${k}，我踩过的坑和最后留下的那个`,
        `说说${k}该怎么挑，很多人第一步就做反了`,
        `${k}到底差在哪？我把两个都用了两周`
      ]);
    }
    if (platform === 'douyin') {
      return pick(rnd, [
        `${k}别再乱买了，先看这三秒`,
        `挑${k}只看一件事，其他都是次要的`,
        `${k}怎么挑最省心？我说个实在的`
      ]);
    }
    if (platform === 'ecommerce') {
      return selling ? `${k}｜${selling}` : `${k}｜把最常卡住的那一步接住`;
    }
    if (platform === 'moments') {
      return '';
    }
    const head = pick(rnd, [
      `${emoji}${k}用了一个月，说点实在的`,
      `${emoji}认真说说${k}，不吹不黑`,
      `${emoji}${audience || '普通人'}怎么挑${k}，我的真实经验`,
      selling ? `${emoji}${k}｜${selling}` : `${emoji}${k}｜挑对了就不用再想它`
    ]);
    return head;
  }

  function composeCopywriting(p, mode, angle, ctx, target) {
    const platform = ctx.fields.platform || 'xiaohongshu';
    const rnd = ctx.rnd;
    const emoji = pick(rnd, EMOJI[angle.id] || EMOJI.ask);
    const blocks = [];

    const hook = pick(rnd, poolLines(COPY_HOOK[angle.id] || COPY_HOOK.ask, ctx));
    pushUnique(blocks, hook);
    if (ctx.fields.selling) {
      pushUnique(blocks, `说到${ctx.kw}，我最想让人记住的就一点：${clip(ctx.fields.selling, 30)}。`);
    }
    if (ctx.fields.audience) {
      pushUnique(blocks, `如果你也是${clip(ctx.fields.audience, 16)}，下面这几条大概用得上。`);
    }
    const main = orderByTone(rnd, poolLines(COPY_BODY[angle.id] || COPY_BODY.scene, ctx), ctx.voice);
    const reserve = rotate(rnd, poolLines(COPY_BODY[angle.id === 'ask' ? 'scene' : 'ask'], ctx))
      .concat(rotate(rnd, poolLines(COPY_SHARED, ctx)))
      .filter((s) => blocks.indexOf(s) < 0 && main.indexOf(s) < 0);
    main.forEach((s) => pushUnique(blocks, s));

    const budget = Math.max(80, target * 0.86);
    const kept = fitTarget(blocks, budget, reserve);
    // 平台的排版习惯不一样：朋友圈要短，详情页要清单，公众号要成段
    let body;
    if (platform === 'moments') body = kept.slice(0, 3).join('');
    else if (platform === 'ecommerce') body = kept.map((s, i) => `${i + 1}. ${s}`).join('\n');
    else if (platform === 'wechat') body = joinParagraphs(kept, [2, 3]);
    else body = kept.join('\n');

    const title = copyTitle(platform, angle, ctx, emoji);
    let lines = [];
    if (title) lines.push(title);
    if (body) lines.push(body);
    if (platform === 'xiaohongshu' || platform === 'douyin') {
      const tags = ['#' + ctx.product];
      // 话题标签要能被人搜，虚词凑出来的"#只有""#其实"只会显得外行
      ctx.kws.filter(isTagWorthy).slice(0, 2).forEach((k) => {
        if ('#' + k !== tags[0]) tags.push('#' + k);
      });
      shuffle(rnd, COPY_TAGS).slice(0, platform === 'douyin' ? 1 : 2).forEach((t) => tags.push('#' + t));
      lines.push(tags.join(' '));
    } else if (platform === 'wechat') {
      lines.push('# ' + ctx.product);
    }
    if (p.tone === 'sincere' && platform !== 'moments') {
      lines.push('（不是广告，就是自己用着顺手。）');
    }
    if (p.tone === 'lively' && platform === 'xiaohongshu') {
      lines = [lines[0] + ' ' + emoji].concat(lines.slice(1));
    }
    return lines.filter(Boolean).join('\n\n');
  }

  /* ══════════════════════════════════════════════════════════
   * 八、邮件语料
   * ══════════════════════════════════════════════════════════ */

  const EMAIL_LEAD_VERBS = ['帮我', '帮忙', '请', '麻烦', '需要', '要', '写一封', '写一个', '写', '发一封', '发', '通知', '告诉', '跟', '向', '给', '说明一下', '说明', '安排', '约', '催一下', '催', '提醒', '确认'];

  /** 素材里常写成"通知供应商……"，这类执行动词放进邮件主题很别扭，先剥掉 */
  function stripInstruction(text) {
    let out = squash(text).replace(/[。！？]$/, '');
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < EMAIL_LEAD_VERBS.length; i += 1) {
        const v = EMAIL_LEAD_VERBS[i];
        if (out.indexOf(v) === 0 && out.length > v.length + 3) {
          out = out.slice(v.length).replace(/^[，、,：:\s]+/, '');
          changed = true;
          break;
        }
      }
    }
    return out.replace(/(的邮件|的邮件内容|这件事)$/, '');
  }

  const EMAIL_BG = [
    '先把背景说一下：这件事原来是按原计划推进的，中间出了一点变化，需要跟您同步。',
    '情况是这样：{kw}这一块目前的进展和最初的安排有出入，所以我们做了这次调整。',
    '原因在我们这边，不在贵方：这几天的准备时间比预计的长，进度被压后了一点。',
    '为了不让后面的环节受影响，我们把时间重新排了一遍。',
    '如果这个变化对您的排产或计划有影响，请直接说，我们再一起调。',
    '这几天的进展我一直盯着，能提前说的就提前说了，不想让您那边临时改计划。',
    '如果贵方内部需要一份书面的变更说明，我这边随时可以出。',
    '这次的改动本身不大，但涉及的时间节点比较敏感，所以单独写一封邮件说明。',
    '后面的每一步我都会提前跟您对一次，避免再出现临时改动。',
    '我们内部已经把相关的风险过了一遍，最坏的情况也有应对办法，请放心。'
  ];

  const EMAIL_MATTER = [
    '关于{kw}，我们这边的时间需要{time}。',
    '这次调整只涉及时间，其余环节照原计划继续，接口人和验收标准都不变。',
    '如果顺延后的时间对您不方便，我们可以再商量一个折中的方案。',
    '这次调整只影响这一批，下一批仍按原来的节奏走。',
    '其他的接口人对不上，请一并转告，免得两边按不同的时间做事。',
    '时间确认之后，我把更新过的排期表发给您一份，方便对齐。',
    '需要提前准备的物料，我会在原定时间之前一周给您清单。',
    '如果贵方那边也有排期上的难处，我们可以把两边的时间放在一张表上一起看。',
    '这次的时间变更我会在项目群里同步一次，避免有人还按旧时间安排。'
  ];

  const EMAIL_ASK = {
    confirm: [
      '需要您确认的是：调整后的时间是否可以接受。',
      '麻烦回复一句“可以”或“需要再议”，我好安排下一步。'
    ],
    meeting: [
      '想约您二十分钟，把这件事当面过一遍。',
      '时间上有两个选择：本周四下午、本周五上午，您挑方便的就行。'
    ],
    notify: [
      '这封邮件只是同步信息，不需要您回复。',
      '后续再有变化，我会第一时间告知。'
    ],
    urge: [
      '这件事的后续节点压得比较近，麻烦您在{num}之前给一个回复。',
      '如果本周内收不到回复，我只能先按原方案推进，特此说明。'
    ],
    thanks: [
      '这次多亏您配合，节奏才没被打乱，谢谢。',
      '前面几轮沟通辛苦您了，之后还请继续支持。'
    ]
  };

  const EMAIL_POLITE = {
    formal: { hello: '您好：', bye: ['此致', '敬礼'], sign: '（签名）' },
    polite: { hello: '，您好：', bye: ['顺祝工作顺利'], sign: '（签名）' },
    direct: { hello: '，你好。', bye: [], sign: '' },
  };

  const EMAIL_SUBJECT = {
    confirm: (core) => `关于${core}的说明（请确认）`,
    meeting: (core) => `关于${core}的时间安排（请选一个）`,
    notify: (core) => `关于${core}的安排`,
    urge: (core) => `请跟进：${core}相关事项`,
    thanks: (core) => `关于${core}的致谢`,
  };

  /* 主题行要的是「名词」，不是动词、时间词或套话，否则拼出来是病句：
     "通知客户原定本周五的系统验收因设备未到位需要顺延" 直接塞进主题就是
     "关于……需要的说明"。所以先挑一个像名词的关键词，挑不到再退回截断的句子。 */
  const SUBJECT_NOT_NOUN = new Set([
    '通知', '需要', '确认', '说明', '同步', '请', '要', '安排', '提醒', '告诉', '跟进', '回复', '沟通', '商量', '讨论',
  ]);
  const SUBJECT_BLAND = new Set([
    '时间', '事情', '内容', '情况', '问题', '相关', '事项', '原因', '理由', '要求', '方面', '大家', '一下',
    '本周', '下周', '上周', '今天', '明天', '昨天', '上午', '下午', '晚上', '当天', '以后', '之前', '之后',
  ]);

  /** 邮件主题里的那个名词：越靠后的关键词通常越具体 */
  function subjectCore(ctx) {
    const nouns = (ctx.kws || []).filter(
      (w) => w && w.length >= 2 && w.length <= 6 && !SUBJECT_NOT_NOUN.has(w) && !SUBJECT_BLAND.has(w)
    );
    if (nouns.length) return nouns[nouns.length - 1];

    const clause = (stripInstruction(ctx.src) || ctx.topic || '').split(/[，,。；;：:]/)[0] || '';
    const trimmed = clipSoft(clause, 16)
      .replace(/[。！？，,、；;：:]+$/, '')
      .replace(/(需要|要|因|并|请|的|和|与)$/, '');
    return trimmed || '本次调整';
  }

  function composeEmail(p, mode, angle, ctx, target) {
    const expect = ctx.fields.expect || 'confirm';
    const tone = p.tone === 'formal' || p.tone === 'polite' || p.tone === 'direct' ? p.tone : 'polite';
    const polite = EMAIL_POLITE[tone];
    const rnd = ctx.rnd;
    const shortCore = subjectCore(ctx);

    const greeting = ctx.fields.to ? ctx.fields.to + polite.hello : '您好：';
    const blocks = [];
    if (ctx.fields.matter) pushUnique(blocks, `${clip(ctx.fields.matter, 40)}，说明如下。`);

    const background = orderByTone(rnd, poolLines(EMAIL_BG, ctx), ctx.voice);
    const matter = poolLines(EMAIL_MATTER, ctx);
    const ask = poolLines(EMAIL_ASK[expect] || EMAIL_ASK.confirm, ctx);

    if (angle.id === 'bluf') {
      ask.forEach((s) => pushUnique(blocks, s));
      matter.slice(0, 3).forEach((s) => pushUnique(blocks, s));
      if (tone !== 'direct') background.slice(0, 2).forEach((s) => pushUnique(blocks, s));
    } else if (angle.id === 'context') {
      background.slice(0, 2).forEach((s) => pushUnique(blocks, s));
      matter.slice(0, 3).forEach((s) => pushUnique(blocks, s));
      ask.forEach((s) => pushUnique(blocks, s));
    } else {
      pushUnique(blocks, background[0]);
      matter.slice(0, 3).forEach((s) => pushUnique(blocks, s));
      ask.forEach((s) => pushUnique(blocks, s));
    }

    if (tone === 'direct') blocks.length = Math.min(blocks.length, 3);
    if (ctx.voice.particle === '吧' && blocks.length) {
      blocks[blocks.length - 1] = blocks[blocks.length - 1].replace(/。$/, '吧。');
    }

    const budget = Math.max(80, target - 24);
    const reserve = background.slice(2).concat(matter).filter((s) => blocks.indexOf(s) < 0);
    // "直接"这个语气说三句就够，别的语气才按篇幅铺开
    const kept = tone === 'direct' ? blocks.slice(0, 3) : fitTarget(blocks, budget, reserve);

    const paras = [];
    if (angle.id === 'bullet' && kept.length > 2) {
      // 分条列点贵在能逐条回复，条数一多就没人看了
      paras.push(kept[0]);
      paras.push(kept.slice(1, 6).map((s, i) => `${i + 1}. ${s}`).join('\n'));
      if (kept.length > 6) paras.push(kept.slice(6).join(''));
    } else {
      joinParagraphs(kept, [2, 2, 3]).split('\n\n').forEach((seg) => paras.push(seg));
    }

    const lines = [`主题：${(EMAIL_SUBJECT[expect] || EMAIL_SUBJECT.confirm)(shortCore)}`, '', greeting];
    paras.forEach((seg) => lines.push('', seg));
    if (polite.bye.length) lines.push('', polite.bye.join('\n'));
    if (polite.sign) lines.push('', polite.sign);
    return lines.join('\n');
  }

  /* ══════════════════════════════════════════════════════════
   * 九、摘要语料与抽取
   * ══════════════════════════════════════════════════════════ */

  const LEAD_FILLERS = ['那么', '所以说', '总之', '另外', '此外', '其实', '而且', '但是', '不过', '同时', '因此', '所以', '然后', '接下来', '首先', '其次', '最后', '再有'];

  function cleanPoint(sentence) {
    let out = squash(sentence).replace(/^[，、。；：\s]+/, '');
    LEAD_FILLERS.forEach((f) => {
      if (out.indexOf(f) === 0) out = out.slice(f.length).replace(/^[，、,：:]\s*/, '');
    });
    out = out.replace(/^(我们|大家)?(可以|不难)?(看到|看出|发现|知道)[，,]?/, '');
    out = out.replace(/^(值得注意的?是|需要指出的是|需要说明的是|显而易见)[，,]?/, '');
    return out.replace(/^[，、,：:]+/, '').trim();
  }

  const POINT_MARKS = ['结论', '建议', '决定', '要求', '需要', '应该', '因此', '所以', '风险', '问题', '完成', '负责', '时间', '下次', '下周', '目标', '结果'];

  /**
   * 抽取要点：长度、位置、数字、结论词四个信号加权，
   * 目的是让摘要覆盖原文的实际内容，而不是复述一句空话。
   */
  function keyPoints(text, max) {
    const src = squash(text);
    const limit = Math.max(1, max || 5);
    const sentences = splitSentences(src).map(cleanPoint).filter((s) => charCount(s) >= 6);
    if (!sentences.length) return [];
    const kws = dictMatches(src).slice(0, 6);
    const total = src.length || 1;
    const scored = sentences.map((s) => {
      let score = 0;
      const len = charCount(s);
      if (len >= 14 && len <= 70) score += 1.4;
      if (len > 90) score -= 0.6;
      if (/\d/.test(s)) score += 1.6;
      if (/[一二三四五六七八九十百千万两]{1,3}(?:年|月|日|天|个|次|倍|成|元|万|%)/.test(s)) score += 1.2;
      kws.forEach((k) => {
        if (s.indexOf(k) >= 0) score += 0.7;
      });
      POINT_MARKS.forEach((m) => {
        if (s.indexOf(m) >= 0) score += 0.5;
      });
      const at = src.indexOf(s);
      if (at >= 0 && at < total * 0.3) score += 1.1;
      if (/^(另外|此外|同时|而且|不过|但是|所以|因此)/.test(s)) score -= 0.3;
      return { s, score, at: at < 0 ? total : at };
    });
    scored.sort((a, b) => b.score - a.score || a.at - b.at);
    const out = [];
    const seen = Object.create(null);
    scored.forEach((item) => {
      if (out.length >= limit) return;
      const finger = item.s.slice(0, 8);
      if (seen[finger]) return;
      seen[finger] = true;
      out.push({ s: clipSoft(item.s, 80), at: item.at });
    });
    // 按原文顺序返回：摘要读起来才有脉络
    return out.sort((a, b) => a.at - b.at).map((o) => o.s);
  }

  const SUMMARY_LEAD = {
    neutral: ['这份材料讲的主要是{kw}，要点如下。', '{kw}是主线，其余内容都从这里展开。'],
    decision: ['先把结论放在前面：{kw}这件事需要一个明确的判断。', '就{kw}来说，材料给出的结论是清楚的。'],
    todo: ['{kw}这件事，接下来要做的事材料里已经列明了。', '按材料里的安排，{kw}的下一步动作是清楚的。'],
  };

  const ANGLE_MARKS = {
    decision: ['结论', '决定', '因此', '所以', '影响', '风险', '结果', '判断', '建议'],
    todo: ['需要', '应该', '负责', '完成', '安排', '下周', '本周', '时间', '待办', '确认'],
  };

  /** 按角度给要点重新排序：同一份材料，"面向决策"和"动作清单"挑的句子不一样 */
  function reorderPoints(points, angleId) {
    const marks = ANGLE_MARKS[angleId];
    if (!marks) return points.slice();
    return points
      .map((s, i) => {
        let score = -i * 0.05;
        marks.forEach((m) => {
          if (s.indexOf(m) >= 0) score += 1;
        });
        return { s, score, i };
      })
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((o) => o.s);
  }

  function composeSummary(p, mode, angle, ctx, target) {
    const shape = ctx.fields.shape || 'paragraph';
    const src = ctx.src;
    const picked = reorderPoints(keyPoints(src, shape === 'paragraph' ? 6 : 8), angle.id);

    if (!picked.length) {
      return fallbackSummary(p, shape, ctx);
    }

    const lead = pick(ctx.rnd, poolLines(SUMMARY_LEAD[angle.id] || SUMMARY_LEAD.neutral, ctx));
    const rnd = ctx.rnd;

    if (shape === 'bullets') {
      return picked.map((s, i) => `${i + 1}. ${s}`).join('\n');
    }
    if (shape === 'minutes') {
      const lines = ['结论', '1. ' + picked[0]];
      if (picked[1]) lines.push('2. ' + picked[1]);
      lines.push('', '待办');
      const todos = picked.slice(2, 6);
      if (todos.length) {
        todos.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
      } else {
        lines.push('1. 材料里没写明具体待办，需要补充责任人与时间。');
      }
      lines.push('', '责任人');
      lines.push('材料未指明，待确认。');
      return lines.join('\n');
    }
    if (shape === 'exec') {
      const lines = ['结论', picked[0], '', '依据'];
      lines.push(picked.slice(1, 6).map((s, i) => `${i + 1}. ${s}`).join('\n'));
      return lines.join('\n');
    }

    const connectorSets = {
      neutral: ['同时，', '另外，', '此外，', '与此同时，'],
      decision: ['更重要的是，', '这意味着，', '据此，', '从结果看，'],
      todo: ['具体来说，', '接下来，', '同时需要说明的是，', '落到动作上，'],
    };
    const connectors = shuffle(rnd, connectorSets[angle.id] || connectorSets.neutral);
    const parts = [];
    if (lead) parts.push(lead);
    let len = charCount(parts.join(''));
    let ci = 0;
    picked.forEach((s, i) => {
      if (len > target * 1.1) return;
      const piece = i === 0 || !connectors.length ? s : connectors[(ci++) % connectors.length] + s;
      parts.push(piece);
      len += charCount(piece);
    });
    return joinParagraphs(parts, [2, 3]);
  }

  /** 没有原文时也要给出能用的一稿，而不是空字符串或一句"请输入内容" */
  function fallbackSummary(p, shape, ctx) {
    const base = [
      '先说事项与结论：这次要处理的是什么，最后的判断是什么。',
      '再说依据：支撑这个判断的事实、数据和已经发生的变化。',
      '接着说影响：这件事会影响谁，影响到什么程度，什么时候能看出来。',
      '最后落在动作上：谁在什么时间之前完成什么，做完之后向谁反馈。'
    ];
    if (shape === 'bullets' || shape === 'minutes' || shape === 'exec') {
      const head = shape === 'minutes' ? ['结论'] : shape === 'exec' ? ['结论'] : [];
      return head.concat(base.map((s, i) => `${i + 1}. ${s}`)).join('\n');
    }
    return joinParagraphs(base.concat([
      '把这三层依次落到具体材料上，摘要就成型了：' + (ctx.topic || '这件事') + '，可以先按这个顺序铺一遍再压字数。'
    ]), [2, 3]);
  }

  /* ══════════════════════════════════════════════════════════
   * 十、大纲语料
   * ══════════════════════════════════════════════════════════ */

  const OUTLINE_FRAMES = {
    psr: [
      ['开头：用一个具体的场景把问题摆出来', '不要从概念写起，先写一个读者认得的场面，让他觉得“说的就是我”。', ['场景：谁在什么时候遇到了什么麻烦', '把读者心里的那句话原样写出来']],
      ['问题：这件事为什么一直没解决', '把原因分成表层和深层两类，深层那一条才是文章的立足点。', ['表层原因：时间、资源、方法', '深层原因：标准不清或没人拍板']],
      ['分析：把问题拆成可以动手的几块', '拆到每一块都能单独处理为止，避免停在“要重视”这种话上。', ['第一块是什么，界线在哪', '第二块和第一块的关系']],
      ['结论：给出可以照着做的动作', '落到动作上，写清谁做、什么时候做、做到什么程度。', ['动作一与完成标准', '动作二与完成标准']],
      ['收尾：把话收在一句能记住的句子上', '不要再总结一遍全文，给一句话或一个画面就够了。', ['一句总结性的话', '一个能立住的画面']],
    ],
    timeline: [
      ['第一阶段：动手之前的准备', '写清开始之前必须准备好的东西，这一步最容易被跳过。', ['要准备什么东西', '准备到什么程度算够']],
      ['第二阶段：第一次跑通', '重点写第一次做的时候会遇到什么，怎么把标准定下来。', ['第一次怎么起步', '第一次容易在哪里出错']],
      ['第三阶段：形成习惯', '写清怎么从“偶尔做”变成“每次都做”，这一段是文章的重点。', ['怎么让它变成固定动作', '遇到意外怎么不中断']],
      ['第四阶段：回头复盘', '给出复盘的看点和频次，让前面的做法能留下来。', ['复盘看哪几个点', '多久复盘一次']],
      ['收尾：把节奏交给时间', '把全文收在节奏上，而不是再讲一遍方法。', ['一句能立住的话', '一个具体的下一步']],
    ],
    modules: [
      ['模块一：把标准说清楚', '这一段解决“做到什么程度算完”的问题，是所有后续的前提。', ['标准要写到多细', '谁来定这个标准']],
      ['模块二：把流程排顺', '写清顺序和节点，重点讲哪一步不能省。', ['关键节点有哪几个', '哪一步最容易返工']],
      ['模块三：把沟通对齐', '这一段讲人和人之间的部分，多数问题出在这里。', ['信息怎么同步', '分歧怎么收口']],
      ['模块四：把结果留下来', '写清怎么沉淀，让下一次不用从头再来。', ['留下什么形式的东西', '谁负责维护']],
      ['收尾：几块拼起来的样子', '把前面几块合起来描述一遍，给读者一个完整印象。', ['整体节奏一句话', '从哪一块先动']],
    ],
    story: [
      ['开场：一个具体的人，一件具体的事', '从一个真实感的场景切入，不要先讲道理。', ['这个人是谁，在做什么', '那一刻他遇到了什么']],
      ['转折：事情卡在了哪里', '把矛盾和代价写实，读者才会往下看。', ['卡住的那一步是什么', '为此付出了什么代价']],
      ['变化：他换了哪种做法', '写清转折的动作，越具体越好。', ['换了哪一步做法', '换完之后发生了什么']],
      ['提炼：从这件事里能带走什么', '把个案抬成通用的做法，但不要说教。', ['可以复用的做法', '什么情况下不适用']],
      ['收尾：回到人的身上', '收在人的状态上，比收在道理上更有余味。', ['现在的状态', '一句留给读者的话']],
    ],
  };

  const GENRE_NOTE = {
    article: '公众号长文：开头要有钩子，中段要有递进，结尾留一句能被记住的话。',
    report: '工作报告：结论在前，依据在后，凡是判断都要给出数据或事实。',
    speech: '演讲稿：句子要短，读出来要顺，多用“你”和“我们”，关键处可以重复一次。',
    lesson: '教学讲义：先讲目标，再讲做法，最后留一道练习，学员能自己验证。',
  };

  /* 一句话说明每个要点写什么。不引用要点原文——要点本身常是"把……写出来"这类指令，
     直接嵌进句子会读成绕口令。 */
  const WRITE_NOTES = [
    () => '写什么：这一层给一个具体的例子，让读者能对上自己的情况。',
    () => '写什么：接上一条，补上适用条件和边界。',
    () => '写什么：这一层只讲一件事，写清做法和判断标准。',
    () => '写什么：用一个真实的小案例说明，别停在结论上。',
    () => '写什么：这一层写两到三句就够，写完回读一遍顺不顺。',
  ];

  function composeOutline(p, mode, angle, ctx, target) {
    const genre = ctx.fields.genre || 'article';
    const frames = OUTLINE_FRAMES[angle.id] || OUTLINE_FRAMES.psr;
    const lines = [];
    const cn = ['一', '二', '三', '四', '五', '六', '七', '八'];
    const topic = ctx.topic;
    const noteStart = Math.floor(ctx.rnd() * WRITE_NOTES.length);
    // 短篇幅就只立骨架：一级标题三到五个、二级要点一到两个，别把大纲写成正文
    const sectionCount = Math.min(frames.length, target <= 280 ? 2 : target <= 640 ? 4 : 5);
    const subCount = target <= 280 ? 1 : 2;

    frames.slice(0, sectionCount).forEach((frame, i) => {
      lines.push(`${cn[i] || i + 1}、${i === 0 ? `${topic}｜${frame[0]}` : frame[0]}`);
      lines.push(`　　${frame[1]}`);
      (frame[2] || []).slice(0, subCount).forEach((sub, j) => {
        lines.push(`　　${i + 1}.${j + 1} ${sub}`);
        const note = WRITE_NOTES[(noteStart + i + j) % WRITE_NOTES.length](sub);
        lines.push(`　　　　${note}`);
      });
      lines.push('');
    });
    if (target > 280) lines.push(`文体提示：${GENRE_NOTE[genre] || GENRE_NOTE.article}`);

    let text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const lead = toneLead(ctx);
    if (lead) text += `\n\n写作提示：${lead}`;
    // 篇幅没到就把写法提示补上：大纲本来也该带这几句提醒
    if (charCount(text) < target * 0.7) {
      text += '\n\n补充说明：\n' + poolLines([
        `一、写作前先想清楚一件事：这篇{kw}要写给谁看，看完他该有什么变化。`,
        '二、每一级标题下都写一句“这一段写什么”，写不出的段落通常不需要保留。',
        '三、一级标题控制在三到五个，超过五个说明主线还没找到。'
      ], ctx).join('\n');
    }
    return text;
  }

  /* ══════════════════════════════════════════════════════════
   * 十一、入口：compose
   * ══════════════════════════════════════════════════════════ */

  /** 没素材时的通用起稿：宁可给一段关于"怎么写"的实话，也不给空壳模板 */
  function composeFallback(p, mode, angle, ctx, target) {
    const pools = {
      continue: [
        '写东西最难的往往是第一句。',
        '把脑子里那团模糊的东西挑一个具体的点写下来——一个时间、一个人、一句原话，句子就自己往下走了。',
        '不要一上来就交代背景。先让读者看见一个画面，再告诉他这是怎么回事。',
        '段落别写太长，一段只说一件事，说完就换行。',
        '形容词能删就删，动词要留够：写“他把杯子放下”，比写“他心情很复杂”有用得多。',
        '写完一段回头念一遍，念着卡住的地方，读者多半也会卡住。'
      ],
      rewrite: [
        '把一段话改清楚，通常要动三处：删掉多余的修饰，把长句拆成两句，把结论放到前面。',
        '先说结论，再说理由，最后说怎么做。',
        '同一个意思换一种说法，读者读起来会轻松很多。',
        '能用一个动词说清的，不要用“进行”“作出”这类结构绕一圈。',
        '如果一句话要读两遍才明白，那它就该重写。'
      ],
      copywriting: [
        '先说结论：它解决的是我每天都在遇到的那点麻烦。',
        '我不太会用形容词夸东西，就说三件我实际在意的：好不好用、费不费时间、值不值这个价。',
        '好用的东西不需要解释太久，用一次就知道了。',
        '如果你也遇到过同样的事，可以试试看。'
      ],
    };
    const blocks = poolLines(pools[mode.id] || pools.continue, ctx);
    const kept = fitTarget(blocks, target, []);
    if (mode.id === 'copywriting') {
      return kept.join('\n') + '\n\n#' + ctx.kw + ' #好物推荐';
    }
    return joinParagraphs(kept, [2, 3, 2]);
  }

  function seedFor(p, src, versionIndex) {
    return [p.mode, p.tone, p.length, p.creativity, versionIndex, src].join('|');
  }

  /** 目标篇幅：改写与摘要不该比原文长太多，其余模式按用户选的字数来 */
  function targetOf(p, mode, srcLen) {
    if (mode.id === 'summary') return Math.min(p.chars, Math.max(140, Math.round(srcLen * 0.8)));
    if (mode.id === 'rewrite') return Math.min(p.chars, Math.max(120, Math.round(srcLen * 1.25)));
    return p.chars;
  }

  function compose(params, material, versionIndex) {
    const p = Modes.normalizeParams(params);
    const mode = Modes.getMode(p.mode);
    const index = Math.max(0, Math.floor(Number(versionIndex) || 0));
    const angle = Modes.angleOf(mode, index);
    const src = squash(typeof material === 'string' ? material : (material && material.input) || '');
    const rnd = seededRandom(seedFor(p, src, index));
    const ctx = makeCtx(p, mode, angle, src, rnd);
    const target = targetOf(p, mode, src.length);

    if (!src && mode.id !== 'copywriting' && mode.id !== 'outline' && mode.id !== 'summary' && mode.id !== 'email') {
      return composeFallback(p, mode, angle, ctx, target);
    }

    let text;
    if (mode.id === 'continue') text = composeContinue(p, mode, angle, ctx, target);
    else if (mode.id === 'rewrite') text = composeRewrite(p, mode, angle, ctx, target);
    else if (mode.id === 'copywriting') text = composeCopywriting(p, mode, angle, ctx, target);
    else if (mode.id === 'email') text = composeEmail(p, mode, angle, ctx, target);
    else if (mode.id === 'summary') text = composeSummary(p, mode, angle, ctx, target);
    else text = composeOutline(p, mode, angle, ctx, target);

    if (!text || !text.trim()) return composeFallback(p, mode, angle, ctx, target);
    return text;
  }

  /* ══════════════════════════════════════════════════════════
   * 十二、校对：polish
   * ══════════════════════════════════════════════════════════ */

  const POLISH_TYPES = ['grammar', 'collocation', 'wording', 'punct', 'order', 'redundant', 'tone', 'typo'];

  function countOccurrences(text, sub) {
    if (!sub) return 0;
    let n = 0;
    let i = 0;
    while ((i = text.indexOf(sub, i)) >= 0) {
      n += 1;
      i += sub.length;
    }
    return n;
  }

  const BOUNDARY = '，。！？；：、\n\r 　（“”「」';

  /** 以标点为界把匹配扩成一个像样的片段：界面上显示"我们进行了一次讨论。"比显示"进行了"好读 */
  function clauseSpan(text, index, matchLen, replacement) {
    let s = index;
    let e = index + matchLen;
    while (s > 0 && BOUNDARY.indexOf(text[s - 1]) < 0 && index - s < 18) s -= 1;
    while (e < text.length && BOUNDARY.indexOf(text[e]) < 0 && e - (index + matchLen) < 18) e += 1;
    if (e < text.length && '，。！？；：'.indexOf(text[e]) >= 0) e += 1;
    const before = text.slice(s, e);
    if (before.length < 2 || before.length > 40) return null;
    if (countOccurrences(text, before) !== 1) return null;
    const offset = index - s;
    return { before, after: before.slice(0, offset) + replacement + before.slice(offset + matchLen), start: s };
  }

  /** 扩到唯一：加不加标点都不唯一时，退化成左右各补几个字 */
  function paddedSpan(text, index, matchLen, replacement) {
    for (let pad = 1; pad <= 10; pad += 1) {
      const s = Math.max(0, index - pad);
      const e = Math.min(text.length, index + matchLen + pad);
      const before = text.slice(s, e);
      if (before.length >= 2 && before.length <= 40 && countOccurrences(text, before) === 1) {
        const offset = index - s;
        return { before, after: before.slice(0, offset) + replacement + before.slice(offset + matchLen), start: s };
      }
    }
    return null;
  }

  function makeSpan(current, index, matchLen, replacement) {
    return clauseSpan(current, index, matchLen, replacement) || paddedSpan(current, index, matchLen, replacement);
  }

  /**
   * 选一个"在原文里唯一且当前还找得到"的片段。
   * 句子前面已经改过时整句锚点会失效，这时退回到短锚点，别整条规则都放弃。
   */
  function pickSpan(state, index, matchLen, replacement) {
    const candidates = [
      clauseSpan(state.current, index, matchLen, replacement),
      paddedSpan(state.current, index, matchLen, replacement),
    ];
    for (let i = 0; i < candidates.length; i += 1) {
      const span = candidates[i];
      if (!span) continue;
      if (countOccurrences(state.original, span.before) !== 1) continue;
      if (state.current.slice(span.start, span.start + span.before.length) !== span.before) continue;
      return span;
    }
    return null;
  }

  function applySpan(state, span, type, reason) {
    state.current = state.current.slice(0, span.start) + span.after + state.current.slice(span.start + span.before.length);
    state.rewrites.push({ before: span.before, after: span.after, type, reason });
  }

  /* 每一条规则都要能说出"为什么改"；改不动的宁可不改 */
  const RULES = [
    {
      // 只重排"动量词"（一次/一场）：「作出一个决定」重排成"决定了一个"是错的
      type: 'redundant', reason: '去掉多余的"进行"',
      find: /(进行|作出|加以|予以)(了|过)(一次|一场|一番|一下)?((?!一[个种项些])[\u4e00-\u9fa5]{2,4})(?=[，。！？、；：\s]|$)/g,
      replace: (m, verb, aux, quant, word) => word + aux + (quant || ''),
    },
    {
      type: 'redundant', reason: '去掉多余的"基本上""都"',
      find: /(基本上|实际上|事实上)都/g, replace: '都',
    },
    {
      type: 'redundant', reason: '去掉多余的量词',
      find: /(作出|做出|进行|加以|予以)(了|过)?(一个|一种|一项)(?=[\u4e00-\u9fa5]{2})/g,
      replace: (m, verb, aux) => verb + (aux || ''),
    },
    {
      type: 'redundant', reason: '重复的字删一个',
      find: /(的|了|是|在|和|就|也|都|着|地|得|要|很|更|太)\1/g,
      replace: (m, ch) => ch,
    },
    {
      type: 'tone', reason: '程度副词堆叠',
      find: /(非常|十分|特别|相当|真的|极其)\1/g,
      replace: (m, ch) => ch,
    },
    {
      type: 'collocation', reason: '搭配用"提升"',
      find: /提高(了)?(水平|能力|效率|质量|素养|形象|体验|标准)/g,
      replace: (m, aux, w) => '提升' + (aux || '') + w,
    },
    {
      type: 'collocation', reason: '搭配用"提高"',
      find: /增加(效率|水平|能力|质量)/g, replace: (m, w) => '提高' + w,
    },
    {
      type: 'collocation', reason: '搭配用"降低"',
      find: /减少(成本|风险|开支|损耗|负担)/g, replace: (m, w) => '降低' + w,
    },
    {
      type: 'grammar', reason: '副词修饰动词用"地"',
      find: /(不断|认真|仔细|努力|积极|严格|逐渐|有效|全面|顺利|明显|极大|深刻|妥善|彻底)的(?=(?!成果|结果|过程|时候|方法|方式|态度|表现|程度|东西|问题|目标|方向|能力|水平|原因|内容|部分|情况|人|事)[\u4e00-\u9fa5]{2})/g,
      replace: (m, w) => w + '地',
    },
    {
      type: 'grammar', reason: '补语用"得"',
      find: /(写|做|讲|干|跑|看|听|想|学|画|唱|办|完成|处理|表达|落实|发挥|表现)的(?=(很好|不错|很快|很慢|太快|太慢|清楚|明白|到位|漂亮|干净|流畅|顺利|扎实|透彻))/g,
      replace: (m, w) => w + '得',
    },
    /* 错别字表：只收确凿的，模棱两可的一律不进 */
    { type: 'typo', reason: '"作为"是规范写法', find: /做为/g, replace: '作为' },
    { type: 'typo', reason: '"其他"是规范写法', find: /其它/g, replace: '其他' },
    { type: 'typo', reason: '"即使"不是"既使"', find: /既使/g, replace: '即使' },
    { type: 'typo', reason: '应为"按捺不住"', find: /按耐不住/g, replace: '按捺不住' },
    { type: 'typo', reason: '应为"按捺不住"', find: /安奈不住/g, replace: '按捺不住' },
    { type: 'typo', reason: '应为"截至"', find: /截止(目前|现在|今天|上周|本周|月底|年底|为止)/g, replace: (m, w) => '截至' + w },
    { type: 'typo', reason: '应为"截至"', find: /截止到/g, replace: '截至' },
    { type: 'typo', reason: '应为"反映情况"', find: /反应(问题|情况|意见|诉求|困难|事实)/g, replace: (m, w) => '反映' + w },
    { type: 'typo', reason: '应为"竟然"', find: /竞然/g, replace: '竟然' },
    { type: 'typo', reason: '应为"好像"', find: /好象/g, replace: '好像' },
    { type: 'typo', reason: '应为"青睐"', find: /亲睐/g, replace: '青睐' },
    { type: 'typo', reason: '应为"迫不及待"', find: /迫不急待/g, replace: '迫不及待' },
    { type: 'typo', reason: '应为"走投无路"', find: /走途无路/g, replace: '走投无路' },
    { type: 'typo', reason: '应为"再接再厉"', find: /再接再励/g, replace: '再接再厉' },
    { type: 'typo', reason: '规范写法是"账号"', find: /帐号/g, replace: '账号' },
    { type: 'typo', reason: '规范写法是"须知"', find: /需知(?=[，。；：！？]|$)/g, replace: '须知' },
    { type: 'typo', reason: '"品位"指审美层次', find: /品味(很高|不高|很高吗|提升了)/g, replace: (m, w) => '品位' + w },
    { type: 'wording', reason: '"必须"表必要', find: /必需(完成|注意|说明|确认|保证|处理|参加)/g, replace: (m, w) => '必须' + w },
    { type: 'wording', reason: '去掉多余的口头禅', find: /其实(我)?(觉得|认为)/g, replace: (m, who) => (who || '我') + '觉得' },
    { type: 'wording', reason: '"可以说"是赘语', find: /可以说(?=[，,])/g, replace: '' },
    {
      type: 'punct', reason: '中文里应用全角标点',
      find: /([\u4e00-\u9fa5])\s*([,;:.?!])\s*(?=[\u4e00-\u9fa5])/g,
      replace: (m, ch, punc) => ch + ({ ',': '，', ';': '；', ':': '：', '.': '。', '?': '？', '!': '！' })[punc],
    },
    {
      type: 'punct', reason: '句末应用全角句号',
      find: /([\u4e00-\u9fa5])\s*([.?!])\s*$/g,
      replace: (m, ch, punc) => ch + ({ '.': '。', '?': '？', '!': '！' })[punc],
    },
    { type: 'punct', reason: '中文里应用全角括号', find: /([\u4e00-\u9fa5])\(/g, replace: '$1（' },
    { type: 'punct', reason: '中文里应用全角括号', find: /\)(?=[\u4e00-\u9fa5])/g, replace: '）' },
    {
      type: 'punct', reason: '连用标点收敛成一个',
      find: /[！!？?]{2,}/g,
      replace: (m) => (m.indexOf('？') >= 0 || m.indexOf('?') >= 0 ? '？' : '！'),
    },
    { type: 'punct', reason: '省略号写作"……"', find: /\.{3,}|。{3,}|·{3,}/g, replace: '……' },
    { type: 'punct', reason: '中文之间不留空格', find: /([\u4e00-\u9fa5])[ \t]+(?=[\u4e00-\u9fa5])/g, replace: '$1' },
    { type: 'punct', reason: '引号统一用中文引号', find: /"([\u4e00-\u9fa5][^"\n]{0,28})"/g, replace: (m, inner) => '“' + inner + '”' },
    {
      type: 'punct', reason: '两种引号风格混用',
      when: (t) => t.indexOf('“') >= 0 && t.indexOf('「') >= 0,
      find: /「([^「」\n]{1,30})」/g,
      replace: (m, inner) => '“' + inner + '”',
    },
    { type: 'punct', reason: '书名号统一用《》', find: /〈([\u4e00-\u9fa5]{1,20})〉/g, replace: (m, inner) => '《' + inner + '》' },
  ];

  /** 一句里三个"然后"这类口头禅，正则不好表达，单独走一遍 */
  function ruleThenChain(state) {
    const text = state.current;
    const sentences = splitSentences(text);
    for (let i = 0; i < sentences.length; i += 1) {
      const s = sentences[i];
      const positions = [];
      let at = s.indexOf('然后');
      while (at >= 0) {
        positions.push(at);
        at = s.indexOf('然后', at + 2);
      }
      if (positions.length < 3) continue;
      const base = text.indexOf(s);
      if (base < 0) continue;
      const span = pickSpan(state, base + positions[1], 2, '接着');
      if (!span) continue;
      applySpan(state, span, 'wording', '一句里“然后”太多');
      return true;
    }
    return false;
  }

  /** 一句话里堆了三四个程度副词时，删掉一个 */
  function ruleAdverbStack(state) {
    const adverbs = ['非常', '十分', '特别', '相当', '极其', '格外', '真的', '很'];
    const sentences = splitSentences(state.current);
    for (let i = 0; i < sentences.length; i += 1) {
      const s = sentences[i];
      const hits = [];
      adverbs.forEach((w) => {
        let at = s.indexOf(w);
        while (at >= 0) {
          hits.push({ at, w });
          at = s.indexOf(w, at + w.length);
        }
      });
      if (hits.length < 3) continue;
      hits.sort((a, b) => a.at - b.at);
      const base = state.current.indexOf(s);
      if (base < 0) continue;
      const span = pickSpan(state, base + hits[1].at, hits[1].w.length, '');
      if (!span) continue;
      applySpan(state, span, 'tone', '程度副词堆叠');
      return true;
    }
    return false;
  }

  function runRule(state, rule) {
    if (rule.when && !rule.when(state.current)) return false;
    const text = state.current;
    const re = new RegExp(rule.find.source, rule.find.flags.indexOf('g') >= 0 ? rule.find.flags : rule.find.flags + 'g');
    const build = typeof rule.replace === 'function'
      ? rule.replace
      : (m) => m.replace(rule.find, rule.replace);
    let m = re.exec(text);
    let guard = 0;
    while (m && guard < 200) {
      guard += 1;
      const whole = m[0];
      const replacement = build.apply(null, m);
      if (replacement === whole) {
        if (re.lastIndex === m.index) re.lastIndex += 1;
        m = re.exec(text);
        continue;
      }
      // before 必须在"原文"里唯一出现，否则界面上定位不到，宁可不改
      const span = pickSpan(state, m.index, whole.length, replacement);
      if (!span) {
        m = re.exec(text);
        continue;
      }
      applySpan(state, span, rule.type, rule.reason);
      return true;
    }
    return false;
  }

  /**
   * 规则化中文校对。
   * 每条 before 都能在原文里唯一找到——界面要靠它做高亮定位。
   * 原文没有问题时，rewrites 为空、polished 与原文完全一致。
   */
  function polish(text) {
    const original = plain(text);
    const state = { original, current: original, rewrites: [] };
    if (!original.trim()) return { polished: original, rewrites: [] };

    // 一轮只改一处，改完从头再扫：这样每条 before 都还能在原文里定位
    for (let round = 0; round < 60; round += 1) {
      let changed = false;
      for (let i = 0; i < RULES.length && !changed; i += 1) {
        changed = runRule(state, RULES[i]);
      }
      if (!changed) changed = ruleThenChain(state) || ruleAdverbStack(state);
      if (!changed) break;
    }

    return { polished: state.current, rewrites: state.rewrites };
  }

  /* ══════════════════════════════════════════════════════════
   * 十三、导出
   * ══════════════════════════════════════════════════════════ */

  return {
    compose,
    polish,
    keyPoints,
    seededRandom,
    // 以下辅助函数给测试和上层复用
    hashText,
    mulberry32,
    analyze,
    keywords: (text, max) => {
      const info = analyze(text);
      return info.kws.slice(0, max || info.kws.length);
    },
    numberTokens,
    topicOf,
    splitSentences,
    charCount,
    clipSoft,
    joinParagraphs,
    fitTarget,
    voiceOf,
    POLISH_TYPES,
    cleanPoint,
  };
});
