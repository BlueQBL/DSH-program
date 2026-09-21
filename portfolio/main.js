/* ============================================================
   薛小飞 · 个人作品集
   原生 JS，无依赖、无构建。这一层负责：
     1. 内容与多语言（中 / 英，文案集中在下面的 I18N 与 site 里）
     2. 渲染项目卡片与联系方式
     3. 主题开关 / 滚动揭示 / 左侧索引栏 / 头像扫描成像 / 复制邮箱 / 头像上传
     4. 访问统计（读服务端的真实数据，拿不到就整块不显示）
     5. 留言板（读写服务端，挂了就降级成一句说明）
   ============================================================ */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ============================================================
     1. 多语言文案
     ============================================================ */
  var I18N = {
    zh: {
      'meta.title': '薛小飞 · 个人作品集',
      'meta.desc': '薛小飞 —— 全栈开发者，后端出身，近三年做大模型与 AI 应用。',

      'lang.switch': 'English',
      'lang.name': '中文',
      'lang.short': '中',

      'nav.about': '关于',
      'nav.work': '作品',
      'nav.guestbook': '留言',
      'nav.contact': '联系',
      'nav.index': '页面索引',
      'nav.home': '回到首页',
      'nav.mobile': '移动端导航',

      'theme.toggle': '切换浅色 / 深色主题',
      'theme.toLight': '切换到浅色主题',
      'theme.toDark': '切换到深色主题',
      'theme.light': '浅色',
      'theme.dark': '深色',

      'hero.role1': '全栈开发者',
      'hero.role2': '前端 · 后端 · 人工智能',
      'hero.lede': '后端出身，写了五年多服务。最近三年把重心挪到大模型上：从提示词到智能体，从 Coze、Dify 到把 Claude Code 和 DeepSeek Harness 揉进日常开发。下面这些项目，每一个都能在你自己的机器上启动。',
      'hero.ctaWork': '看作品',
      'hero.ctaContact': '联系我',
      'hero.status': '目前开放新机会',
      'hero.place': '江苏 · 南京',
      'hero.portrait': '薛小飞的照片',

      'photo.upload': '上传照片',
      'photo.processing': '处理中…',
      'photo.reset': '恢复默认',
      'photo.resetDone': '已恢复默认头像',
      'photo.notImage': '这个文件不是图片，选 jpg / png / webp 都行',
      'photo.cantRead': '这张图读不出宽高，换一张试试',
      'photo.broken': '这不是一张能打开的图片文件',
      'photo.cantProcess': '这张图没法处理，换一张试试',
      'photo.failed': '上传失败，换一张试试',
      'photo.done': '已换成本机照片 · {w}×{h}（{kb} KB，只存在你本机）',
      'photo.quota': '照片已显示，但这台浏览器存不下（换小一点的图，或刷新后需重传）',
      'photo.caption': '薛小飞 · Xue Xiaofei',

      'about.idx': '02',
      'about.title': '关于我',
      'about.note': '— 怎么做事，用什么做',
      'about.p1': '我写代码五年多，一直在后端这条线上：接口、数据、并发，以及上线之后被叫起来改的那部分。服务端最难的不是写出功能，是写完之后半年还有人敢动它。所以我在这里养成了一个习惯 —— 先把边界画清楚，再动手。',
      'about.p2': '最近三年我把重心挪到了 AI 上：做大模型应用开发，从提示词工程、RAG 检索到智能体编排，平台侧用过 Coze 和 Dify；同时把 Claude Code 和 DeepSeek Harness 这类 AI 编程工具真正揉进了日常开发流程 —— 不是拿它写个 demo，是让它参与需求分析、方案设计、代码生成和问题排查，然后自己逐行验收。',
      'about.p3': '所以我现在两头都要：后端保证它经得起跑，AI 保证它值得跑。不写代码的时候我在做木工 —— 锯一条直线和写一个函数是同一件事：手里的工具什么样，决定你能想到什么。',
      'about.tag1': '保留可读性',
      'about.tag2': '先跑起来再优化',
      'about.tag3': '接口即文档',
      'about.tag4': 'AI 写的代码逐行验收',
      'about.factsLabel': '基本信息',
      'about.fWhere': '现居',
      'about.fWhereV': '江苏 · 南京',
      'about.fRole': '方向',
      'about.fRoleV': '全栈 · 后端为主',
      'about.fExp': '经验',
      'about.fExpV': '5 年+ 后端，近 3 年转 AI',
      'about.fNow': '现在',
      'about.fNowV': '开放新机会',
      'about.fDoing': '在做',
      'about.fDoingV': '大模型应用 · 智能体编排',
      'about.fDaily': '每天用',
      'about.fDailyV': 'Claude Code · DeepSeek Harness',
      'about.skillsTitle': '技能',
      'about.skillsNote': '按"我用它做什么"分组，不按百分比',
      'about.skillsLead': '顺手的那一行是每天在用的，下面两行是清楚边界、能接进项目里的。',
      'about.skillsFine': '另外：Docker、Nginx、Git 工作流、Figma、Vite —— 每天都在用，就不占地方了。',
      'skills.backend': '我用来搭服务',
      'skills.ai': '我用来做 AI 应用',
      'skills.frontend': '我用来做界面',
      'skill.rest': 'REST 接口设计',
      'skill.auth': '鉴权与会话',
      'skill.perf': '并发与性能',
      'skill.logs': '日志与排查',
      'skill.llm': '大模型应用开发',
      'skill.prompt': '提示词工程',
      'skill.rag': 'RAG 检索增强',
      'skill.agent': '智能体编排',
      'skill.mcp': '工具调用 / MCP',
      'skill.vanilla': '原生 HTML / CSS / JS',
      'skill.responsive': '响应式布局',
      'skill.a11y': '无障碍',
      'skill.motion': '动画与滚动叙事',

      'work.idx': '03',
      'work.title': '项目',
      'work.note': '— 每个都能跑起来，代码都在 GitHub',
      'work.count': '{n} 个项目',
      'work.countUnit': '个项目',
      'work.countNote': ' · 持续新增',
      'work.hint': '打开任一仓库，按 README 里的两行命令即可本地运行',
      'work.allOnGithub': '在 GitHub 上查看全部项目',
      'work.moreNote': '新项目会陆续加到这个列表里',
      'work.source': '查看源码',
      'work.stackLabel': '技术栈',
      'work.thumbAlt': '{name} 界面示意图',
      'work.shotAlt': '{name} 界面截图',

      'gb.idx': '04',
      'gb.title': '留言板',
      'gb.note': '— 留一句，我会看',
      'gb.lead': '有什么想说的就写在这儿：建议、合作、或者只是打个招呼。想私下聊就走上面的邮件。',
      'gb.nameLabel': '称呼',
      'gb.namePlaceholder': '怎么称呼你（可留空）',
      'gb.textLabel': '留言',
      'gb.textPlaceholder': '想说的话…',
      'gb.submit': '发布留言',
      'gb.sending': '发送中…',
      'gb.privacy': '留言会公开显示在下方。请不要写敏感信息。',
      'gb.total': '已有 {n} 条留言',
      'gb.empty': '还没有人留言。第一个说什么都行。',
      'gb.more': '看更早的留言',
      'gb.loading': '加载中…',
      'gb.anon': '匿名访客',
      'gb.justNow': '刚刚',
      'gb.minutesAgo': '{n} 分钟前',
      'gb.hoursAgo': '{n} 小时前',
      'gb.daysAgo': '{n} 天前',
      'gb.offline': '留言板需要在服务器模式下运行（node server.js）。现在读不到留言，稍后再试。',
      'gb.emptyMsg': '写点什么再发吧。',
      'gb.lowQuality': '这条留言看起来不太像正常内容，改一下再发。',
      'gb.errEmpty': '留言不能为空。',
      'gb.errShort': '留言太短了，多说几个字？',
      'gb.errLow': '这条留言看起来不太像正常内容，改一下再发。',
      'gb.errRateWait': '发得有点快，等 {n} 秒再发。',
      'gb.errRateDay': '今天留言有点多了，明天再来吧。',
      'gb.errTooLarge': '留言太长了，精简一下。',
      'gb.errFail': '没发出去（{n}）。服务器在跑吗？',
      'gb.errNetwork': '连不上服务器。留言板需要 node server.js 在运行。',
      'gb.ok': '收到，谢谢留言。',
      'gb.justPosted': '刚刚',

      'stats.views': '访问',
      'stats.today': '今日',
      'stats.visitors': '访客',
      'stats.since': '自 {d}',
      'stats.trend': '近 14 天访问量',
      'stats.todayLabel': '今日 {n}',
      'stats.label': '访问统计',

      'contact.idx': '05',
      'contact.title': '联系',
      'contact.note': '— 想做点什么，或者只是想聊聊',
      'contact.lead': '有新项目、有岗位、或者你只是看到一个觉得还可以更好的地方 —— 都欢迎直接找我。我一般在两个工作日内回复。',
      'contact.copyEmail': '复制邮箱',
      'contact.copied': '已复制 ✓',
      'contact.copyFail': '复制失败，请手动选中',
      'contact.note2': '邮件不需要主题格式，直接说事就行。',

      'foot.note': '纯静态前端，零依赖，零追踪。用原生 HTML / CSS / JS 手写。',
      'foot.top': '回到顶部',

      'link.email': '邮件',
      'link.emailNote': '最直接的方式 · 两个工作日内回复',
      'link.githubNote': '本页所有项目的源码都在这里',
      'link.wechat': '微信',
      'link.wechatNote': '加的时候说一声是从这里来的',
    },

    en: {
      'meta.title': 'Xue Xiaofei · Portfolio',
      'meta.desc': 'Xue Xiaofei — full-stack engineer, backend by trade, three years deep into LLM and AI applications.',

      'lang.switch': '中文',
      'lang.name': 'English',
      'lang.short': 'EN',

      'nav.about': 'About',
      'nav.work': 'Work',
      'nav.guestbook': 'Guestbook',
      'nav.contact': 'Contact',
      'nav.index': 'Page index',
      'nav.home': 'Back to top',
      'nav.mobile': 'Mobile navigation',

      'theme.toggle': 'Switch light / dark theme',
      'theme.toLight': 'Switch to light theme',
      'theme.toDark': 'Switch to dark theme',
      'theme.light': 'Light',
      'theme.dark': 'Dark',

      'hero.role1': 'Full-stack engineer',
      'hero.role2': 'frontend · backend · AI',
      'hero.lede': 'Five years of backend services — APIs, data, concurrency, the 3am pages. For the last three I have been working on large language models: prompt engineering, RAG, agent orchestration with Coze and Dify, and weaving Claude Code and DeepSeek Harness into my daily workflow. Every project below runs on your own machine.',
      'hero.ctaWork': 'See the work',
      'hero.ctaContact': 'Get in touch',
      'hero.status': 'Open to new opportunities',
      'hero.place': 'Nanjing, Jiangsu · China',
      'hero.portrait': 'Portrait of Xue Xiaofei',

      'photo.upload': 'Upload a photo',
      'photo.processing': 'Working…',
      'photo.reset': 'Use default',
      'photo.resetDone': 'Back to the default photo',
      'photo.notImage': 'That file is not an image — use jpg / png / webp.',
      'photo.cantRead': 'Could not read that image. Try another one.',
      'photo.broken': 'That file could not be opened as an image.',
      'photo.cantProcess': 'That image could not be processed. Try another one.',
      'photo.failed': 'Upload failed. Try another image.',
      'photo.done': 'Using your photo · {w}×{h} ({kb} KB, stored only on this device)',
      'photo.quota': 'Photo is showing, but this browser could not store it (use a smaller image, or re-upload after a refresh).',
      'photo.caption': 'Xue Xiaofei · 薛小飞',

      'about.idx': '02',
      'about.title': 'About',
      'about.note': '— how I work, and with what',
      'about.p1': 'I have been writing code for a bit over five years, all of it on the backend: APIs, data, concurrency, and the part you get woken up for after a release. The hard part of a service is never shipping the feature — it is that someone still dares to change it six months later. So I picked up one habit: draw the boundary first, then write code.',
      'about.p2': 'For the past three years I have moved my focus to AI: building LLM applications — prompt engineering, retrieval-augmented generation, agent orchestration — and working with platforms like Coze and Dify. At the same time I folded AI coding tools such as Claude Code and DeepSeek Harness into my everyday process. Not to generate a demo, but to let them take part in requirements, design, code generation and debugging — with me reviewing every line.',
      'about.p3': 'So these days I want both: the backend to make it hold up, the AI to make it worth building. When I am not coding I do woodworking — cutting a straight line and writing a function are the same job: the tools in your hand decide what you can think of.',
      'about.tag1': 'Readability first',
      'about.tag2': 'Working beats perfect',
      'about.tag3': 'The API is the doc',
      'about.tag4': 'Review every AI-generated line',
      'about.factsLabel': 'Quick facts',
      'about.fWhere': 'Based in',
      'about.fWhereV': 'Nanjing, Jiangsu',
      'about.fRole': 'Focus',
      'about.fRoleV': 'Full-stack · backend-leaning',
      'about.fExp': 'Experience',
      'about.fExpV': '5+ yrs backend, last 3 in AI',
      'about.fNow': 'Status',
      'about.fNowV': 'Open to new opportunities',
      'about.fDoing': 'Building',
      'about.fDoingV': 'LLM apps · agent orchestration',
      'about.fDaily': 'Daily tools',
      'about.fDailyV': 'Claude Code · DeepSeek Harness',
      'about.skillsTitle': 'Skills',
      'about.skillsNote': 'grouped by what I use them for, not by percentage',
      'about.skillsLead': 'The first row is what I reach for daily; the two below are things I know the edges of and can build with.',
      'about.skillsFine': 'Also: Docker, Nginx, Git workflows, Figma, Vite — used daily, so they do not need the space.',
      'skills.backend': 'Backend services',
      'skills.ai': 'AI applications',
      'skills.frontend': 'Interfaces',
      'skill.rest': 'REST API design',
      'skill.auth': 'auth & sessions',
      'skill.perf': 'concurrency & performance',
      'skill.logs': 'logging & debugging',
      'skill.llm': 'LLM application development',
      'skill.prompt': 'prompt engineering',
      'skill.rag': 'RAG retrieval',
      'skill.agent': 'agent orchestration',
      'skill.mcp': 'tool calling / MCP',
      'skill.vanilla': 'vanilla HTML / CSS / JS',
      'skill.responsive': 'responsive layout',
      'skill.a11y': 'accessibility',
      'skill.motion': 'motion & scroll narrative',

      'work.idx': '03',
      'work.title': 'Work',
      'work.note': '— each one runs, all the code is on GitHub',
      'work.count': '{n} projects',
      'work.countUnit': 'projects',
      'work.countNote': ' · more to come',
      'work.hint': 'Open any repo and run the two commands in its README',
      'work.allOnGithub': 'See everything on GitHub',
      'work.moreNote': 'new projects get added to this list',
      'work.source': 'View source',
      'work.stackLabel': 'Tech stack',
      'work.thumbAlt': 'Schematic of the {name} interface',
      'work.shotAlt': 'Screenshot of {name}',

      'gb.idx': '04',
      'gb.title': 'Guestbook',
      'gb.note': '— say something, I read all of it',
      'gb.lead': 'Feedback, collaboration, or just hello — leave it here. For anything private, email me instead.',
      'gb.nameLabel': 'Name',
      'gb.namePlaceholder': 'What should I call you? (optional)',
      'gb.textLabel': 'Message',
      'gb.textPlaceholder': 'What is on your mind…',
      'gb.submit': 'Post message',
      'gb.sending': 'Posting…',
      'gb.privacy': 'Messages appear publicly below. Please do not include anything sensitive.',
      'gb.total': '{n} messages so far',
      'gb.empty': 'No messages yet. The first one can say anything.',
      'gb.more': 'Load earlier messages',
      'gb.loading': 'Loading…',
      'gb.anon': 'Anonymous',
      'gb.justNow': 'just now',
      'gb.minutesAgo': '{n} min ago',
      'gb.hoursAgo': '{n} h ago',
      'gb.daysAgo': '{n} d ago',
      'gb.offline': 'The guestbook needs the Node server (node server.js). Messages are unavailable right now.',
      'gb.emptyMsg': 'Write something before posting.',
      'gb.lowQuality': 'That does not look like a real message — please reword it.',
      'gb.errEmpty': 'The message cannot be empty.',
      'gb.errShort': 'That is a little short — say a bit more?',
      'gb.errLow': 'That does not look like a real message — please reword it.',
      'gb.errRateWait': 'That was quick — try again in {n}s.',
      'gb.errRateDay': 'Quite a few messages today. Please come back tomorrow.',
      'gb.errTooLarge': 'That message is too long — trim it down.',
      'gb.errFail': 'Could not post ({n}). Is the server running?',
      'gb.errNetwork': 'Cannot reach the server. The guestbook needs node server.js running.',
      'gb.ok': 'Got it — thanks for writing.',
      'gb.justPosted': 'just now',

      'stats.views': 'views',
      'stats.today': 'today',
      'stats.visitors': 'visitors',
      'stats.since': 'since {d}',
      'stats.trend': 'Views over the last 14 days',
      'stats.todayLabel': 'today {n}',
      'stats.label': 'Visit statistics',

      'contact.idx': '05',
      'contact.title': 'Contact',
      'contact.note': '— building something, or just want to talk',
      'contact.lead': 'New projects, open roles, or something you spotted that could be better — write to me directly. I usually reply within two working days.',
      'contact.copyEmail': 'Copy email',
      'contact.copied': 'Copied ✓',
      'contact.copyFail': 'Copy failed — please select it manually',
      'contact.note2': 'No subject line needed. Just say what you need.',

      'foot.note': 'Static front end, zero dependencies, zero tracking. Hand-written HTML / CSS / JS.',
      'foot.top': 'Back to top',

      'link.email': 'Email',
      'link.emailNote': 'The most direct way · reply within two working days',
      'link.githubNote': 'Source for every project on this page',
      'link.wechat': 'WeChat',
      'link.wechatNote': 'Mention you found me here',
    }
  };

  var LANG_KEY = 'portfolio.lang';
  var lang = /^en$/.test(document.documentElement.getAttribute('data-lang') || '') ? 'en' : 'zh';

  /** 取一条文案，{n} 之类的占位符用 vars 替换 */
  function t(key, vars) {
    var table = I18N[lang] || I18N.zh;
    var s = table[key];
    if (s == null) s = (I18N.zh[key] != null ? I18N.zh[key] : key);
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = s.split('{' + k + '}').join(String(vars[k]));
      });
    }
    return s;
  }

  function localeTag() { return lang === 'en' ? 'en-US' : 'zh-CN'; }

  /* ============================================================
     2. 内容（改这个站基本只用动这里）
     ============================================================ */

  /** 中英双语文案的小工具：L('中文','English') 按当前语言取一个 */
  function L(zh, en) { return { zh: zh, en: en }; }

  /** 当前语言下的实际文本 */
  function pick(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    return v[lang] != null ? v[lang] : (v.zh || '');
  }

  var GITHUB_PROFILE = 'https://github.com/BlueQBL';
  var REPO = GITHUB_PROFILE + '/DSH-program/tree/main/';

  var site = {
    owner: '薛小飞',
    email: 'xuexiaofei666@proton.me',
    github: GITHUB_PROFILE,
    repo: REPO,

    links: [
      {
        kindKey: 'link.email',
        label: 'xuexiaofei666@proton.me',
        noteKey: 'link.emailNote',
        copy: 'xuexiaofei666@proton.me'
      },
      {
        kindKey: 'GitHub',
        label: 'github.com/BlueQBL',
        noteKey: 'link.githubNote',
        href: GITHUB_PROFILE
      },
      {
        kindKey: 'link.wechat',
        label: 'Xxf_nevergiveup',
        noteKey: 'link.wechatNote',
        copy: 'Xxf_nevergiveup'
      }
    ],

    projects: [
      {
        name: L('图片压缩工具', 'Image Compressor'),
        sub: L('Image Compressor · 前后端完整站点', 'Image Compressor · full-stack site'),
        year: '2026.09',
        desc: L(
          '拖入、粘贴或批量上传图片，拖滑杆调质量，按住左右拖动就能对比原图和压缩后的差别。全部压完一键打包成 zip 下载。图片只在本机处理，临时文件一小时自动清掉。',
          'Drag, paste or batch-upload images, pull a slider to set quality, then press and drag across any result to compare it with the original. Download one file or zip the whole batch. Images are processed on the machine and temp files are cleared after an hour.'
        ),
        stack: ['Node.js', 'Express', 'Sharp', 'Multer', 'Archiver', 'Vanilla JS'],
        href: REPO + 'image-compressor',
        shot: './assets/shots/image-compressor.png',
        cap: L('压缩前 / 后', 'before / after'),
        art: artCompressor
      },
      {
        name: L('流水账', 'Ledger'),
        sub: L('个人记账 · 零依赖 PWA', 'personal finance · dependency-free PWA'),
        year: '2026.09',
        desc: L(
          '只做四件事的记账应用：快速记一笔、按日期翻记录、看月度统计、数据只留在本机。整页是一卷热敏纸压在深墨绿桌垫上，只用墨黑和热敏红两种墨，分类占比画成条码 —— 顺便绕开了红绿色盲。',
          'A bookkeeping app that does exactly four things: log an entry fast, browse by date, see monthly totals, keep every byte on your own device. The whole page is a thermal receipt on a dark green desk mat, printed in two inks only — black and thermal red — with category shares drawn as a barcode. It also happens to be colour-blind safe.'
        ),
        stack: ['Vanilla HTML', 'CSS', 'JavaScript', 'PWA', 'LocalStorage'],
        href: REPO + 'ledger',
        shot: './assets/shots/ledger.png',
        cap: L('热敏小票', 'receipt ledger'),
        art: artLedger
      },
      {
        name: L('水尺 · 喝水提醒', 'Water Gauge'),
        sub: L('会到点催你的小工具', 'a reminder that actually nags you'),
        year: '2026.09',
        desc: L(
          '一根带刻度的量水尺：左边是毫升刻线，右边是"几点该喝到多少"的计划标记，水面之上的斜线缺口就是你现在欠的水量。到点通过页面横幅、桌面通知、合成提示音和标签标题四条通道提醒，间隔从上次喝水开始算。',
          'A measuring stick for water. Millilitre marks on the left, scheduled targets ("by 15:00 you should be here") on the right, and the hatched gap above the water line is exactly how much you owe. Reminders arrive on four channels — in-page banner, desktop notification, a synthesised two-note chime, and the tab title — timed from your last drink.'
        ),
        stack: ['Vanilla HTML', 'CSS', 'Web Audio', 'Notification API', 'LocalStorage'],
        href: REPO + 'water-reminder',
        shot: './assets/shots/water-reminder.png',
        cap: L('水位刻度', 'water level'),
        art: artWater
      },
      {
        name: L('狼人杀 · 九人局', 'Werewolf · 9-player game'),
        sub: L('你和八个 AI 玩家', 'you and eight AI players'),
        year: '2026.09',
        desc: L(
          '一个能在浏览器里打完的九人标准局：3 狼人、预言家、女巫、猎人、3 平民，你坐一席，其余八人由 AI 扮演。最有意思的是验证部分 —— 一条命令跑 400 局无头模拟，再加上重排隐藏身份验证机器人没有偷看底牌。',
          'A complete nine-player Werewolf game in the browser: three wolves, seer, witch, hunter and three villagers. You take one seat; AI plays the other eight. The interesting part is verification — one command runs 400 headless games, then reshuffles hidden roles to prove the bots never peeked at the deck.'
        ),
        stack: ['Vue 3', 'Vite', 'headless simulation', 'rule audit', 'SSR smoke test'],
        href: REPO + 'werewolf-game',
        shot: './assets/shots/werewolf-game.png',
        cap: L('牌桌', 'table view'),
        art: artWerewolf
      },
      {
        name: L('JWT 认证演示', 'JWT Auth Demo'),
        sub: L('前后端联调样板', 'a reference for wiring auth end to end'),
        year: '2026.09',
        desc: L(
          '一个把"注册、登录、带令牌访问受保护接口"讲清楚的样板：后端签发令牌并用拦截器校验，前端用 Axios 拦截器带上令牌、用路由守卫拦住未登录访问，令牌过期自动退出登录。没引 Spring Security，整条链路是透明的。',
          'A reference project that makes "register, log in, call a protected endpoint" completely legible: the backend signs a token and validates it in an interceptor; the front end attaches it with an Axios interceptor, guards routes, and logs out when the token expires. No Spring Security — every step of the chain is visible.'
        ),
        stack: ['Spring Boot 3', 'Spring Data JPA', 'JWT', 'BCrypt', 'Vue 3', 'Pinia'],
        href: REPO + 'backend',
        shot: './assets/shots/jwt-auth.png',
        cap: L('认证流程', 'auth flow'),
        art: artAuth
      },
      {
        name: L('React Router 演示', 'React Router Demo'),
        sub: L('升级到 React Router 7 的路由样板', 'routing, upgraded to React Router 7'),
        year: '2026.09',
        desc: L(
          '一个最小但完整的 React + TypeScript 应用，专门演示路由：嵌套布局用 Outlet 承载页面，导航项按当前地址自动高亮，未声明的地址优雅回退到 404 页。顺手把 Vite 5→7、React Router 6→7 升了一遍，npm audit 归零。',
          'A small but complete React + TypeScript app built to demonstrate routing: a nested layout renders pages through Outlet, nav items highlight by current path, and unknown paths fall back to a proper 404. Along the way Vite went 5→7 and React Router 6→7, taking npm audit to zero.'
        ),
        stack: ['React 19', 'TypeScript', 'React Router 7', 'Vite 7'],
        href: REPO + 'react-frontend',
        shot: './assets/shots/react-router.png',
        cap: L('路由结构', 'route map'),
        art: artRouter
      }
    ]
  };

  /* ============================================================
     3. 缩略图：每个项目一张按它视觉母题手写的 SVG
     ============================================================ */
  var THUMB_W = 640;
  var THUMB_H = 400;

  /** 缩略图与卡片都用"当前语言下"的文本 */
  function projectOf(p) {
    return {
      name: pick(p.name),
      sub: pick(p.sub),
      desc: pick(p.desc),
      cap: pick(p.cap),
      year: p.year,
      stack: p.stack,
      href: p.href,
      shot: p.shot,
      art: p.art
    };
  }

  /** 所有缩略图共用的外框，具体的画各自叠加 */
  function thumb(art, title) {
    return '<svg viewBox="0 0 ' + THUMB_W + ' ' + THUMB_H + '" role="img" aria-label="' +
      escapeHTML(t('work.thumbAlt', { name: title })) + '" preserveAspectRatio="xMidYMid slice">' +
      '<rect width="' + THUMB_W + '" height="' + THUMB_H + '" fill="#0e151b"/>' +
      art +
      '</svg>';
  }

  /** 卡片里的截图：真实截图优先，缺图或加载失败时回落到 SVG */
  function media(p) {
    var fallback = escapeHTML(thumb(p.art, p.name));
    return '<img src="' + p.shot + '" alt="' + escapeHTML(t('work.shotAlt', { name: p.name })) +
      '" loading="lazy" decoding="async" onerror="this.outerHTML=this.dataset.fb" data-fb="' + fallback + '" />';
  }

  function escapeHTML(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---- 01 图片压缩：并排对比 ---- */
  function artCompressor() {
    var s = '<g transform="translate(40 36)">';
    for (var i = 0; i < 2; i++) {
      var x = i * 290;
      s += '<rect x="' + x + '" y="0" width="250" height="272" rx="14" fill="#121b22" stroke="#22323f"/>';
      s += '<rect x="' + (x + 18) + '" y="18" width="214" height="140" rx="8" fill="' + (i ? '#15343a' : '#1a2530') + '"/>';
      for (var k = 0; k < 5; k++) {
        s += '<path d="M' + (x + 40 + k * 26) + ' 158 L' + (x + 70 + k * 26) + ' 22" stroke="' +
             (i ? '#2f6f70' : '#2c3b48') + '" stroke-width="10" stroke-linecap="round"/>';
      }
      s += '<path d="M' + (x + 210) + ' 142 l-16 -22 -14 26 -10 -14 -12 10" fill="none" stroke="' + (i ? '#4fd1c5' : '#3d5062') + '" stroke-width="3" stroke-linejoin="round"/>';
      s += '<rect x="' + (x + 18) + '" y="178" width="152" height="8" rx="4" fill="#243240"/>';
      s += '<rect x="' + (x + 18) + '" y="178" width="' + (i ? 46 : 152) + '" height="8" rx="4" fill="' + (i ? '#4fd1c5' : '#5a6d7d') + '"/>';
      s += '<text x="' + (x + 18) + '" y="212" fill="' + (i ? '#6ee0d4' : '#7e8f9d') + '" font-family="monospace" font-size="22" font-weight="700">' + (i ? '184 KB' : '2.1 MB') + '</text>';
      s += '<text x="' + (x + 18) + '" y="240" fill="#5b6a78" font-family="monospace" font-size="12" letter-spacing="2">' + (i ? 'AFTER · Q70' : 'BEFORE · ORIGINAL') + '</text>';
    }
    s += '</g>';
    s += '<rect x="312" y="130" width="18" height="86" rx="9" fill="#0e151b" stroke="#4fd1c5" stroke-width="2"/>';
    s += '<path d="M318 152 l-6 8 6 8M324 152 l6 8 -6 8" fill="none" stroke="#4fd1c5" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
    s += '<rect x="190" y="332" width="260" height="40" rx="20" fill="#4fd1c5"/>';
    s += '<text x="320" y="358" text-anchor="middle" fill="#07120f" font-family="monospace" font-size="15" font-weight="700" letter-spacing="1">' +
      (lang === 'en' ? 'DOWNLOAD ALL AS ZIP (6)' : '打包下载全部 (6)') + '</text>';
    return s;
  }

  /* ---- 02 流水账：热敏小票 ---- */
  function artLedger() {
    var s = '';
    s += '<rect width="640" height="400" fill="#101a14"/>';
    for (var k = 0; k < 40; k++) {
      s += '<path d="M' + (6 + k * 16) + ' 400 L' + (26 + k * 16) + ' 0" stroke="#16241c" stroke-width="1"/>';
    }
    for (var t2 = 0; t2 < 14; t2++) {
      s += '<path d="M' + (158 + t2 * 24) + ' 44 l12 -14 12 14z" fill="#f1f1ec"/>';
    }
    s += '<rect x="158" y="44" width="324" height="298" fill="#f1f1ec"/>';
    s += '<text x="182" y="86" fill="#23282a" font-family="monospace" font-size="17" font-weight="700" letter-spacing="4">' +
      (lang === 'en' ? 'LEDGER' : '流水账') + '</text>';
    s += '<text x="182" y="108" fill="#8b8f8b" font-family="monospace" font-size="10" letter-spacing="2">2026-09 · MONTHLY</text>';
    s += '<path d="M182 122 H458" stroke="#c9c9c2" stroke-width="1" stroke-dasharray="4 4"/>';
    var rows = lang === 'en'
      ? [['Food', '-1,286.50'], ['Transit', '-342.00'], ['Writing', '+8,000.00']]
      : [['餐饮', '-1,286.50'], ['交通', '-342.00'], ['稿费', '+8,000.00']];
    rows.forEach(function (r, i) {
      var y = 152 + i * 28;
      s += '<text x="182" y="' + y + '" fill="#23282a" font-family="monospace" font-size="13">' + r[0] + '</text>';
      s += '<text x="458" y="' + y + '" text-anchor="end" fill="' + (r[1][0] === '-' ? '#b8322a' : '#23282a') +
        '" font-family="monospace" font-size="13" font-weight="700">' + r[1] + '</text>';
    });
    s += '<path d="M182 224 H458" stroke="#c9c9c2" stroke-width="1" stroke-dasharray="4 4"/>';
    var widths = [7, 3, 11, 5, 3, 9, 4, 13, 3, 6, 4, 3, 8, 3, 7, 4, 3, 10, 5, 3, 6, 3, 9, 4, 7, 3, 5, 11, 3, 4, 8, 3, 6, 3, 9, 4, 5, 3, 7, 12, 3, 6, 4, 3, 8, 5, 3, 9, 4, 3];
    var bx = 182;
    for (var i = 0; i < widths.length; i++) {
      bx += widths[i] + 1;
      if (bx > 456) break;
      s += '<rect x="' + bx + '" y="240" width="' + widths[i] + '" height="46" fill="#23282a"/>';
    }
    s += '<text x="182" y="308" fill="#8b8f8b" font-family="monospace" font-size="10" letter-spacing="2">' +
      (lang === 'en' ? 'FOOD 61% · TRANSIT 16% · OTHER 8%' : '餐饮 61% · 交通 16% · 其他 8%') + '</text>';
    s += '<text x="182" y="326" fill="#23282a" font-family="monospace" font-size="11" font-weight="700">' +
      (lang === 'en' ? 'LOCAL DATA · NEVER UPLOADED' : '本机数据 · 未上传') + '</text>';
    return s;
  }

  /* ---- 03 水尺：刻度与水位 ---- */
  function artWater() {
    var s = '<rect width="640" height="400" fill="#0d161c"/>';
    s += '<circle cx="520" cy="60" r="150" fill="#123039" opacity="0.5"/>';
    s += '<rect x="96" y="46" width="132" height="308" rx="18" fill="#111c24" stroke="#25404a"/>';
    s += '<rect x="98" y="178" width="128" height="174" rx="16" fill="#1d5b62"/>';
    s += '<path d="M98 178 h128 l-128 34z" fill="#4fd1c5" opacity="0.85"/>';
    for (var k = 0; k < 7; k++) {
      s += '<path d="M' + (108 + k * 18) + ' 352 L' + (136 + k * 18) + ' 200" stroke="#4fd1c5" stroke-width="2" opacity="0.28"/>';
    }
    for (var i = 0; i <= 10; i++) {
      var y = 56 + i * 29;
      var major = i % 2 === 0;
      s += '<path d="M' + (major ? 106 : 116) + ' ' + y + ' H' + (major ? 134 : 128) + '" stroke="#3d5d69" stroke-width="1.6"/>';
      if (major) s += '<text x="208" y="' + (y + 4) + '" fill="#6c8b96" font-family="monospace" font-size="10">' + (2000 - i * 200) + '</text>';
    }
    var plan = [['08:00', 60], ['11:00', 122], ['15:00', 214], ['19:00', 306]];
    for (var j = 0; j < plan.length; j++) {
      s += '<circle cx="238" cy="' + plan[j][1] + '" r="5" fill="#e6a758"/>';
      s += '<path d="M132 ' + plan[j][1] + ' H232" stroke="#e6a758" stroke-width="1" stroke-dasharray="3 5" opacity="0.65"/>';
      s += '<text x="250" y="' + (plan[j][1] + 4) + '" fill="#a8834d" font-family="monospace" font-size="11">' + plan[j][0] + '</text>';
    }
    s += '<rect x="84" y="170" width="156" height="16" rx="8" fill="#4fd1c5"/>';
    s += '<circle cx="162" cy="178" r="7" fill="#0d161c" stroke="#4fd1c5" stroke-width="3"/>';
    s += '<text x="352" y="122" fill="#eef4f7" font-family="monospace" font-size="52" font-weight="700">1,240</text>';
    s += '<text x="352" y="150" fill="#6c8b96" font-family="monospace" font-size="13" letter-spacing="2">ML / 2000 ML</text>';
    s += '<rect x="352" y="176" width="200" height="10" rx="5" fill="#1d2c36"/>';
    s += '<rect x="352" y="176" width="124" height="10" rx="5" fill="#4fd1c5"/>';
    s += '<text x="352" y="216" fill="#e6a758" font-family="monospace" font-size="12">' +
      (lang === 'en' ? 'NEXT CUP · 31 MIN SINCE LAST' : '下一杯 · 距离上次 31 分钟') + '</text>';
    s += '<rect x="352" y="238" width="96" height="34" rx="17" fill="#16232c" stroke="#2b414d"/>';
    s += '<text x="400" y="260" text-anchor="middle" fill="#a8bcc6" font-family="monospace" font-size="12">150 ml</text>';
    s += '<rect x="458" y="238" width="96" height="34" rx="17" fill="#16232c" stroke="#2b414d"/>';
    s += '<text x="506" y="260" text-anchor="middle" fill="#a8bcc6" font-family="monospace" font-size="12">250 ml</text>';
    s += '<rect x="352" y="290" width="202" height="64" rx="12" fill="#111c24" stroke="#243a45"/>';
    s += '<text x="366" y="314" fill="#6c8b96" font-family="monospace" font-size="10" letter-spacing="2">' +
      (lang === 'en' ? 'LAST 7 DAYS' : '最近 7 天') + '</text>';
    var bars = [16, 26, 12, 30, 22, 34, 18];
    for (var b = 0; b < bars.length; b++) {
      s += '<rect x="' + (366 + b * 26) + '" y="' + (344 - bars[b]) + '" width="14" height="' + bars[b] + '" rx="3" fill="#2f7d80"/>';
    }
    return s;
  }

  /* ---- 04 狼人杀：牌桌 ---- */
  function artWerewolf() {
    var s = '<rect width="640" height="400" fill="#0d1117"/>';
    s += '<circle cx="320" cy="200" r="138" fill="#131c26" stroke="#26394b" stroke-width="2"/>';
    s += '<circle cx="320" cy="200" r="92" fill="#0f1720" stroke="#1f2f3e"/>';
    s += '<text x="320" y="196" text-anchor="middle" fill="#e9eef3" font-family="monospace" font-size="22" font-weight="700" letter-spacing="3">' +
      (lang === 'en' ? 'DAY 2' : '第 2 天') + '</text>';
    s += '<text x="320" y="220" text-anchor="middle" fill="#6d8296" font-family="monospace" font-size="11" letter-spacing="2">' +
      (lang === 'en' ? 'DAY · VOTING' : '白天 · 投票中') + '</text>';
    var roles = ['1', 'W', '3', 'V', 'S', '6', '7', 'V', '9'];
    for (var i = 0; i < 9; i++) {
      var a = -Math.PI / 2 + (i * 2 * Math.PI) / 9;
      var cx = 320 + Math.cos(a) * 138;
      var cy = 200 + Math.sin(a) * 138;
      var me = i === 0;
      s += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="25" fill="#141d26" stroke="' + (me ? '#4fd1c5' : '#2b3d4e') + '" stroke-width="' + (me ? 3 : 2) + '"/>';
      s += '<text x="' + cx.toFixed(1) + '" y="' + (cy + 7).toFixed(1) + '" text-anchor="middle" fill="' + (roles[i] === 'W' ? '#c0563f' : '#c8d4de') + '" font-family="monospace" font-size="17" font-weight="700">' + roles[i] + '</text>';
      if (!me) s += '<circle cx="' + (cx + 22).toFixed(1) + '" cy="' + (cy - 20).toFixed(1) + '" r="5" fill="#4e8f6b"/>';
    }
    s += '<rect x="252" y="342" width="136" height="34" rx="17" fill="#4fd1c5"/>';
    s += '<text x="320" y="364" text-anchor="middle" fill="#07120f" font-family="monospace" font-size="13" font-weight="700">' +
      (lang === 'en' ? 'VOTE OUT' : '投票放逐') + '</text>';
    s += '<text x="252" y="46" fill="#8aa0b2" font-family="monospace" font-size="12" letter-spacing="2">' +
      (lang === 'en' ? '3 WOLVES · SEER · WITCH · HUNTER · 3 VILLAGERS' : '3 狼 · 预 · 女 · 猎 · 3 民') + '</text>';
    s += '<text x="520" y="46" fill="#e6a758" font-family="monospace" font-size="11" letter-spacing="1">AI x8</text>';
    return s;
  }

  /* ---- 05 认证：请求流 ---- */
  function artAuth() {
    var s = '<rect width="640" height="400" fill="#0b1015"/>';
    s += '<rect x="36" y="60" width="228" height="280" rx="16" fill="#131d26" stroke="#22323f"/>';
    s += '<rect x="62" y="86" width="176" height="34" rx="8" fill="#0e151c" stroke="#24343f"/>';
    s += '<text x="74" y="108" fill="#4b5d6b" font-family="monospace" font-size="11">username</text>';
    s += '<rect x="62" y="130" width="176" height="34" rx="8" fill="#0e151c" stroke="#24343f"/>';
    s += '<text x="74" y="152" fill="#4b5d6b" font-family="monospace" font-size="11">••••••••</text>';
    s += '<rect x="62" y="180" width="176" height="36" rx="8" fill="#3d7fbf"/>';
    s += '<text x="150" y="204" text-anchor="middle" fill="#eaf3fb" font-family="monospace" font-size="12" font-weight="700">' +
      (lang === 'en' ? 'SIGN IN' : '登录') + '</text>';
    s += '<text x="62" y="246" fill="#5b6f7e" font-family="monospace" font-size="10" letter-spacing="1">' +
      (lang === 'en' ? 'BCRYPT VERIFIED' : 'BCrypt 校验通过') + '</text>';
    s += '<rect x="62" y="258" width="176" height="60" rx="8" fill="#101820" stroke="#24343f"/>';
    s += '<text x="74" y="278" fill="#4fd1c5" font-family="monospace" font-size="10">Authorization:</text>';
    s += '<text x="74" y="296" fill="#8fa8b8" font-family="monospace" font-size="10">Bearer eyJhbGci…</text>';
    s += '<text x="74" y="312" fill="#5b6f7e" font-family="monospace" font-size="9">exp 24h · HS256</text>';
    var steps = ['POST /login', 'issue JWT', 'GET /me', '200 OK'];
    for (var i = 0; i < steps.length; i++) {
      var y = 74 + i * 72;
      var ok = i === 3;
      s += '<rect x="308" y="' + y + '" width="296" height="52" rx="10" fill="' + (ok ? '#12292c' : '#121b22') + '" stroke="' + (ok ? '#2c6b6b' : '#22323f') + '"/>';
      s += '<circle cx="332" cy="' + (y + 26) + '" r="6" fill="' + (ok ? '#4fd1c5' : '#3d5062') + '"/>';
      s += '<text x="352" y="' + (y + 32) + '" fill="' + (ok ? '#6ee0d4' : '#8fa8b8') + '" font-family="monospace" font-size="13">' + steps[i] + '</text>';
      if (i < 3) s += '<path d="M456 ' + (y + 54) + ' V' + (y + 72) + '" stroke="#2b414d" stroke-width="2"/>';
    }
    s += '<text x="308" y="366" fill="#5b6f7e" font-family="monospace" font-size="10" letter-spacing="2">INTERCEPTOR · ROUTE GUARD</text>';
    return s;
  }

  /* ---- 06 路由：嵌套布局 ---- */
  function artRouter() {
    var s = '<rect width="640" height="400" fill="#0c1116"/>';
    s += '<rect x="30" y="30" width="580" height="340" rx="16" fill="#111a22" stroke="#22323f"/>';
    s += '<rect x="30" y="30" width="580" height="46" rx="16" fill="#0e151c"/>';
    s += '<rect x="30" y="60" width="580" height="16" fill="#0e151c"/>';
    s += '<path d="M30 76 H610" stroke="#22323f"/>';
    s += '<text x="56" y="58" fill="#e9eef3" font-family="monospace" font-size="12" font-weight="700">REACT ROUTER</text>';
    var labels = lang === 'en' ? ['Home', 'About', 'Work', '404'] : ['首页', '关于', '作品', '404'];
    var nx = 300;
    for (var i = 0; i < 4; i++) {
      var active = i === 1;
      var w = 58 + labels[i].length * 2;
      s += '<rect x="' + nx + '" y="44" width="' + w + '" height="24" rx="12" fill="' + (active ? '#173b3c' : 'transparent') + '" stroke="' + (active ? '#2f6f70' : '#233442') + '"/>';
      s += '<text x="' + (nx + w / 2) + '" y="60" text-anchor="middle" fill="' + (active ? '#6ee0d4' : '#7e8f9d') + '" font-family="monospace" font-size="10">' + labels[i] + '</text>';
      nx += w + 8;
    }
    s += '<rect x="56" y="102" width="528" height="196" rx="12" fill="#0d151c" stroke="#1f2f3e"/>';
    s += '<text x="76" y="132" fill="#4fd1c5" font-family="monospace" font-size="11" letter-spacing="1">&lt;Outlet /&gt;</text>';
    s += '<rect x="76" y="150" width="240" height="14" rx="7" fill="#1c2a36"/>';
    s += '<rect x="76" y="176" width="392" height="10" rx="5" fill="#182430"/>';
    s += '<rect x="76" y="196" width="344" height="10" rx="5" fill="#182430"/>';
    s += '<rect x="76" y="222" width="120" height="52" rx="8" fill="#141f29" stroke="#22323f"/>';
    s += '<rect x="208" y="222" width="120" height="52" rx="8" fill="#141f29" stroke="#22323f"/>';
    s += '<rect x="340" y="222" width="120" height="52" rx="8" fill="#141f29" stroke="#22323f"/>';
    s += '<text x="76" y="322" fill="#7e8f9d" font-family="monospace" font-size="11">location.pathname → "/about"</text>';
    s += '<rect x="424" y="306" width="160" height="26" rx="13" fill="#173b3c" stroke="#2f6f70"/>';
    s += '<text x="504" y="323" text-anchor="middle" fill="#6ee0d4" font-family="monospace" font-size="10">' +
      (lang === 'en' ? 'Layout persists' : 'Layout 常驻') + '</text>';
    return s;
  }

  /* ============================================================
     4. 渲染
     ============================================================ */
  function renderProjects() {
    var host = $('[data-cards]');
    if (!host) return;

    host.innerHTML = site.projects.map(function (raw, i) {
      var p = projectOf(raw);
      var chips = p.stack.map(function (x) { return '<li class="chip">' + escapeHTML(x) + '</li>'; }).join('');

      return '' +
        '<article class="card" data-reveal data-proj="' + i + '" style="--reveal-delay:' + (i % 2 === 0 ? 0 : 90) + 'ms">' +
          '<div class="card__thumb">' +
            media(p) +
            '<span class="card__year">' + p.year + '</span>' +
            '<span class="thumb__cap">' + escapeHTML(p.cap) + '</span>' +
          '</div>' +
          '<div class="card__body">' +
            '<div class="card__head">' +
              '<span class="card__index">' + String(i + 1).padStart(2, '0') + '</span>' +
              '<h3 class="card__title">' + escapeHTML(p.name) + '</h3>' +
            '</div>' +
            '<p class="card__sub">' + escapeHTML(p.sub) + '</p>' +
            '<p class="card__desc">' + escapeHTML(p.desc) + '</p>' +
            '<ul class="card__stack" aria-label="' + escapeHTML(t('work.stackLabel')) + '">' + chips + '</ul>' +
            '<div class="card__foot">' +
              '<a class="card__link" href="' + p.href + '" target="_blank" rel="noopener noreferrer">' +
                '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">' +
                  '<path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38l-.01-1.49c-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48l-.01 2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0z"/>' +
                '</svg>' +
                escapeHTML(t('work.source')) +
                '<span aria-hidden="true">↗</span>' +
              '</a>' +
            '</div>' +
          '</div>' +
        '</article>';
    }).join('');

    setText('[data-project-count]', String(site.projects.length));
  }

  function renderLinks() {
    var host = $('[data-links]');
    if (!host) return;

    host.innerHTML = site.links.map(function (l, i) {
      var href = l.href ? l.href : 'mailto:' + site.email;
      var kind = l.kindKey.indexOf('.') > -1 ? t(l.kindKey) : l.kindKey;
      var note = l.noteKey ? t(l.noteKey) : '';
      var external = !!l.href;
      return '' +
        '<a class="link" data-reveal data-link="' + i + '" href="' + href + '"' +
          (external ? ' target="_blank" rel="noopener noreferrer"' : '') + '>' +
          '<div>' +
            '<p class="link__kind">' + escapeHTML(kind) + '</p>' +
            '<p class="link__value">' + escapeHTML(l.label) + '</p>' +
            (note ? '<p class="link__note">' + escapeHTML(note) + '</p>' : '') +
          '</div>' +
          '<span class="link__go" aria-hidden="true">' + (external ? '↗' : '→') + '</span>' +
        '</a>';
    }).join('');
  }

  function setText(sel, value) {
    $$(sel).forEach(function (el) { el.textContent = value; });
  }

  /**
   * 切语言时只改文字，不重建节点。
   *
   * 之前这里是重跑 renderProjects() / renderLinks()，那会 innerHTML = ...
   * 把整块换掉：新节点带着 data-reveal（opacity:0）站在那里，
   * 而 IntersectionObserver 早就 unobserve 过旧节点、不会再管新节点 ——
   * 结果就是"切完语言，项目区和联系区一片空白，刷新才出来"。
   * 原地改文字既没有这个问题，也不会让动画重播、丢失焦点。
   */
  function updateContentLang() {
    site.projects.forEach(function (raw, i) {
      var card = $('.card[data-proj="' + i + '"]');
      if (!card) return;
      var p = projectOf(raw);

      var title = $('.card__title', card);
      if (title) title.textContent = p.name;
      var sub = $('.card__sub', card);
      if (sub) sub.textContent = p.sub;
      var desc = $('.card__desc', card);
      if (desc) desc.textContent = p.desc;
      var cap = $('.thumb__cap', card);
      if (cap) cap.textContent = p.cap;

      var stack = $('.card__stack', card);
      if (stack) stack.setAttribute('aria-label', t('work.stackLabel'));

      // 技术栈里个别标签本身是要翻译的（REST 接口设计 / 鉴权与会话…），
      // 这里按位置对齐着改，数量与初次渲染时一致
      var items = $$('.chip', card);
      for (var k = 0; k < items.length && k < p.stack.length; k++) {
        items[k].textContent = p.stack[k];
      }

      var shot = $('.card__thumb img', card);
      if (shot) shot.setAttribute('alt', t('work.shotAlt', { name: p.name }));
      var svg = $('.card__thumb svg', card);
      if (svg) svg.setAttribute('aria-label', t('work.thumbAlt', { name: p.name }));

      // 缩略图是加载时按当时的语言画好的 SVG，里面有几处文字。
      // 切换语言后重画一次，让那几个字也跟着变。
      // 注意变量名不要叫 thumb —— 那会盖住上面那个画缩略图的 thumb() 函数
      var thumbBox = $('.card__thumb', card);
      if (thumbBox) {
        var fresh = thumb(p.art, p.name);
        var oldSvg = $('svg', thumbBox);
        if (oldSvg) oldSvg.outerHTML = fresh;
        var shotImg = $('img', thumbBox);
        if (shotImg) shotImg.setAttribute('data-fb', escapeHTML(fresh));
      }

      var link = $('.card__link', card);
      if (link) {
        var label = link.lastChild;
        if (label && label.nodeType === 3) label.nodeValue = t('work.source');
      }
    });

    site.links.forEach(function (l, i) {
      var el = $('.link[data-link="' + i + '"]');
      if (!el) return;
      var kind = $('.link__kind', el);
      if (kind) kind.textContent = l.kindKey.indexOf('.') > -1 ? t(l.kindKey) : l.kindKey;
      var note = $('.link__note', el);
      if (note && l.noteKey) note.textContent = t(l.noteKey);
    });
  }

  /* ---- 静态文案：所有 data-i18n / data-i18n-attr 都在这处理 ---- */
  function applyI18n() {
    $$('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    // data-i18n-attr="content:meta.desc,title:foo"
    $$('[data-i18n-attr]').forEach(function (el) {
      el.getAttribute('data-i18n-attr').split(',').forEach(function (pair) {
        var bits = pair.split(':');
        if (bits.length === 2) el.setAttribute(bits[0].trim(), t(bits[1].trim()));
      });
    });
    $$('[data-i18n-placeholder]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    $$('[data-i18n-aria]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
  }

  /* ============================================================
     5. 主题
     ============================================================ */
  var THEME_KEY = 'portfolio.theme';

  function themeFromUrl() {
    var m = window.location.search.match(/[?&]theme=(dark|light)\b/);
    return m ? m[1] : null;
  }

  function readTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }

  function systemPrefersLight() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    $$('[data-theme-toggle]').forEach(function (btn) {
      btn.setAttribute('aria-label', t(theme === 'dark' ? 'theme.toLight' : 'theme.toDark'));
      btn.setAttribute('title', t(theme === 'dark' ? 'theme.light' : 'theme.dark'));
    });
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0b1015' : '#f2f1ec');
  }

  function initTheme() {
    applyTheme(themeFromUrl() || readTheme() || (systemPrefersLight() ? 'light' : 'dark'));
    $$('[data-theme-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 隐私模式下忽略 */ }
        applyTheme(next);
      });
    });
  }

  /* ============================================================
     6. 语言切换
     ============================================================ */
  function applyLang(next) {
    lang = next === 'en' ? 'en' : 'zh';
    document.documentElement.setAttribute('data-lang', lang);
    document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'zh-CN');
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* 忽略 */ }

    applyI18n();
    updateContentLang();               // 项目和联系方式原地换文字，节点不动
    applyPhoto(currentPhoto);          // 只改 src，不动已记住的照片
    applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');
    updateStatsText();
    renderMessages();                  // 留言列表是重建的，但它在自己的容器里、没有入场动画
    setText('[data-year]', String(new Date().getFullYear()));

    // 按钮上写的是"切过去之后是什么语言"，而不是当前语言
    var other = lang === 'en' ? 'zh' : 'en';
    $$('[data-lang-label]').forEach(function (el) {
      el.textContent = I18N[other]['lang.name'];
    });
    $$('[data-lang-short]').forEach(function (el) {
      el.textContent = I18N[other]['lang.short'];
    });
    $$('[data-lang-toggle]').forEach(function (btn) {
      btn.setAttribute('aria-label', t('lang.switch'));
      btn.setAttribute('title', t('lang.switch'));
    });

    // 语言变了，URL 也跟着变，方便直接分享某个语言版本的链接
    try {
      var u = new URL(window.location.href);
      u.searchParams.set('lang', lang);
      window.history.replaceState(null, '', u);
    } catch (e) { /* 老浏览器就算了 */ }
  }

  function initLang() {
    $$('[data-lang-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        applyLang(lang === 'en' ? 'zh' : 'en');
      });
    });
  }

  /* ============================================================
     7. 滚动揭示 / 索引栏 / 头像扫描
     ============================================================ */
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function initReveal(showAll) {
    var items = $$('[data-reveal]');
    if (showAll || !('IntersectionObserver' in window)) {
      items.forEach(function (el) { el.setAttribute('data-shown', 'true'); });
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.setAttribute('data-shown', 'true');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

    items.forEach(function (el) { io.observe(el); });
  }

  function initRail() {
    var links = $$('[data-nav]');
    var sections = ['about', 'work', 'guestbook', 'contact']
      .map(function (id) { return document.getElementById(id); })
      .filter(Boolean);

    if ('IntersectionObserver' in window && sections.length) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          links.forEach(function (a) {
            if (a.getAttribute('data-nav') === entry.target.id) a.setAttribute('aria-current', 'true');
            else a.removeAttribute('aria-current');
          });
        });
      }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });
      sections.forEach(function (sec) { io.observe(sec); });
    }

    var label = $('[data-progress-label]');
    var bar = $('[data-progress-bar]');
    var ticking = false;

    function update() {
      ticking = false;
      var doc = document.documentElement;
      var max = doc.scrollHeight - window.innerHeight;
      var pct = max > 0 ? Math.min(100, Math.max(0, (window.scrollY / max) * 100)) : 0;
      if (label) label.textContent = String(Math.round(pct)).padStart(2, '0') + '%';
      if (bar) bar.style.height = pct + '%';

      var topbar = $('[data-topbar]');
      if (topbar) topbar.setAttribute('data-stuck', window.scrollY > 12 ? 'true' : 'false');
    }

    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    update();
  }

  function initPortrait(showAll) {
    var fig = $('[data-portrait]');
    if (!fig) return;
    var status = $('[data-portrait-status]');

    function settle() {
      fig.setAttribute('data-scanned', 'true');
      fig.setAttribute('data-shown', 'true');
      fig.removeAttribute('data-reveal');
      if (status) status.textContent = 'profile · ready';
    }

    if (showAll || reduceMotion || !('IntersectionObserver' in window)) {
      settle();
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        io.disconnect();
        window.setTimeout(settle, 260);
      });
    }, { threshold: 0.35 });
    io.observe(fig);
  }

  /* ============================================================
     8. 头像上传（只存在本机浏览器，不上传服务器）
     ============================================================ */
  var PHOTO_KEY = 'portfolio.photo';
  var PHOTO_MAX = 1200;
  var PHOTO_QUALITY = 0.86;
  var DEFAULT_PHOTO = './assets/avatar.jpg';
  var currentPhoto = null;      // 内存里记住当前照片，切语言时要用

  function setHint(text, kind) {
    var el = $('[data-photo-hint]');
    if (!el) return;
    el.textContent = text || '';
    if (kind) el.setAttribute('data-kind', kind);
    else el.removeAttribute('data-kind');
  }

  function applyPhoto(dataUrl) {
    var img = $('[data-portrait-photo]');
    var reset = $('[data-photo-reset]');
    if (!img) return;
    currentPhoto = dataUrl || null;
    if (dataUrl) {
      img.src = dataUrl;
      img.setAttribute('data-custom', 'true');
      if (reset) reset.hidden = false;
    } else {
      img.removeAttribute('data-custom');
      img.src = DEFAULT_PHOTO;
      if (reset) reset.hidden = true;
    }
  }

  function readStoredPhoto() {
    try { return localStorage.getItem(PHOTO_KEY); } catch (e) { return null; }
  }

  function fitImage(file, quality) {
    return new Promise(function (resolve, reject) {
      var urlObj = URL.createObjectURL(file);
      var img = new Image();

      img.onload = function () {
        URL.revokeObjectURL(urlObj);
        var w = img.naturalWidth || img.width;
        var h = img.naturalHeight || img.height;
        if (!w || !h) return reject(new Error(t('photo.cantRead')));

        var scale = Math.min(1, PHOTO_MAX / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(h * scale));

        var canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        var ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.fillStyle = '#0b1015';
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(img, 0, 0, cw, ch);

        try {
          resolve({ dataUrl: canvas.toDataURL('image/jpeg', quality || PHOTO_QUALITY), w: cw, h: ch });
        } catch (e) {
          reject(new Error(t('photo.cantProcess')));
        }
      };

      img.onerror = function () {
        URL.revokeObjectURL(urlObj);
        reject(new Error(t('photo.broken')));
      };

      img.src = urlObj;
    });
  }

  function initPhotoUpload() {
    var input = $('[data-photo-input]');
    var uploadBtn = $('[data-photo-upload]');
    var resetBtn = $('[data-photo-reset]');
    if (!input || !uploadBtn) return;

    var saved = readStoredPhoto();
    if (saved && /^data:image\//.test(saved)) applyPhoto(saved);

    uploadBtn.addEventListener('click', function () {
      input.value = '';
      input.click();
    });

    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;

      if (!/^image\//.test(file.type)) {
        setHint(t('photo.notImage'), 'error');
        return;
      }

      var label = $('span', uploadBtn);
      if (label) label.textContent = t('photo.processing');
      setHint('');

      fitImage(file).then(function (r) {
        if (r.dataUrl.length > 3.2e6) return fitImage(file, 0.6);
        return r;
      }).then(function (r) {
        try {
          localStorage.setItem(PHOTO_KEY, r.dataUrl);
          setHint(t('photo.done', { w: r.w, h: r.h, kb: Math.round(r.dataUrl.length / 1024) }), 'ok');
        } catch (e) {
          setHint(t('photo.quota'), 'warn');
        }
        applyPhoto(r.dataUrl);
      }).catch(function (err) {
        setHint(err && err.message ? err.message : t('photo.failed'), 'error');
      }).then(function () {
        if (label) label.textContent = t('photo.upload');
      });
    });

    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        try { localStorage.removeItem(PHOTO_KEY); } catch (e) { /* 忽略 */ }
        applyPhoto(null);
        setHint(t('photo.resetDone'), 'ok');
      });
    }
  }

  /* ============================================================
     9. 复制邮箱
     ============================================================ */
  function initCopy() {
    var btn = $('[data-copy-email]');
    if (!btn) return;
    var label = $('[data-copy-label]', btn);
    var timer = null;

    function flash(text) {
      if (!label) return;
      label.textContent = text;
      window.clearTimeout(timer);
      timer = window.setTimeout(function () { label.textContent = t('contact.copyEmail'); }, 2000);
    }

    btn.addEventListener('click', function () {
      var value = site.email;

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(
          function () { flash(t('contact.copied')); },
          function () { flash(t('contact.copyFail')); }
        );
        return;
      }

      try {
        var ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        flash(t('contact.copied'));
      } catch (e) {
        flash(t('contact.copyFail'));
      }
    });
  }

  /* ============================================================
     10. 后端 API（访问统计 + 留言板）
     —— 拿不到后端时，这两块会自己藏起来，页面其余部分照常
     ============================================================ */
  var API = './api';
  var apiOnline = false;

  function api(path, options) {
    var opts = options || {};
    var init = { method: opts.method || 'GET', headers: {} };
    if (opts.body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(API + path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        data.__status = res.status;
        return data;
      });
    });
  }

  /** 本机生成一个访客 ID（不含任何个人信息），服务端再哈希一次 */
  function visitorId() {
    var KEY = 'portfolio.vid';
    var v = null;
    try { v = localStorage.getItem(KEY); } catch (e) { /* 忽略 */ }
    if (!v) {
      v = 'v-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      try { localStorage.setItem(KEY, v); } catch (e) { /* 忽略 */ }
    }
    return v;
  }

  var stats = null;

  function updateStatsText() {
    var host = $('[data-stats]');
    if (!host) return;

    // 标签文字与数据无关，先无条件刷成当前语言。
    // （早先这里在 !stats 时直接 return，导致后端还没答复就切语言时，
    //   标签会一直停在中文。）
    setText('[data-stats-label]', t('stats.views'));
    setText('[data-stats-label-today]', t('stats.today'));
    setText('[data-stats-label-uv]', t('stats.visitors'));

    var chart = $('[data-stats-trend]', host);
    if (chart) {
      chart.setAttribute('aria-label', t('stats.trend'));
      chart.setAttribute('title', t('stats.trend'));
    }

    if (!stats) return;

    setText('[data-stats-views]', String(stats.total));
    setText('[data-stats-today]', String(stats.today));
    setText('[data-stats-uv]', String(stats.uvSum));
    setText('[data-stats-since]', t('stats.since', { d: stats.since }));

    if (chart) {
      var max = stats.days.reduce(function (m, d) { return Math.max(m, d.pv); }, 1);
      chart.innerHTML = stats.days.map(function (d) {
        var pct = max > 0 ? Math.round((d.pv / max) * 100) : 0;
        var short = lang === 'en'
          ? d.day.slice(5)
          : d.day.slice(5).replace('-', '/');
        return '<span class="trend__bar" style="--h:' + Math.max(pct, 2) + '%" ' +
          'title="' + d.day + ' · ' + t('stats.todayLabel', { n: d.pv }) + '">' +
          '<i></i><em>' + short + '</em></span>';
      }).join('');
    }
  }

  function initStats() {
    var host = $('[data-stats]');
    if (!host) return;

    // 记一次访问（失败就说明没有后端，整块不显示）
    api('/visit', { method: 'POST', body: { visitorId: visitorId() } })
      .then(function (r) {
        if (!r || !r.ok || !r.stats) throw new Error('no backend');
        apiOnline = true;
        stats = r.stats;
        host.hidden = false;
        updateStatsText();
      })
      .catch(function () {
        apiOnline = false;
        host.hidden = true;     // 纯静态部署时不显示假的统计
      });
  }

  /* ============================================================
     11. 留言板
     ============================================================ */
  var msgState = { offset: 0, total: 0, hasMore: false, loading: false, loaded: false };
  // 每次提交发一个序号，只有"最新那次"的响应才允许改提示语。
  // 否则先发的那条慢一点回来，就会把后发的错误/结果覆盖掉。
  var postSeq = 0;

  function relativeTime(iso) {
    var then = new Date(iso).getTime();
    if (!then) return '';
    var diff = Math.max(0, Date.now() - then);
    var min = Math.floor(diff / 60000);
    if (min < 1) return t('gb.justNow');
    if (min < 60) return t('gb.minutesAgo', { n: min });
    var hr = Math.floor(min / 60);
    if (hr < 24) return t('gb.hoursAgo', { n: hr });
    var day = Math.floor(hr / 24);
    if (day < 30) return t('gb.daysAgo', { n: day });
    return new Date(then).toLocaleDateString(localeTag());
  }

  function renderMessages() {
    var host = $('[data-gb-list]');
    if (!host) return;

    var items = msgState.items || [];
    if (!items.length) {
      host.innerHTML = '<p class="gb__empty" data-reveal data-shown="true">' + escapeHTML(t('gb.empty')) + '</p>';
    } else {
      host.innerHTML = items.map(function (m) {
        var initial = String(m.name || '?').trim().charAt(0).toUpperCase();
        return '' +
          '<li class="gb-item">' +
            '<div class="gb-item__avatar" aria-hidden="true">' + escapeHTML(initial) + '</div>' +
            '<div class="gb-item__body">' +
              '<p class="gb-item__meta">' +
                '<span class="gb-item__name">' + escapeHTML(m.name) + '</span>' +
                '<time datetime="' + escapeHTML(m.at) + '">' + escapeHTML(relativeTime(m.at)) + '</time>' +
              '</p>' +
              '<p class="gb-item__text">' + escapeHTML(m.text).replace(/\n/g, '<br>') + '</p>' +
            '</div>' +
          '</li>';
      }).join('');
    }

    var more = $('[data-gb-more]');
    if (more) more.hidden = !msgState.hasMore;

    var totalEl = $('[data-gb-total]');
    if (totalEl) totalEl.textContent = msgState.total ? t('gb.total', { n: msgState.total }) : '';
  }

  function loadMessages(reset) {
    var host = $('[data-gb-list]');
    if (!host || msgState.loading) return;
    msgState.loading = true;

    if (reset) { msgState.offset = 0; msgState.items = []; }

    var status = $('[data-gb-status]');
    if (status && reset && !msgState.loaded) status.textContent = t('gb.loading');

    api('/guestbook?offset=' + msgState.offset + '&limit=8')
      .then(function (r) {
        if (!r || !r.ok) throw new Error('no backend');
        apiOnline = true;
        msgState.total = r.total;
        msgState.hasMore = r.hasMore;
        msgState.items = (msgState.items || []).concat(r.messages || []);
        msgState.offset = msgState.items.length;
        msgState.loaded = true;

        var board = $('[data-gb]');
        if (board) board.hidden = false;       // 后端可用才显示留言板
        if (status) status.textContent = '';
        renderMessages();
      })
      .catch(function () {
        var board = $('[data-gb]');
        if (status) {
          status.textContent = t('gb.offline');
          status.setAttribute('data-kind', 'warn');
        }
        if (board && !msgState.loaded) {
          board.hidden = false;
          var form = $('[data-gb-form]', board);
          if (form) form.hidden = true;        // 没有后端就别给一个点了没反应的按钮
          msgState.items = [];
          renderMessages();
        }
      })
      .then(function () { msgState.loading = false; });
  }

  function initGuestbook() {
    var form = $('[data-gb-form]');
    var board = $('[data-gb]');
    if (!board) return;

    // 先探一次后端；没有就把整块收起来（纯静态部署的样子）
    api('/guestbook?limit=0')
      .then(function (r) {
        if (!r || !r.ok) throw new Error('no');
        apiOnline = true;
        board.hidden = false;
        msgState.total = r.total;
        loadMessages(true);
      })
      .catch(function () {
        apiOnline = false;
        board.hidden = true;
      });

    if (!form) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var status = $('[data-gb-status]');
      var nameEl = $('[data-gb-name]');
      var textEl = $('[data-gb-text]');
      var btn = $('[data-gb-submit]');
      var honeypot = $('[data-gb-website]');

      var text = (textEl.value || '').trim();
      if (!text || text.replace(/\s/g, '').length < 2) {
        if (status) { status.textContent = t('gb.emptyMsg'); status.setAttribute('data-kind', 'error'); }
        textEl.focus();
        return;
      }

      var idle = btn ? btn.textContent : '';
      var myTurn = ++postSeq;
      var isLatest = function () { return myTurn === postSeq; };

      if (btn) { btn.disabled = true; btn.textContent = t('gb.sending'); }
      if (status) { status.textContent = ''; status.removeAttribute('data-kind'); }

      api('/guestbook', {
        method: 'POST',
        body: {
          name: nameEl ? nameEl.value : '',
          text: text,
          lang: lang,
          website: honeypot ? honeypot.value : '',   // 蜜罐，填了就当机器人
        },
      }).then(function (r) {
        // 期间又提交了一次：这次的结果已经过时，别再动界面
        if (!isLatest()) return;

        if (r && r.ok) {
          textEl.value = '';
          if (status) { status.textContent = t('gb.ok'); status.setAttribute('data-kind', 'ok'); }
          msgState.offset = 0;          // 从最新一条重新拉，避免分页错位
          loadMessages(true);
          return;
        }
        var err = (r && r.error) || 'FAIL';
        var msg = t('gb.errFail', { n: r && r.__status ? r.__status : '?' });
        if (err === 'EMPTY') msg = t('gb.errEmpty');
        else if (err === 'TOO_SHORT') msg = t('gb.errShort');
        else if (err === 'LOW_QUALITY') msg = t('gb.errLow');
        else if (err === 'TOO_LARGE') msg = t('gb.errTooLarge');
        else if (err === 'RATE_WAIT') msg = t('gb.errRateWait', { n: (r && r.wait) || 60 });
        else if (err === 'RATE_DAY') msg = t('gb.errRateDay');
        if (status) { status.textContent = msg; status.setAttribute('data-kind', 'error'); }
      }).catch(function () {
        if (!isLatest()) return;
        if (status) { status.textContent = t('gb.errNetwork'); status.setAttribute('data-kind', 'error'); }
      }).then(function () {
        if (btn) { btn.disabled = false; btn.textContent = idle || t('gb.submit'); }
      });
    });

    var more = $('[data-gb-more]');
    if (more) more.addEventListener('click', function () { loadMessages(false); });
  }

  /* ============================================================
     启动
     ============================================================ */
  function init() {
    var showAll = /[?&]reveal=all\b/.test(window.location.search);

    applyI18n();
    renderProjects();
    renderLinks();
    initTheme();
    initLang();
    initReveal(showAll);
    initRail();
    initPortrait(showAll);
    initPhotoUpload();
    initCopy();
    initStats();
    initGuestbook();

    setText('[data-year]', String(new Date().getFullYear()));

    window.addEventListener('load', function () {
      window.dispatchEvent(new Event('resize'));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
