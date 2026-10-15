/*! 三易 · 智能写作台 —— 离线写作引擎（mock-writer.js）
 *
 * 没配大模型 Key 时，服务端把同一个请求转到这儿：模式、角度、语气、篇幅都不变，
 * 用纯规则 + 素材特征拼出一篇能直接用的中文稿，保证演示时十个内置模式都有像样的产出。
 * 其中翻译（translate）与自定义模板（tpl_xxx）离线引擎做不到，这类请求返回的是
 * 「如实说明 + 原样保留的原文」——假装译过或拿内置模式的稿子充数，比承认做不到更糟。
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
    /* 学术论文的四种语气 */
    rigorous: { prefer: ['在一定程度上', '可以认为', '口径', '边界', '关联', '稳健', '有待'], particle: '' },
    critical: { prefer: ['不足', '停留', '忽略', '高估', '低估', '难以', '分歧'], particle: '' },
    applied: { prefer: ['实践', '落地', '可操作', '成本', '决策', '问题'], particle: '' },
    /* 工作报告的四种语气 */
    bluf: { prefer: ['结论', '待决策', '需要拍板', '依据'], particle: '' },
    data: { prefer: ['数据', '口径', '来源', '指标', '记录'], particle: '' },
    /* 小说的四种语气 */
    restrained: { prefer: ['停', '没有', '不动', '站', '抬手', '收回去'], particle: '' },
    lyric: { prefer: ['雨', '光', '影子', '风', '慢慢', '一层'], particle: '' },
    tense: { prefer: [], particle: '', short: true },
    light: { prefer: ['笑', '半圈', '顺手', '又'], particle: '' },
    /* 翻译的四种语气（离线引擎不译，只影响说明里的口径） */
    literal: { prefer: [], particle: '' },
    natural: { prefer: [], particle: '' },
    localized: { prefer: [], particle: '' },
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
    academic: '这项研究关注的问题',
    report: '这次要汇报的事',
    fiction: '这个故事',
    translate: '这段原文',
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

  /**
   * 按语气"挑选"句子，但保持原来的先后次序。
   * 论文、报告这类文本，句子顺序本身就是论证（背景→缺口→问题），
   * 像续写那样整池重排会把论证打散，所以这里只换内容、不动顺序。
   */
  function selectByTone(rnd, sentences, voice, want) {
    const list = sentences || [];
    const scored = list.map((s, i) => {
      let score = rnd() * 0.35;
      (voice.prefer || []).forEach((w) => {
        if (s.indexOf(w) >= 0) score += 1;
      });
      if (voice.short) score += Math.max(0, (40 - charCount(s)) / 60);
      return { s, score, i };
    });
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    const keep = Math.max(1, Math.min(list.length, want || list.length));
    return scored.slice(0, keep).map((o) => o.i).sort((a, b) => a - b).map((i) => list[i]);
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
   * 十一、学术论文语料（academic）
   * ══════════════════════════════════════════════════════════ */

  /* 学术写作的四条硬规矩，决定了下面的语料为什么长这样：
     1. 不编文献、不编数据、不编作者与期刊：需要引用的地方一律写「（相关研究，年份）」，
        再补一句提醒，把补出处的活留给用户；
     2. 不写「综上所述」「值得注意的是」这类空转句，每一句都要给出可核查的内容；
     3. 一切数量表述只走 {num} 槽位，数值来自素材；素材没给就整句丢掉，不替用户估；
     4. 用科研写作的常规说法（样本量、编码、口径、稳健性），不堆形容词。 */

  const ACADEMIC_SECTION_LABEL = {
    abstract: '摘要',
    intro: '引言',
    review: '文献综述',
    method: '研究方法',
    result: '结果与讨论',
    conclusion: '结论与展望',
  };

  const ACADEMIC_GENRE_LABEL = { journal: '期刊论文', thesis: '学位论文', conference: '会议论文' };

  /* 每个部分的第一句：角度不同，起点就不同 */
  const ACADEMIC_OPEN = {
    abstract: {
      structure: ['摘要：本研究以用户提供的材料为基础，围绕{kw}讨论它的表现形态、影响条件与适用范围。'],
      dialogue: ['摘要：围绕{kw}，既有讨论存在两种解释，本研究说明它们各自成立的条件。'],
      evidence: ['摘要：本研究以用户提供的材料为唯一证据来源，回答与{kw}相关的问题。'],
      limits: ['摘要：本研究只回答材料能够支持的部分，适用范围写在结尾。'],
    },
    intro: {
      structure: ['这一部分先交代{kw}的边界与研究缺口，再说明本研究的落点。'],
      dialogue: ['关于{kw}，已有研究分成方向相近而结论不同的两支，本文从这里接下去。'],
      evidence: ['讨论{kw}之前，先把可以核查的材料交代清楚。'],
      limits: ['这一部分要说明的是：本文能回答什么，以及在什么范围内回答。'],
    },
    review: {
      structure: ['这一部分按时间维度梳理{kw}的既有研究，再说清分歧出在哪里。'],
      dialogue: ['把{kw}的既有研究放在一起看，分歧比共识更值得说明。'],
      evidence: ['既有研究的证据等级差别很大，先按材料类型分开看。'],
      limits: ['综述范围限定在与{kw}直接相关的讨论，边缘问题只在必要时提及。'],
    },
    method: {
      structure: ['研究设计按四个要素说明：对象、工具、步骤、变量。'],
      dialogue: ['在方法上，本研究沿用本领域通行的做法，差别只在编码规则。'],
      evidence: ['材料的来源与处理方式是这一部分的重点，交代清楚之后再谈分析。'],
      limits: ['方法上的边界提前说明：本研究能够测量的范围是有限的。'],
    },
    result: {
      structure: ['结果按先事实、后解释的顺序展开。'],
      dialogue: ['这一部分把本研究的发现放回既有判断中比较。'],
      evidence: ['先给出材料本身的记录，再做分组对照与稳定性检查。'],
      limits: ['结果的适用范围在讨论里一并说明，不外推到材料之外。'],
    },
    conclusion: {
      structure: ['结论部分回到开篇提出的问题，逐一给出材料能够支持的回答。'],
      dialogue: ['本文的判断与既有研究的关系需要说明：补充多于推翻。'],
      evidence: ['结论的每一条都对应材料中的记录，其余留作待补。'],
      limits: ['结论之后紧接局限与展望，这两部分写在一起。'],
    },
  };

  const ACADEMIC_BODY = {
    abstract: [
      '与既有讨论相比，本文把重点放在条件的可检验性上，而不是重复描述现象。',
      '方法上以材料为基础：先界定核心概念与观察指标，再按统一规则编码，最后做分组对照。',
      '分析分两步：先给出材料中的分布，再检查结论对测量口径变化的敏感性。',
      '结果显示，材料中与{kw}有关的几个指标之间存在稳定关联，关联的方向与已有判断一致。',
      '强度上的差别大于方向上的差别，这部分差异更可能来自测量口径。',
      '结论是：在材料覆盖的范围内可以支持上述判断，超出这个范围需要新的证据。',
      '本研究的限度在于样本构成与观察窗口，下一步应补充纵向材料与外部样本的验证。',
    ],
    intro: [
      '近十余年间，围绕{kw}的讨论从现象描述转向机制解释，但概念的边界始终不统一。',
      '在这一领域里，与{kw}相关的现象常被当作结果来处理，较少讨论它作为过程的性质。',
      '实践中的变化让问题变得更具体：讨论的对象从“要不要做”变成了“怎样才能站得住”。',
      '既有研究提供了不少描述性材料，但在因果方向的判断上仍存在分歧。',
      '分歧的来源不只在于样本：测量工具、观察窗口与编码规则都存在系统差别。',
      '有一个环节被普遍跳过：不同研究在用同一份材料回答不同的问题。',
      '本研究要回答三个层次的问题：与{kw}相关的现象呈什么形态、哪些条件影响它、这些条件怎样起作用。',
      '本文的立场是把判断限定在材料能够支撑的范围内，需要外推的地方单独标出。',
      '与以往研究的差别在于，本研究把测量口径作为分析对象之一。',
      '这项工作的价值未必在于给出新结论，而在于让已有的分歧变得可以检验。',
      '把讨论范围收窄之后，问题就从“有没有关系”变成了“关系在什么条件下成立”。',
    ],
    review: [
      '关于{kw}的研究大致可以归为三类，划分标准是研究者如何处理时间维度。',
      '第一类研究把与{kw}相关的现象视为静态结果，用截面材料比较不同群体之间的差异。',
      '第二类研究引入过程视角，关注它在不同阶段的形态变化，代价是观察规模普遍偏小。',
      '第三类研究转向机制，试图说明中间环节如何起作用，目前仍以个案为主。',
      '从结论看，三类的方向大体一致，分歧集中在强度与适用条件上。',
      '分歧的来源不止在样本：测量工具、编码规则与统计口径也存在系统差别。',
      '一个尚未解决的问题是，多数研究把自陈材料与行为记录当作可以互换的证据。',
      '把两类证据分开处理，比强行合并更稳妥，本文采用前一种做法。',
      '既有综述多以主题归类，较少讨论不同测量口径之间能不能换算。',
      '按照这条脉络，{kw}的讨论正在从“是否存在”转向“在什么条件下更强或更弱”。',
      '上述归类基于本领域常用的划分方式，换成另一个标准可以得到另一种分法。',
    ],
    method: [
      '研究采用与{genreLabel}体例相符的设计：以材料中的对象为分析单位，按统一口径编码后做对照。',
      '核心概念沿用本领域较为通行的界定，操作化时把它拆成三个可观察的指标。',
      '材料中可以直接引用的记录包括{num}，本研究按原样引用，未做换算。',
      '编码分两轮：第一轮按预设类目，第二轮针对无法归类的部分补充类目并回头重编。',
      '为保证一致性，同一份材料按同一套规则重复编码一次，不一致的地方单独记录。',
      '分析分为两步：先给出分布，再做分组对照，最后检查结论对口径变化的敏感性。',
      '变量的测量尽量使用材料中的原始记录，避免在编码阶段引入研究者的判断。',
      '涉及因果的表述一律写成关联，除非材料能够支持时间先后。',
      '方法上的局限先说明一次：观察窗口有限，横断面设计无法排除反向因果。',
      '材料涉及的个人信息在整理时做了去标识处理，引用原话时只保留与研究问题相关的部分。',
      '材料的规模与口径以原始记录为准；本研究不补估缺失的取值，缺的地方标注出来。',
      '为减少判断的随意性，所有编码都保留原始出处，便于他人复核。',
    ],
    result: [
      '结果先从描述性信息说起：就{kw}而言，材料中的记录分布并不均匀，集中出现在观察窗口的后半段。',
      '分组对照显示，差异的方向与预期一致，幅度小于既有研究的估计。',
      '与既有研究一致的是关联的方向，不一致的是强度，差异更可能来自测量口径。',
      '有一组结果不符合上述模式：个别材料的取值与整体趋势相反。',
      '把这几个例子单独看，它们共享一个特征：记录方式与其他材料不同。',
      '讨论部分对这两点给出解释：前者属于口径问题，后者更像是材料构成造成的。',
      '换一种口径重算一遍，主要结论没有变化，这一点提高了判断的可信度。',
      '稳健性检查只能说明结论对当前材料稳定，不能替代外部样本的验证。',
      '材料里出现的{num}这类记录，如果来自抽样就可以支持推广，如果不是就只能描述这批对象。',
      '还有一个解释没有被排除：观察到的关联可能来自同时变化的第三个因素。',
    ],
    conclusion: [
      '回到开篇提出的问题，材料能够支持的回答是：与{kw}有关的差异与条件相关，而这些条件是可观察的。',
      '这在理论上意味着把测量口径当作解释的一部分；在实践上，它意味着先统一口径再谈效果。',
      '本研究的局限有三条：样本的代表性、观察窗口的长度、以及关键变量依赖间接测量。',
      '这些局限不推翻结论，但划定了它的适用范围，超出范围需要重新检验。',
      '下一步可以沿两个方向推进：补充纵向材料，以及把编码规则放到另一批材料上复现。',
      '如果能做到复现，关于{kw}的分歧有可能收敛；在此之前，强判断都应当保留。',
      '对实践的建议只有一条：先把口径写下来，再比较结果，否则比较本身没有意义。',
      '本文没有解决的是因果方向的问题，这需要设计上的改变，而不是更多的材料。',
      '后续研究如果能把口径统一，现在的分歧至少有一部分会被证明是测量造成的。',
    ],
  };

  /* 四个角度的动线差异：结构、对话、证据、边界 */
  const ACADEMIC_ANGLE = {
    structure: [
      '按惯例先界定对象：这里讨论的{kw}限于材料覆盖的范围，暂不作推广。',
      '本文的论证分两层：先看材料内部是否一致，再看与已有判断的差别有多大。',
      '这一部分的小结只回答一个问题：现有证据支持到哪一步。',
    ],
    dialogue: [
      '与（相关研究，年份）的判断相比，本研究在测量口径上做了调整。',
      '把这一判断放回文献脉络里，它补充的是条件，而不是推翻既有结论。',
      '引用位置在此保留：（相关研究，年份）；具体文献需要你自己补上，这里不替你编造。',
      '既有讨论多停在这一步，本文多做的是一件事：把口径差异当作解释的一部分。',
    ],
    evidence: [
      '上面的每一步判断都能在材料里找到对应记录，没有把推测写成事实。',
      '凡涉及数量的表述都以材料中的原始记录为准，材料没有给的留作待补。',
      '换成另一种口径重算，结论的方向不变，幅度有变化。',
      '如果后续材料能支持时间先后，这里的关联才有条件改写为因果表述。',
    ],
    limits: [
      '上述判断有明确的边界：材料之外的对象、更早或更晚的时段，都需要重新检验。',
      '适用条件是观察窗口足够长、前后口径一致；条件不成立时，结论会更弱。',
      '结论的强度受测量方式限制：它描述的是关联，不是机制。',
      '推广之前需要新的样本；在此之前，这里给出的只是一个有条件成立的判断。',
    ],
  };

  const ACADEMIC_CLOSE = {
    abstract: ['结论只覆盖材料能够支持的范围，推广需要新的证据。'],
    intro: ['后文按综述、方法、结果、结论的顺序展开，剩下的问题交给后面的部分回答。'],
    review: ['这些分歧也正是本文把测量口径作为分析对象的理由。'],
    method: ['按这套设计得到的结果写在下一部分，讨论随后展开。'],
    result: ['以上是材料支持的部分，其余解释放在讨论里，并标明各自的依据。'],
    conclusion: ['到这里可以收一下：剩下的工作属于下一轮研究。'],
  };

  /* 体例只改紧凑程度，不往正文里塞写作说明 */
  const ACADEMIC_GENRE_EXTRA = {
    journal: [],
    thesis: ['为使论证完整，这里把两轮编码中不一致的地方一并保留下来。', '学位论文的篇幅允许展开，因此把操作化的细节写全，方便复核。'],
    conference: ['与既有工作相比，本文的新意集中在一点：把测量口径当作分析对象。'],
  };

  /* 任何一个部分都可能用到的判断句：长篇幅时用来把论证铺开，
     不是套话——每一句都在说研究本身的方法与限度。 */
  const ACADEMIC_SHARED = [
    '口径一旦变了，同一批材料会得出不同的强度，这一点必须在结果里交代清楚。',
    '把判断限定在材料范围内不是保守，而是让结论可以被别人复现。',
    '需要引用的地方只留位置，具体文献由作者补上，避免出处出现差错。',
    '同一份材料在不同研究里的编码结果并不一致，这正是分歧的来源之一。',
    '本研究不打算给出普适的结论，只想把条件写清楚，让后来的研究可以检验。',
    '理论与经验在这里互相约束：概念决定看什么，材料决定能说什么。',
    '如果后续材料与现有判断冲突，需要修改的是判断，而不是记录。',
    '把不确定的地方写出来，比用模糊的措辞掩盖更诚实，也便于继续研究。',
    '这一部分的判断都可以被证伪：换一批材料、换一个口径，结论就可能变化。',
    '研究的时间跨度决定了能观察到什么，解释结果时要把这一点一并考虑。',
  ];

  const ACADEMIC_TONE = {
    rigorous: {
      prefer: ['在一定程度上', '可以认为', '口径', '边界', '关联'],
      lead: ['先把范围限定好：下面的判断只在材料能够支持的地方成立。'],
    },
    plain: {
      prefer: ['简单', '具体', '例子', '看得见'],
      lead: ['把话说简单一点：这件事的关键落在几个看得见的指标上。'],
    },
    critical: {
      prefer: ['不足', '停留', '忽略', '高估', '低估'],
      lead: ['既有研究在这一步上普遍做了简化，代价是结论之间的可比性。'],
    },
    applied: {
      prefer: ['实践', '落地', '可操作', '成本', '决策'],
      lead: ['从实际问题出发，这一部分要回答的是怎么做才不至于白做。'],
    },
  };

  function academicVoice(p, ctx) {
    const table = ACADEMIC_TONE[p.tone];
    if (!table) return ctx.voice;
    return {
      prefer: (table.prefer || []).concat(ctx.voice.prefer || []),
      lead: table.lead || [],
      short: ctx.voice.short,
    };
  }

  /** 数据驱动的角度：先摆材料里能核查的东西，再谈判断 */
  function academicEvidenceLines(ctx) {
    const out = [];
    if (ctx.nums.length) {
      out.push(`材料中可以直接核查的记录是：${ctx.nums.slice(0, 3).join('、')}，本文的判断以此为起点。`);
    }
    out.push('每一步判断都对应材料里的一条记录，没有把推测写成事实。');
    return out;
  }

  function academicDialogueLines() {
    return [
      '与（相关研究，年份）的判断相比，本研究在测量口径上做了调整。',
      '引用位置在此保留：（相关研究，年份）；具体文献需要你自己补上，这里不替你编造。',
    ];
  }

  function composeAcademic(p, mode, angle, ctx, target) {
    const section = ACADEMIC_SECTION_LABEL[ctx.fields.section] ? ctx.fields.section : 'intro';
    const genre = ACADEMIC_GENRE_LABEL[ctx.fields.genre] ? ctx.fields.genre : 'journal';
    const rnd = ctx.rnd;
    const voice = academicVoice(p, ctx);
    const actx = Object.assign({}, ctx, {
      genreLabel: ACADEMIC_GENRE_LABEL[genre],
      sectionLabel: ACADEMIC_SECTION_LABEL[section],
    });
    // 摘要有它自己的长度惯例（二百字上下），不跟着"短/中/长"档位放大；
    // 其余部分按体例缩放：学位论文铺得开，会议论文压得紧。
    const budget = section === 'abstract'
      ? Math.max(180, Math.min(260, Math.round(target * 0.9)))
      : Math.max(140, Math.round(target * (genre === 'thesis' ? 1.08 : genre === 'conference' ? 0.84 : 1)));

    const blocks = [];
    const openPool = (ACADEMIC_OPEN[section] || {})[angle.id] || (ACADEMIC_OPEN[section] || {}).structure || [];
    const open = pick(rnd, poolLines(openPool, actx));
    if (open) pushUnique(blocks, open);

    // 摘要是一段话，范围声明与领域说明这类交代不进摘要，正文里才需要
    if (section !== 'abstract') {
      const lead = pick(rnd, poolLines(voice.lead || [], actx));
      if (lead) pushUnique(blocks, lead);
      if (actx.fields.discipline) {
        pushUnique(blocks, `本部分所属领域为${clip(actx.fields.discipline, 16)}，术语与体例按该领域的通行做法处理。`);
      }
    }

    if (angle.id === 'evidence') {
      academicEvidenceLines(actx).forEach((s) => pushUnique(blocks, s));
    } else if (angle.id === 'dialogue') {
      academicDialogueLines().forEach((s) => pushUnique(blocks, s));
    }

    // 正文按原顺序读才成论证：语气只决定"先写哪几句"，不把顺序打散；
    // 长篇（900 字档）要求把这一部分的材料用尽，短篇才按语气挑重点。
    const bodyAll = poolLines(ACADEMIC_BODY[section], actx);
    const wantBody = budget >= 640 ? bodyAll.length : Math.max(3, Math.ceil(bodyAll.length * 0.62));
    const body = selectByTone(rnd, bodyAll, voice, wantBody);
    const rest = bodyAll.filter((s) => body.indexOf(s) < 0);
    // 挑剩的句子跟在正文后面而不是塞进"补白"，免得"结果先从描述性信息说起"这种
    // 本该开头的句子被排到最后去
    body.concat(rest).forEach((s) => pushUnique(blocks, s));

    const angleLines = poolLines(ACADEMIC_ANGLE[angle.id] || ACADEMIC_ANGLE.structure, actx);
    const genreExtra = poolLines(ACADEMIC_GENRE_EXTRA[genre] || [], actx);
    const shared = poolLines(ACADEMIC_SHARED, actx);
    if (budget >= 640) {
      shared.forEach((s) => pushUnique(blocks, s));
    }

    // 角度决定动线：局限角度把边界条件提到前面，证据角度先摆可核查的记录
    const groups = angle.id === 'limits' ? [angleLines.slice(0, 1), angleLines.slice(1), genreExtra]
      : angle.id === 'evidence' ? [genreExtra, angleLines]
        : angle.id === 'dialogue' ? [angleLines, genreExtra]
          : [genreExtra, angleLines];
    groups.forEach((group) => {
      group.forEach((s) => pushUnique(blocks, s));
    });

    // 摘要的关键词一行要在最后，所以它不进 fitTarget，单独接上
    const keywordLine = section === 'abstract' ? `关键词：${(actx.kws[0] || actx.kw)}；测量口径；分组对照；边界条件。` : '';
    const reserve = poolLines(ACADEMIC_CLOSE[section] || [], actx).concat(angleLines, shared);
    const kept = fitTarget(blocks, budget - charCount(keywordLine), reserve);
    if (!kept.length) return '';
    const text = (section === 'abstract' ? kept.join('') : joinParagraphs(kept, [2, 3, 3])) + keywordLine;
    return text;
  }

  /* ══════════════════════════════════════════════════════════
   * 十二、工作报告语料（report）
   * ══════════════════════════════════════════════════════════ */

  /* 报告的规矩同样硬：
     数字与时间只能来自素材，材料没给的写「（待补）」，不替用户估；
     每条要点先给结论再给依据；结尾一定是「下一步」，并留责任人占位。 */

  const REPORT_HEADING = {
    conclusion: '结论',
    decision: '待决策项',
    data: '数据与口径',
    risk: '问题与风险',
    next: '下一步',
    goal: '目标',
    progress: '主要进展',
    findings: '主要发现',
    problem: '要解决的问题',
    cause: '原因',
    suggestion: '建议',
    compare: '对比',
    trend: '趋势',
    reusable: '可复用的做法',
    items: '本期事项',
    todo: '待办',
  };

  /* 四个角度就是四套章节动线 */
  const REPORT_PLAN = {
    bluf: ['conclusion', 'decision', 'data', 'risk', 'next'],
    timeline: ['goal', 'progress', 'findings', 'risk', 'next'],
    psr: ['problem', 'cause', 'suggestion', 'next'],
    compare: ['compare', 'data', 'cause', 'next'],
  };

  /* 这几节适合先摆素材里的原话：报告的依据本来就是材料 */
  const REPORT_FACT_ROLES = { findings: 1, progress: 1, data: 1, compare: 1 };

  const REPORT_POOL = {
    conclusion: [
      '结论：从材料看，{kw}的推进是稳的，没有出现需要立刻止损的信号。',
      '结论：主要工作已经完成，剩下的部分以收尾与交付为主。',
      '结论：本期没有新增风险点，原有问题按既定办法在处理。',
      '结论：{kw}的问题不在执行速度，而在前置条件没有定清楚。',
      '结论：整体符合预期，偏差集中在需要多方确认的那几个环节。',
      '结论：可以按现有安排继续推进，不必调整大方向。',
    ],
    decision: [
      '需要拍板的是两件事：一是要不要按现有口径继续推进，二是资源的追加量。',
      '请确认：是否接受当前的时间安排；若不接受，请同时确认可以让出的范围。',
      '待决策项：口径统一的做法由谁定，定完之后谁负责在材料上落一遍。',
      '需要拍板的只有一处：收窄范围保证按期完成，还是保范围、接受顺延。',
      '需要你定的是牵头人：这件事涉及两个以上部门，没有牵头人会一直拖着。',
    ],
    data: [
      '数据来源：你提供的材料；{num}这一项按原文照录，没有做二次加工。',
      '涉及比率的判断都标了来源，没有来源的地方留空，避免出现看起来精确的假数字。',
      '统计口径与上期保持一致，换过口径的指标单独标注，便于横向比较。',
      '数据缺口已经列在下面，补齐之后结论可能需要修正。',
    ],
    risk: [
      '风险有两个：一是时间被压缩后质量下降，二是口径不统一导致返工。',
      '需要提醒的是资源占用：这件事会持续占用同一批人的时间。',
      '风险等级目前不高；如果确认环节继续拖，会传导到交付节点。',
      '还没有出现需要升级处理的信号，先按现有办法观察一个周期。',
      '最需要盯住的是依赖外部配合的那一步，它不受我们单方面控制。',
    ],
    goal: [
      '本期目标：把{kw}从讨论推进到可以重复执行的状态。',
      '开始之前定下的目标很清楚：先跑通一轮，再谈优化。',
      '目标分两条：一条看结果，一条看过程；后者用来判断做法能不能留下来。',
      '目标里有一条是硬约束：关键节点的完成时间不能往后挪。',
      '定目标时就把验收标准写上，避免最后各说各话。',
    ],
    progress: [
      '本期完成的部分：把{kw}的主流程走通了一遍，留下的记录可以直接复用。',
      '进展集中在两件事上：把标准写清楚，把责任人落到具体的人头上。',
      '已经完成的部分都有记录可查，材料里提到的每一步都有对应的产出。',
      '推进过程中做过一次调整，调整的理由与结果都写在依据部分。',
      '过程中投入的时间比计划多，多出来的部分主要花在确认环节。',
    ],
    findings: [
      '材料显示的{kw}相关信号方向一致，没有互相矛盾的记录。',
      '从材料看，卡点集中在准备环节，而不是执行环节。',
      '把材料里的记录按事项归类之后，重复出现的只有一类问题。',
      '真正占用时间的不是讨论本身，而是等待确认。',
      '同一件事在材料里被记了两次，两次的说法不完全一样，需要对齐。',
    ],
    problem: [
      '要解决的问题只有一个：{kw}到现在还没有一个所有人都认的执行口径。',
      '问题在于判断标准不统一：同一件事，不同的人用不同的尺子量。',
      '当前最需要处理的是等待时间过长，它挤占了后面的环节。',
      '如果这个问题不解决，后面每一步都要重新解释一遍。',
      '问题的表现是反复返工，根子在前面那一步没有定清楚。',
    ],
    cause: [
      '原因不在能力，在分工：没有人对结果负全责。',
      '原因有两个：一是标准没有写下来，二是例外情况没有指定处理人。',
      '根因是前置条件没有确认，导致后面的动作反复。',
      '从材料看，问题的来源更可能是流程设计，而不是执行力度。',
      '还有一层原因在于信息不同步：两边按不同的版本在做同一件事。',
    ],
    suggestion: [
      '对策是先定口径，再定人：口径写下来，责任人写在同一行。',
      '建议把例外情况单独列一张表，写明谁可以拍板、多久之内给答复。',
      '建议先在一个小范围里试跑，跑通之后再推广，避免一次性铺开。',
      '对策分两步：先止血，再优化；先做见效快的那一步。',
      '建议把确认环节的时间上限写进流程，超时默认按原方案执行。',
    ],
    compare: [
      '对比的结论是：差距不在投入多少，而在标准是否统一。',
      '横向对比看，{kw}的推进节奏比同类事项慢，慢在确认环节。',
      '纵向对比看，本期比上期稳定，波动主要来自计划外的临时事项。',
      '两边口径不一致，直接比较意义不大；先统一口径，再看差距。',
      '把可比的部分单独拿出来比，差距比看上去要小。',
    ],
    trend: [
      '趋势上，这类问题的处理方式正在从补漏转向前置。',
      '外部条件没有出现方向性变化，短期判断仍以现有条件为基础。',
      '如果当前条件延续，下一期的重点会从推进转到稳定。',
      '同类做法在变多，早一步形成标准的人会省下后面很多沟通成本。',
    ],
    reusable: [
      '可复用的做法：把标准写成模板，第一次慢，之后每一次都快。',
      '值得留下来的是那套记录方式，它让复盘有据可依。',
      '能复用的经验只有一条：把决定写在事情发生之前。',
      '这次有效的做法是提前一周对齐，下个项目可以照搬。',
    ],
    items: [
      '第一件事：把上一期的收尾工作做完，记录一并归档。',
      '第二件事：把本期的标准落到纸面上，方便换人接手。',
      '第三件事：把需要外部配合的环节提前一周打招呼。',
      '第四件事：把例会时间压缩，只留需要拍板的事项。',
      '第五件事：把材料里对不上的两处记录核对清楚。',
    ],
    todo: [
      '待办一：更新一份可执行的清单，写清每一条的负责人。',
      '待办二：把例外情况整理成一张表，随清单一起发出去。',
      '待办三：下期开始前先过一遍上期待办，没做完的说清原因。',
      '待办四：把对外口径统一成一份说明，避免两边说法不一致。',
    ],
    next: [
      '下一步一：把口径定稿，并同步到所有相关的人。',
      '下一步二：按定稿的口径把未完成的部分做完。',
      '下一步三：下期开始前复盘一次，没做完的写清原因。',
      '下一步四：对外沟通统一口径，避免两边按不同标准做事。',
      '下一步五：把这次留下的记录整理成模板，供下次直接使用。',
    ],
  };

  const REPORT_KIND_LEAD = {
    work: '本期{kw}的推进情况按材料里写到的事实汇报，材料之外的内容不在这里出现。',
    review: '复盘按“目标—结果—做法”的次序写：先看没做到什么，再看哪一步可以留下。',
    market: '这份行业分析只就材料给出的信息判断，材料之外的推测不写。',
    survey: '调研按“发现—数据—建议”的次序写，样本与口径在数据部分说明。',
    weekly: '本期周报按事项罗列，只写有进展和需要跟进的部分。',
  };

  /* 报告类型不只是换个说法：结构上也要看得到差别 */
  const REPORT_KIND_POOL = {
    work: [
      '本期的事项按“做完了什么、卡在哪里、下一步”三段来看。',
      '推进过程中的调整都写在依据里，没有藏在结论里。',
    ],
    review: [
      '复盘只看两件事：目标达成了多少，哪些做法值得留下来。',
      '没做到的部分也写清原因，不然复盘会变成表功。',
    ],
    market: [
      '行业信息按“现状—原因—趋势”来看，能确认的写出来，不能确认的留作待补。',
      '判断只依据材料里的事实，没有拿常识替代数据。',
    ],
    survey: [
      '调研的样本与回收情况写在数据部分，结论只在样本范围内成立。',
      '发现按重要程度排序，先写会影响决策的那几条。',
    ],
    weekly: [
      '本周的事项按完成情况罗列，没有进展的不写进来凑数。',
      '需要别人配合的事项单独标出来，免得散会就忘。',
    ],
  };

  const REPORT_KIND_EXTRA_ROLE = { work: '', review: 'reusable', market: 'trend', survey: 'findings', weekly: '' };

  /* 周报/月报本来就是事项清单，章节不照"结论—依据—行动"铺 */
  const REPORT_KIND_PLAN = { weekly: ['items', 'todo', 'next'] };

  /* 编号已经写在标题里了，条目里再写一遍「下一步二：」就太啰嗦 */
  const REPORT_LABEL_RE = {
    next: /^下一步[一二三四五六七八九十]?[：:]?\s*/,
    conclusion: /^结论[：:]\s*/,
    decision: /^待决策项[：:]\s*/,
    todo: /^待办[一二三四五六七八九十]?[：:]\s*/,
    items: /^第[一二三四五六七八九十]件事[：:]\s*/,
  };

  function stripReportLabel(role, line) {
    const re = REPORT_LABEL_RE[role];
    if (!re) return line;
    const out = String(line).replace(re, '');
    return out.length >= 6 ? out : line;
  }

  const REPORT_AUDIENCE_LEAD = {
    leader: '本报告面向管理层：结论与需要拍板的事项放在前面，细节放在后面。',
    team: '本报告面向同组同事：分工与执行细节写全，方便直接照着做。',
    client: '本报告面向合作方：只写与本次合作相关的内容，内部口径不在此列。',
    public: '本报告对外公开：去掉了内部术语与尚未确认的数字。',
  };

  const REPORT_TONE = {
    bluf: { prefer: ['结论', '待决策', '需要拍板', '依据'], lead: [] },
    plain: { prefer: [], lead: [] },
    data: { prefer: ['数据', '口径', '来源', '指标', '记录'], lead: [] },
    crisp: { prefer: [], lead: [], short: true },
  };

  const REPORT_TONE_EXTRA = {
    data: ['口径补充：上面出现的数字都来自你提供的素材，没有换算，也没有补估。'],
    bluf: [],
    crisp: [],
    plain: [],
  };

  function composeReport(p, mode, angle, ctx, target) {
    const kind = REPORT_KIND_LEAD[ctx.fields.kind] ? ctx.fields.kind : 'work';
    const audience = REPORT_AUDIENCE_LEAD[ctx.fields.audience] ? ctx.fields.audience : 'leader';
    const voice = REPORT_TONE[p.tone] || REPORT_TONE.plain;
    const rnd = ctx.rnd;
    let plan = (REPORT_KIND_PLAN[kind] || REPORT_PLAN[angle.id] || REPORT_PLAN.bluf).slice();
    const compact = p.tone === 'crisp' || kind === 'weekly';
    const perSection = p.tone === 'crisp' ? 2 : 4;
    const budget = Math.max(150, Math.round(target * (kind === 'weekly' ? 0.82 : p.tone === 'crisp' ? 0.86 : 1)));
    const lean = budget < 320;

    // 报告的依据就是材料本身：先把材料里的事实抽出来，只放进一节，不重复摆
    const facts = keyPoints(ctx.src, 3).map((s) => clipSoft(s, lean ? 42 : 58));
    const factRole = plan.filter((r) => REPORT_FACT_ROLES[r])[0] || '';

    const pools = {};
    plan.forEach((role) => {
      let lines = poolLines(REPORT_POOL[role] || [], ctx);
      // 换角度时把章节内的条目错开一个起点，读起来不是同几行换标题
      lines = rotate(rnd, lines);
      if (role === factRole && facts.length) {
        lines = facts.concat(lines.filter((s) => facts.indexOf(s) < 0));
      } else if (!REPORT_KIND_PLAN[kind]) {
        lines = orderByTone(rnd, lines, voice);
      }
      pools[role] = lines;
    });

    const lines = [];
    const firstOf = (role) => (pools[role] && pools[role][0]) || '';

    // 结论先行的语气：第一段就把结论与待决策项说完，正文里不再重复这两节
    if (p.tone === 'bluf') {
      const con = firstOf('conclusion');
      const dec = firstOf('decision');
      if (con || dec) {
        lines.push('结论与待决策项');
        if (con) lines.push(stripReportLabel('conclusion', con));
        if (dec) lines.push(/^(需要拍板|待决策项|请确认)/.test(dec) ? dec : `待决策项：${dec}`);
        plan = plan.filter((r) => r !== 'conclusion' && r !== 'decision');
      }
    }

    lines.push(REPORT_AUDIENCE_LEAD[audience]);
    // 缺的地方一律写「（待补）」：这条口径无论素材有没有数字都在
    lines.push('口径说明：数字与时间只取自素材，材料没写的地方写（待补），不替你估。');
    if (!lean) {
      const kindLead = fill(REPORT_KIND_LEAD[kind], ctx);
      if (kindLead) lines.push(kindLead);
      poolLines(REPORT_KIND_POOL[kind] || [], ctx).slice(0, 2).forEach((s) => lines.push(s));
      (REPORT_TONE_EXTRA[p.tone] || []).forEach((s) => lines.push(s));
    }

    // 报告类型决定要不要多插一节：复盘留经验、行业看趋势、调研摆发现
    const extraRole = REPORT_KIND_EXTRA_ROLE[kind];
    if (extraRole && plan.indexOf(extraRole) < 0) {
      const extraPool = orderByTone(rnd, rotate(rnd, poolLines(REPORT_POOL[extraRole] || [], ctx)), voice);
      const at = Math.max(1, plan.length - 2);
      plan.splice(at, 0, extraRole);
      pools[extraRole] = extraPool;
    }
    // 长篇报告要多铺两节，否则翻来覆去还是那几句
    if (budget >= 640) {
      let added = 0;
      ['progress', 'cause', 'suggestion', 'reusable'].forEach((role) => {
        if (added >= 2 || plan.indexOf(role) >= 0) return;
        plan.splice(Math.max(1, plan.length - 2), 0, role);
        pools[role] = orderByTone(rnd, rotate(rnd, poolLines(REPORT_POOL[role] || [], ctx)), voice);
        added += 1;
      });
    }

    // 短篇报告只留"一节依据 + 下一步"：开头几行已经把结论与口径说完了
    if (lean && plan.length > 2) {
      plan = [plan[0], 'next'].filter((r) => pools[r]);
    }

    const sections = plan
      .filter((role) => (pools[role] || []).length)
      .map((role) => ({
        role,
        heading: kind === 'weekly' && role === 'conclusion' ? '本期结论' : REPORT_HEADING[role] || role,
        used: [pools[role][0]],
      }));

    // 每节先各留一条要点，再轮着补齐，保证「下一步」这一节一定在
    let len = charCount(lines.join('')) + sections.reduce((n, s) => n + charCount(s.heading) + charCount(s.used[0]), 0);
    for (let round = 1; round < 12 && len < budget * 0.92; round += 1) {
      let added = false;
      sections.forEach((sec) => {
        if (len >= budget * 0.92) return;
        if (sec.used.length >= perSection) return;
        const nextLine = pools[sec.role][sec.used.length];
        if (!nextLine) return;
        sec.used.push(nextLine);
        len += charCount(nextLine);
        added = true;
      });
      if (!added) break;
    }

    const cn = ['一', '二', '三', '四', '五', '六', '七'];
    sections.forEach((sec, i) => {
      lines.push('');
      lines.push(`${cn[i] || i + 1}、${sec.heading}`);
      let bullets = sec.used.map((s) => stripReportLabel(sec.role, s));
      if (sec.role === 'next') {
        bullets = bullets.map((s) => `${s.replace(/[。；]$/, '')}（责任人待定，完成时间待补）。`);
      }
      bullets.forEach((s, j) => lines.push(`${j + 1}. ${s}`));
    });

    if (!compact && !lean && ctx.nums.length) {
      lines.push('', `本次用到的数字：${ctx.nums.slice(0, 3).join('、')}，均照素材原样引用。`);
    }
    return lines.join('\n');
  }

  /* ══════════════════════════════════════════════════════════
   * 十三、小说语料（fiction）
   * ══════════════════════════════════════════════════════════ */

  /* 三条约束写进语料本身：
     1. 只写动作、场景与对话，不用「他感到」「她意识到」直接说明情绪——
        情绪要靠数零钱、抬手、停住这类动作让读者自己看出来；
     2. 主语一律走 {I} 槽位（我 / 他 / 她），别的人物只用身份词（{role}），
        这样第一人称稿里天然不会漏出「他/她」；
     3. 不写"以下是小说的开头"这类说明句，也不写年表与梗概。 */

  const FICTION_PROP = {
    real: [
      '末班公交进站的时候，雨已经小了，站牌下只剩两个人。',
      '收银台上的胶带用完了，抽屉里翻出半卷，边缘起了毛。',
      '便利店的玻璃门内侧结了一层薄雾，手指划过去能留下一道印。',
      '微波炉响了一声，值夜班的人把饭盒端出来，在窗口站了一会儿。',
      '塑料袋在手里晃着，装着两盒牛奶和一包盐。',
      '路灯把水洼照得发白，踩过去的时候声音很轻。',
      '楼下的面馆关了门，卷帘门拉到一半，里面还亮着一盏灯。',
      '电动车停在单元门口，车筐里放着没拆的快递。',
    ],
    mystery: [
      '楼道的声控灯亮到第三层就灭了，脚步停下来，灯又亮。',
      '门锁上有两道新的划痕，一道深一道浅，位置和上次一样。',
      '监控画面从两点十七分开始跳帧，中间缺了四十秒。',
      '桌上的杯子换过位置，杯口的水渍朝外，杯底却没有移动的痕迹。',
      '信封没有封口，里面的纸对折了三次，折痕是旧的。',
      '楼道里有人停下，钥匙在手里转了两圈，没有插进锁孔。',
      '走廊尽头的门虚掩着，门缝里的光比昨天暗。',
      '电梯停在四层，指示灯没有再动。',
    ],
    scifi: [
      '舱内的主灯切到夜间模式，只剩两条冷白色的导光条。',
      '气闸泄压的声音持续了六秒，压力表的指针回到绿区。',
      '终端上跳出一行日志：同步率下降百分之三，原因未知。',
      '休眠舱的指示灯是慢闪的，说明里面的人醒过一次。',
      '舷窗外那颗行星转到背面，通讯中断了十一分钟。',
      '冷却管里的液体发出细小的流动声，温度比标准值低了两度。',
      '维修臂停在货舱上方，末端夹着一块不在清单里的编号牌。',
      '头盔里的呼吸声被放大，间隔比平时长。',
    ],
    fantasy: [
      '长街尽头的铜铃响过第三遍，卖药的铺子还亮着灯。',
      '结界上的裂口只有一指宽，边缘的光正在变淡。',
      '药炉里的火压得很低，锅里的水一直没有开。',
      '雪落在石阶上，落一层化一层，谁的脚印都没留下。',
      '木牌上的字被雨泡过，最后两个字已经看不清。',
      '腰间的短刀没有出鞘，刀鞘上沾着松脂。',
      '灯芯烧到最后一截，屋里的人把灯挑高一寸。',
      '客栈的账本摊在桌上，最后一页没有写满。',
    ],
    romance: [
      '咖啡凉到一半，杯壁上的水痕慢慢往下走。',
      '伞往那边偏了一下，肩膀湿了一片，谁都没有提。',
      '手机屏幕亮了一次，消息框里只有两个字：到了。',
      '电梯停在十层，门开了一半，两个人谁都没有先出去。',
      '外套搭在椅背上，袖口还留着上一个人的温度。',
      '桌上的两只杯子挨得很近，杯沿上的水渍几乎连在一起。',
      '楼道里的声控灯灭下去，没有人跺脚。',
      '车票压在书页里，页角折了起来。',
    ],
    history: [
      '更鼓敲过三下，坊门早已落锁，只有驿道上的马蹄声还听得见。',
      '油灯把账册照得发黄，算盘珠子停在最后一行。',
      '布庄的门板上贴着新告示，纸边还没有干透。',
      '祠堂的门槛磨得发亮，来上香的人把伞靠在门边。',
      '驿马换了新掌，铁匠铺的火一直没有熄。',
      '茶摊收了，木凳扣在桌上，风把招牌吹得响。',
      '家书封了口，蜡印上按着一个模糊的指痕。',
      '渡口的船停在浅水处，缆绳松了半圈。',
    ],
  };

  /* 动作按"哪一段"分。中性动作哪个类型都能用；
     便利店、收银台、灯管这类现代器物单独放，免得跑进奇幻或历史的场面里。 */
  const FICTION_BEAT = {
    open: [
      '门上的铃铛响了一声。',
      '进来的人把伞收在门口，水顺着伞骨往下滴。',
      '来的人把东西放在案上，往后退了半步。',
      '外面的风把门帘吹起来一角，又落下去。',
      '屋里的人没有抬头，手里的东西没有停。',
      '灯芯挑高了一点，屋里亮了一层。',
    ],
    plot: [
      '{I}把东西推过去，对方没有接。',
      '两个人隔着桌子，中间放着一样东西。',
      '{I}低头去找，东西滚到地上，滚到角落里。',
      '上面的字迹掉了，认不出原先写的是什么。',
      '{I}抬手去拿最上层的东西，指尖碰到一层灰。',
      '门又响了一声，进来的人站在门口没有动。',
    ],
    talk: [
      '“说慢一点。”{role}把手里的东西放回案上。',
      '“我记着。”{I}把笔尖按在纸上，没有立刻写。',
      '“上一次你也是这么说的。”',
      '“上一次不一样。”{I}抬起头。',
      '“哪里不一样？”{role}往后退了半步。',
      '“上一次我还不知道要问什么。”',
    ],
    turn: [
      '{I}把那张纸翻过来，背面还有一行字。',
      '原来的说法在这一刻对不上了：日期和记录差了一天。',
      '这次进来的人换了一件外套，鞋却和昨天一样。',
      '{I}把抽屉里的东西全部倒出来，少了一样。',
      '记录上的时间是对的，错的是{role}报出来的那一个。',
      '一直放在明面上的东西，其实不是那件事的关键。',
    ],
    end: [
      '灯灭了以后，屋里只剩下门缝里的一条光。',
      '外面的雨停了，地上的水痕慢慢干了。',
      '{I}把东西收好，钥匙放进口袋。',
      '第二天，原先那个位置换了一个人。',
      '门上的铃铛被取了下来，放在抽屉最里面。',
      '这件事没有下文，只有那一格空着。',
    ],
  };

  const FICTION_BEAT_MODERN = [
    '柜台后面的位置空着，收钱的抽屉虚掩。',
    '灯管闪了两下，才亮稳。',
    '外面的风把卷帘门的边角吹得响。',
    '货架第二层的标签掉了，商品和价格对不上。',
    '灯管最后闪了一下，灭了。',
    '{I}低头找零，零钱滚到地上，滚进货架下面。',
  ];

  /* 另外三个类型的动作：器物和用词跟着换，不跟现代生活混着写 */
  const FICTION_BEAT_ERA = {
    scifi: [
      '舱门的气密圈发出一声轻响，锁扣退回去半格。',
      '控制台上的指示灯按顺序亮过一遍，最后停在第二格。',
      '通讯频道里有人叫了一声编号，没有得到回答。',
      '手套内侧的温度在下降，指节按在面板上留下几个浅印。',
      '自动门开到一半停住，缝里透进来的光很薄。',
      '终端把上一段记录又读了一遍，读到同一处就停住。',
      '通道尽头过来一个人，脚步比平时慢半拍。',
      '值班表上多出一行，写的是同一段时间。',
    ],
    fantasy: [
      '门轴响了一声，来的人把斗篷上的雪抖在门槛外。',
      '灯笼晃了半圈，墙上的影子跟着挪了半尺。',
      '屋檐下的铜铃响过第三声，院子里没有人应。',
      '案上摊着的纸被风掀起一角，镇尺滑了半指。',
      '药炉里的火苗矮下去，屋里暗了一层。',
      '长廊那头过来一个人，脚步声在石板上停了一下。',
      '封着的封条上有一道细纹，指腹按过去能感觉到。',
      '桌上的茶凉了，杯口的白气早散了。',
    ],
    history: [
      '门环响了两下，来的人把伞靠在门外的阶上。',
      '灯花爆了一下，屋里的人把灯盏挪近半寸。',
      '更夫的声音从巷子那头过去，近了又远。',
      '案上的公文摊到一半，边角被镇纸压着。',
      '帐子后面有人动了一下，帘子晃了两晃。',
      '门外有人候着，影子从门缝下面透进来。',
      '封好的信放在托盘上，蜡印朝上。',
      '茶添过一次，杯口的热气已经淡了。',
    ],
  };

  const FICTION_TALK = {
    real: [
      '“今天照旧。”{role}把硬币放在台面上。',
      '“照旧。”{I}把东西装进袋子，袋口折了两折。',
      '“明天可能不来了。”',
    ],
    mystery: [
      '“门锁上的划痕，你看见过？”',
      '“没有。”{role}的手在袖口里停了半秒。',
      '“那你把昨晚的事再说一遍。”',
    ],
    scifi: [
      '“同步率在掉。”{role}把手从控制台上收回来。',
      '“掉了多少？”',
      '“三个百分点。日志里没有写原因。”',
    ],
    fantasy: [
      '“灯要灭了。”{role}把灯芯挑高。',
      '“灭了就看不见。”{I}把门闩上。',
      '“看不见也好。”',
    ],
    romance: [
      '“你等很久了？”',
      '“不久。”{I}把伞往那边挪了半寸。',
      '“下次别站在雨里。”',
    ],
    history: [
      '“坊门关了，今夜出不去。”{role}把灯盏放在案上。',
      '“那就明天一早走。”{I}把驿书压在灯下。',
      '“明天一早，驿马未必还在。”',
    ],
  };

  const FICTION_POV = {
    first: [
      '我在门口站了一会儿，才把手从口袋里拿出来。',
      '墙上的钟比平时慢了两分钟，我看了两次。',
      '话在心里过了一遍，出口的时候只剩半句。',
      '抽屉里的零钱我数了两遍，数目没有错。',
      '我没有回头，把门带上。',
      '手插在口袋里，指头一下一下地敲着裤缝。',
    ],
    third: [
      '{H}在门口站了一会儿，才把手从口袋里拿出来。',
      '墙上的钟比平时慢了两分钟，{H}看了两次。',
      '话在心里过了一遍，出口的时候只剩半句。',
      '抽屉里的零钱{H}数了两遍，数目没有错。',
      '{H}没有回头，把门带上。',
      '手插在口袋里，指头一下一下地敲着裤缝。',
    ],
    omni: [
      '柜台里的人和门口的人各自站着，谁都没有先开口。',
      '{H}在想那句没说完的话，{role}想的是另一件事。',
      '街对面的人抬头看了一眼这边的窗，又低下头。',
      '两个人都听见了那声铃响，动作却不一样：一个往后退，一个往前半步。',
      '这一夜还有一个人没有睡：三楼的灯一直亮着。',
      '事情后来走向了另一个方向，当时在场的人各自记下了不同的版本。',
    ],
  };

  /* 角度是四套动线，句子本身不挑类型：器物由 FICTION_PROP / FICTION_BEAT 提供 */
  const FICTION_ANGLE = {
    scene: [
      '外面的声音一阵一阵，隔着墙传进来。',
      '光从门口斜着照进来，在地上切出一条边。',
      '有人影从亮处走过，停了一下又走开。',
      '细小的声音一直没有停，落在同一个地方。',
    ],
    talk: [
      '“你先听我说完。”{role}把手里的东西往旁边推了推。',
      '“我在听。”{I}把手收回来。',
      '“那天你为什么不说？”',
    ],
    inner: [
      '有一处细小的声音一直没有停，像有什么东西在里面走。',
      '{I}把手指按在桌沿的划痕上，来回摸了三次。',
      '手里的东西换了个位置，又换回去，前后两次的间隔越来越短。',
    ],
    hook: [
      '最底下压着一张对折的纸，边角是新的。',
      '空出来的那一格，昨天还是满的。',
      '门外有人停下来，影子停留了很久，没有推门。',
    ],
  };

  /* 类型中性的一批动作：任何年代、任何设定里都成立，用来把篇幅补足 */
  const FICTION_LIFE = [
    '门口的垫子上有一块深色的印子，擦不掉。',
    '墙上的钟慢了四分钟，没有人去调。',
    '手边的杯子里只剩底下一层水。',
    '外面的声音一阵一阵，听不出是什么。',
    '记录本翻到新的一页，上一页的字迹压得很深。',
    '灯下有一只飞虫绕着转，撞在灯罩上。',
    '椅子的一条腿短了半截，垫着一张折起来的纸。',
    '笔没有盖帽，墨在纸上洇开一小块。',
  ];

  const FICTION_END = [
    '雨到天亮才停，门口的水痕慢慢干了。',
    '后来那条街上的人都换了，只有招牌没有换。',
    '灯没有再亮起来，柜台也没有再开过。',
    '所有的记录都留下来了，只有那一页是空白。',
  ];

  const FICTION_TONE = {
    restrained: ['没有人说话。', '手停在半空，又收回去。'],
    lyric: ['雨声压在屋顶上，密得像有人在上面走。', '光落在地上慢慢铺开，边缘是软的。', '风从门缝里进来，先动了桌角那张纸。'],
    tense: ['灯灭了。', '脚步声停在门口。', '铃响了一声。', '没有第二声。'],
    light: ['“又是我。”{I}把手里的东西推回去，退回来半寸。', '墙角那只猫抬头看了一眼，又睡了。'],
  };

  /* 主角与另一方的称呼：第一人称让另一方只用身份词，就不会漏出第三人称代词 */
  const FICTION_ROLE_FALLBACK = {
    real: '值班的',
    mystery: '值班的人',
    scifi: '值班员',
    fantasy: '铺子里的人',
    romance: '那个人',
    history: '掌柜',
  };

  function fictionRole(ctx, genre) {
    // 科幻、奇幻、历史里不能蹦出「便利店店员」这种现代身份，身份词跟着类型走
    if (FICTION_BEAT_ERA[genre]) return FICTION_ROLE_FALLBACK[genre] || '那个人';
    const src = ctx.src || '';
    const hit = src.match(/([\u4e00-\u9fa5]{1,3}(?:店员|老板|客人|乘客|医生|护士|司机|教师|老师|学生|警察|保安|骑手|快递员|服务员|掌柜|同事|房客|邻居))/);
    const role = hit ? hit[1] : '';
    const clean = role.replace(/[他她]/g, '');
    return clean || FICTION_ROLE_FALLBACK[genre] || '那个人';
  }

  function fictionHero(ctx) {
    return /(她|女|妻|妈|姐|嫂|姑娘|女孩)/.test(ctx.src || '') ? '她' : '他';
  }

  /* 对话是一来一回：把连续的对白捆成一个整块，
     这样篇幅裁剪时要么整段留下、要么整段不要，不会剩一句没头没尾的话 */
  function groupExchange(lines) {
    const out = [];
    let buf = [];
    (lines || []).forEach((s) => {
      if (/^[“「]/.test(s)) {
        buf.push(s);
        return;
      }
      if (buf.length) {
        out.push(buf.join('\n'));
        buf = [];
      }
      out.push(s);
    });
    if (buf.length) out.push(buf.join('\n'));
    return out;
  }

  function composeFiction(p, mode, angle, ctx, target) {
    const part = FICTION_BEAT[ctx.fields.part] ? ctx.fields.part : 'open';
    const viewpoint = FICTION_POV[ctx.fields.viewpoint] ? ctx.fields.viewpoint : 'third';
    const genre = FICTION_PROP[ctx.fields.genre] ? ctx.fields.genre : 'real';
    const rnd = ctx.rnd;
    const hero = fictionHero(ctx);
    const fctx = Object.assign({}, ctx, {
      I: viewpoint === 'first' ? '我' : hero,
      H: hero,
      role: fictionRole(ctx, genre),
    });

    // 器物跟类型走：现代场景用便利店那一套，科幻、奇幻、历史各自换过
    const world = (FICTION_BEAT_ERA[genre] || []).length ? FICTION_BEAT_ERA[genre] : FICTION_BEAT_MODERN;
    const tonePool = FICTION_TONE[p.tone] || [];
    const all = {
      prop: poolLines(FICTION_PROP[genre], fctx),
      beat: poolLines(world, fctx),
      // 对话是一来一回，顺序打乱就读不懂了，这两组不参与乱序
      exchange: part === 'talk' ? groupExchange(poolLines(FICTION_BEAT.talk, fctx)) : [],
      talk: groupExchange(poolLines(FICTION_TALK[genre], fctx)),
      pov: poolLines(FICTION_POV[viewpoint], fctx),
      angle: groupExchange(poolLines(FICTION_ANGLE[angle.id] || FICTION_ANGLE.scene, fctx)),
      tone: poolLines(tonePool, fctx),
      life: poolLines(FICTION_LIFE, fctx),
      end: poolLines(FICTION_END, fctx),
    };
    // 角度就是四套动线：先画面、先对话、贴意识、还是把钩子留到最后
    const order = angle.id === 'talk' ? ['exchange', 'talk', 'beat', 'pov', 'prop', 'angle', 'tone', 'life', 'end']
      : angle.id === 'inner' ? ['pov', 'angle', 'exchange', 'beat', 'tone', 'prop', 'life', 'talk', 'end']
        : angle.id === 'hook' ? ['prop', 'exchange', 'beat', 'tone', 'pov', 'life', 'talk', 'angle', 'end']
          : ['prop', 'tone', 'exchange', 'beat', 'talk', 'angle', 'pov', 'life', 'end'];

    let blocks = [];
    order.forEach((key) => {
      const list = all[key] || [];
      const ordered = key === 'talk' || key === 'exchange';
      const arranged = ordered ? list.slice() : rotate(rnd, orderByTone(rnd, list, ctx.voice));
      arranged.forEach((s) => pushUnique(blocks, s));
    });

    // 第一人称：任何带「他/她」的句子都不要，这是硬约束，兜底在最后一道
    if (viewpoint === 'first') blocks = blocks.filter((s) => !/[他她]/.test(s));

    const kept = fitTarget(blocks, Math.max(150, target), []);
    if (!kept.length) return '';
    // 留钩子的角度：最后一句换成一个让读者想往下翻的东西
    if (angle.id === 'hook' && kept.length > 1) {
      const pool = all.angle.concat(all.end).filter((s) => kept.slice(0, -1).indexOf(s) < 0);
      const last = pick(rnd, pool);
      if (last) kept[kept.length - 1] = last;
    }
    // 对话单独占一行：中文小说里对话挤在叙述段落中间最难读
    const paras = [];
    let buf = [];
    const flush = () => {
      if (buf.length) paras.push(buf.join(''));
      buf = [];
    };
    kept.forEach((s, i) => {
      if (/^[“「]/.test(s)) {
        flush();
        paras.push(s);
        return;
      }
      buf.push(s);
      if (buf.length >= [2, 2, 3][i % 3]) flush();
    });
    flush();
    return paras.join('\n\n');
  }

  /* ══════════════════════════════════════════════════════════
   * 十四、翻译与自定义模板：离线引擎做不到的事如实说明
   * ══════════════════════════════════════════════════════════ */

  /* 离线引擎没有语言能力，翻译做不了；自定义模板的提示词也只有真实模型能执行。
     这两类请求一律返回"说明 + 原样保留的原文"，绝不假装译过、也绝不拿内置模式的稿子充数。 */

  const TEMPLATE_PREFIX = 'tpl_';

  const TRANSLATE_LANG = {
    en: '英文',
    ja: '日文',
    ko: '韩文',
    fr: '法文',
    de: '德文',
    es: '西班牙文',
    ru: '俄文',
    'zh-tw': '繁体中文',
  };

  const TRANSLATE_ANGLE_NOTE = {
    faithful: '接入模型后会按逐句对应的方式译，专业术语一律照通行译法，不为了顺口改动信息。',
    natural: '接入模型后会按目标语言的表达习惯重组句子，目标是读起来不像译文。',
    localized: '接入模型后会把成语、俗语、单位与称呼换成目标语言里对等的说法。',
    rhythm: '接入模型后会保留原文的句长与停顿，口吻尽量不走样。',
  };

  const TRANSLATE_TONE_NOTE = {
    literal: '译法口径：贴着原文，不添不减。',
    natural: '译法口径：以目标语言读者的读感为先。',
    localized: '译法口径：按当地习惯改写称呼、单位与语气。',
    formal: '译法口径：用书面语与公文体例，称呼与落款照目标语言的惯例。',
  };

  function translateTargetName(fields) {
    const key = (fields && fields.target) || 'en';
    if (key === 'other') {
      const custom = clip((fields && fields.targetCustom) || '', 20);
      return custom || '你在“其它语言”里填写的语言';
    }
    return TRANSLATE_LANG[key] || TRANSLATE_LANG.en;
  }

  function stripBlank(text) {
    return String(text == null ? '' : text).replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
  }

  function composeTranslate(p, mode, angle, ctx, target, rawSrc) {
    const fields = ctx.fields || {};
    const lang = translateTargetName(fields);
    const shape = fields.shape || 'keep';
    const body = stripBlank(rawSrc);
    const lines = [
      '【离线引擎不做翻译】',
      '',
      '翻译需要真实模型：设置 DEEPSEEK_API_KEY 后重启即可（别家平台再加 AI_BASE_URL）。',
      '',
      `目标语言：${lang}`,
      TRANSLATE_TONE_NOTE[p.tone] || TRANSLATE_TONE_NOTE.literal,
      TRANSLATE_ANGLE_NOTE[angle.id] || TRANSLATE_ANGLE_NOTE.faithful,
    ];
    if (fields.glossary) lines.push(`术语要求：${clip(fields.glossary, 60)}；接入模型后按这个口径执行。`);
    if (shape === 'merge') lines.push('格式：合并成一段——接上模型后译文会给成一段，方便直接放进邮件或表格。');

    if (!body) {
      lines.push('', '原文这里还空着：把要翻译的内容粘进原稿，我先把原文原样带着。');
      return lines.join('\n');
    }

    if (shape === 'bilingual') {
      const paras = body.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      lines.push('', '下面是原文与译文的对照骨架，译文一栏等接上模型再补：', '');
      paras.forEach((para, i) => {
        lines.push(`【原文 ${i + 1}】`);
        lines.push(para);
        lines.push(`【译文 ${i + 1}】待补（离线引擎不做翻译）`);
        lines.push('');
      });
      return lines.join('\n').trim();
    }

    lines.push('', '下面是你的原文，先留着对照：', '', body);
    if (shape === 'merge') lines.push('', '（原文按原样保留，段落没有合并：合并这件事留给真实模型。）');
    return lines.join('\n');
  }

  const CUSTOM_TEMPLATE_ANGLES = ['structured', 'detailed', 'concise', 'another'];

  const TEMPLATE_ANGLE_NOTE = {
    structured: '接上模型后，这一稿会按小标题分段，一段一个意思。',
    detailed: '接上模型后，这一稿会把要求落到具体的例子、数字与场景上。',
    concise: '接上模型后，这一稿只留核心信息，篇幅压到最短。',
    another: '接上模型后，这一稿会换一个切入点或叙述顺序。',
  };

  const TEMPLATE_TONE_NOTE = {
    plain: '语气：平实——不用形容词堆砌，把事说清楚。',
    professional: '语气：专业——术语准确，句子有分量。',
    warm: '语气：亲切——像跟熟人说话。',
    crisp: '语气：简练——能删就删，一段一个意思。',
    same: '语气：贴合原稿的句长与用词习惯。',
  };

  /**
   * 模板名：服务端会把注册好的模板名放在第四个参数里（{ templateName }）；
   * 直接调引擎的调用方可能把名字放在 params 上；两者都拿不到就退回「自定义模板」四个字。
   */
  function templateNameOf(raw, options) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const o = options && typeof options === 'object' ? options : {};
    const registered = Modes.customModeOf ? Modes.customModeOf(r.mode || '') : null;
    const candidates = [
      o.templateName,
      o.template && (o.template.name || o.template.title),
      r.templateName,
      r.template && (r.template.name || r.template.title),
      registered && registered.name,
      r.meta && r.meta.templateName,
      r.fields && r.fields.templateName,
    ];
    for (let i = 0; i < candidates.length; i += 1) {
      const name = clip(candidates[i], 24);
      if (name) return name;
    }
    return '';
  }

  function composeCustomTemplate(raw, rawSrc, index, options) {
    const name = templateNameOf(raw, options) || '自定义模板';
    const p = Modes.normalizeParams(raw);
    const angleId = CUSTOM_TEMPLATE_ANGLES[((index % 4) + 4) % 4];
    const body = stripBlank(rawSrc);
    const lines = [
      `【离线引擎${name === '自定义模板' ? '写不了自定义模板' : `写不了模板「${name}」`}】`,
      '',
      `模板「${name}」的自定义提示词需要真实模型执行：设置 DEEPSEEK_API_KEY 后重启即可。`,
      '（离线引擎只写内置模式的内容，模板里的提示词它读不懂，硬拼一版出来只会误导你。）',
      TEMPLATE_ANGLE_NOTE[angleId],
      TEMPLATE_TONE_NOTE[p.tone] || TEMPLATE_TONE_NOTE.plain,
    ];
    if (!body) {
      lines.push('', '素材也还空着：把要处理的内容粘进来，接上模型之前先留着。');
      return lines.join('\n');
    }
    lines.push('', '下面是你的原文，模板跑起来之前先留着：', '', body);
    return lines.join('\n');
  }

  /* ══════════════════════════════════════════════════════════
   * 十五、入口：compose
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

  function compose(params, material, versionIndex, options) {
    const raw = params && typeof params === 'object' ? params : {};
    const index = Math.max(0, Math.floor(Number(versionIndex) || 0));
    const materialText = plain(typeof material === 'string' ? material : (material && material.input) || '');
    const src = squash(materialText);

    // 自定义模板（tpl_xxx）不在模式目录里：getMode 对未知 id 会退回第一个模式，
    // 所以这里必须先看原始参数，不能被规整后的 mode 骗过去；
    // 服务端注册过模板时参数里已经是 tpl_xxx，没注册过则只剩第四个参数里的 templateName。
    const tplFlag = String(raw.mode || '').indexOf(TEMPLATE_PREFIX) === 0
      || Boolean(options && typeof options === 'object' && options.templateName);
    if (tplFlag) {
      return composeCustomTemplate(raw, materialText, index, options);
    }

    const p = Modes.normalizeParams(raw);
    const mode = Modes.getMode(p.mode);
    const angle = Modes.angleOf(mode, index);
    const rnd = seededRandom(seedFor(p, src, index));
    const ctx = makeCtx(p, mode, angle, src, rnd);
    const target = targetOf(p, mode, src.length);

    // 离线引擎没有语言能力：译不了就直说，并把原文原样带上
    if (mode.id === 'translate') return composeTranslate(p, mode, angle, ctx, target, materialText);

    // 新加的三个模式自带语料，没有素材也能起一稿，不走"该怎么写"的兜底
    const SELF_CONTAINED = ['copywriting', 'outline', 'summary', 'email', 'academic', 'report', 'fiction'];
    if (!src && SELF_CONTAINED.indexOf(mode.id) < 0) {
      return composeFallback(p, mode, angle, ctx, target);
    }

    let text;
    if (mode.id === 'continue') text = composeContinue(p, mode, angle, ctx, target);
    else if (mode.id === 'rewrite') text = composeRewrite(p, mode, angle, ctx, target);
    else if (mode.id === 'copywriting') text = composeCopywriting(p, mode, angle, ctx, target);
    else if (mode.id === 'email') text = composeEmail(p, mode, angle, ctx, target);
    else if (mode.id === 'summary') text = composeSummary(p, mode, angle, ctx, target);
    else if (mode.id === 'academic') text = composeAcademic(p, mode, angle, ctx, target);
    else if (mode.id === 'report') text = composeReport(p, mode, angle, ctx, target);
    else if (mode.id === 'fiction') text = composeFiction(p, mode, angle, ctx, target);
    else text = composeOutline(p, mode, angle, ctx, target);

    if (!text || !text.trim()) return composeFallback(p, mode, angle, ctx, target);
    return text;
  }

  /* ══════════════════════════════════════════════════════════
   * 十六、校对：polish
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
   * 十七、导出
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
