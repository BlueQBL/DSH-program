/* ============================================================
   薛小飞 · 个人作品集
   原生 JS，无依赖、无构建。
   这一层只做五件事：
     1. 渲染项目卡片与联系方式（内容集中在下方 site 里，改这里就够了）
     2. 主题开关（默认跟随系统，用户点过就记住）
     3. 滚动揭示 + 左侧索引栏高亮与进度
     4. 头像的"扫描成像"（首屏出现时播一次）
     5. 复制邮箱
   ============================================================ */
(function () {
  'use strict';

  document.documentElement.classList.remove('no-js');

  /* ----------------------------------------------------------
     1. 内容
     —— 想改这个站，基本只用动这一块。
        换邮箱 / GitHub / 微信：改 links；
        加项目：往 projects 里追加一项即可（卡片、计数、"全部项目"入口都会自动跟上）。
     ---------------------------------------------------------- */
  var GITHUB_PROFILE = 'https://github.com/BlueQBL';
  // 每个项目在仓库里的子目录，拼出卡片上的"查看源码"链接
  var REPO = GITHUB_PROFILE + '/DSH-program/tree/main/';

  var site = {
    owner: '薛小飞',
    email: 'xuexiaofei666@proton.me',
    github: GITHUB_PROFILE,
    repo: REPO,

    links: [
      {
        kind: '邮件',
        label: 'xuexiaofei666@proton.me',
        note: '最直接的方式 · 两个工作日内回复',
        copy: 'xuexiaofei666@proton.me'
      },
      {
        kind: 'GitHub',
        label: 'github.com/BlueQBL',
        note: '本页所有项目的源码都在这里',
        href: GITHUB_PROFILE
      },
      {
        kind: '微信',
        label: 'Xxf_nevergiveup',
        note: '加的时候说一声是从这里来的',
        copy: 'Xxf_nevergiveup'
      }
    ],

    projects: [
      {
        name: '图片压缩工具',
        sub: 'Image Compressor · 前后端完整站点',
        year: '2026.09',
        desc: '拖入、粘贴或批量上传图片，拖滑杆调质量，按住左右拖动就能对比原图和压缩后的差别。全部压完一键打包成 zip 下载。图片只在本机处理，临时文件一小时自动清掉。',
        stack: ['Node.js', 'Express', 'Sharp', 'Multer', 'Archiver', '原生前端'],
        href: REPO + 'image-compressor',
        shot: './assets/shots/image-compressor.png',
        cap: 'before / after',
        art: artCompressor
      },
      {
        name: '流水账',
        sub: '个人记账 · 零依赖 PWA',
        year: '2026.09',
        desc: '只做四件事的记账应用：快速记一笔、按日期翻记录、看月度统计、数据只留在本机。整页是一卷热敏纸压在深墨绿桌垫上，只用墨黑和热敏红两种墨，分类占比画成条码 —— 顺便绕开了红绿色盲。',
        stack: ['原生 HTML', 'CSS', 'JavaScript', 'PWA', 'LocalStorage'],
        href: REPO + 'ledger',
        shot: './assets/shots/ledger.png',
        cap: 'receipt ledger',
        art: artLedger
      },
      {
        name: '水尺 · 喝水提醒',
        sub: 'Water Gauge · 会到点催你的小工具',
        year: '2026.09',
        desc: '一根带刻度的量水尺：左边是毫升刻线，右边是"几点该喝到多少"的计划标记，水面之上的斜线缺口就是你现在欠的水量。到点通过页面横幅、桌面通知、合成提示音和标签标题四条通道提醒，间隔从上次喝水开始算。',
        stack: ['原生 HTML', 'CSS', 'Web Audio', 'Notification API', 'LocalStorage'],
        href: REPO + 'water-reminder',
        shot: './assets/shots/water-reminder.png',
        cap: 'water level',
        art: artWater
      },
      {
        name: '狼人杀 · 九人局',
        sub: 'Werewolf · 你和八个 AI 玩家',
        year: '2026.09',
        desc: '一个能在浏览器里打完的九人标准局：3 狼人、预言家、女巫、猎人、3 平民，你坐一席，其余八人由 AI 扮演。最有意思的是验证部分 —— 一条命令跑 400 局无头模拟，再加上重排隐藏身份验证机器人没有偷看底牌。',
        stack: ['Vue 3', 'Vite', '无头模拟', '规则审计', 'SSR 冒烟测试'],
        href: REPO + 'werewolf-game',
        shot: './assets/shots/werewolf-game.png',
        cap: 'table view',
        art: artWerewolf
      },
      {
        name: 'JWT 认证演示',
        sub: 'Auth Demo · 前后端联调样板',
        year: '2026.09',
        desc: '一个把"注册、登录、带令牌访问受保护接口"讲清楚的样板：后端签发令牌并用拦截器校验，前端用 Axios 拦截器带上令牌、用路由守卫拦住未登录访问，令牌过期自动退出登录。没引 Spring Security，整条链路是透明的。',
        stack: ['Spring Boot 3', 'Spring Data JPA', 'JWT', 'BCrypt', 'Vue 3', 'Pinia'],
        href: REPO + 'backend',
        shot: './assets/shots/jwt-auth.png',
        cap: 'auth flow',
        art: artAuth
      },
      {
        name: 'React Router 演示',
        sub: 'Routing Demo · 升级到 React 19 的路由样板',
        year: '2026.09',
        desc: '一个最小但完整的 React + TypeScript 应用，专门演示路由：嵌套布局用 Outlet 承载页面，导航项按当前地址自动高亮，未声明的地址优雅回退到 404 页。顺手把 Vite 5→7、React Router 6→7 升了一遍，npm audit 归零。',
        stack: ['React 19', 'TypeScript', 'React Router 7', 'Vite 7'],
        href: REPO + 'react-frontend',
        shot: './assets/shots/react-router.png',
        cap: 'route map',
        art: artRouter
      }
    ]
  };

  var $  = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ----------------------------------------------------------
     2. 缩略图：每个项目一张按它的视觉母题手写的 SVG
        有真实截图就换成截图（index.html 不用改）
     ---------------------------------------------------------- */
  var THUMB_W = 640;
  var THUMB_H = 400;

  /** 所有缩略图共用的外框与配色，具体的画各自叠加 */
  function thumb(art, title) {
    return '<svg viewBox="0 0 ' + THUMB_W + ' ' + THUMB_H + '" role="img" aria-label="' + title + ' 界面示意图" preserveAspectRatio="xMidYMid slice">' +
      '<rect width="' + THUMB_W + '" height="' + THUMB_H + '" fill="#0e151b"/>' +
      art +
      '</svg>';
  }

  /** 卡片里的截图：真实截图优先，缺图或加载失败时回落到 SVG */
  function media(p) {
    var fallback = thumb(p.art, p.name).replace(/"/g, '&quot;');
    return '<img src="' + p.shot + '" alt="' + p.name + ' 界面截图" loading="lazy" decoding="async"' +
           ' onerror="this.outerHTML=this.dataset.fb" data-fb="' + fallback + '" />';
  }

  /* ---- 01 图片压缩：并排对比 ---- */
  function artCompressor() {
    var s = '<g transform="translate(40 36)">';
    for (var i = 0; i < 2; i++) {
      var x = i * 290;
      s += '<rect x="' + x + '" y="0" width="250" height="272" rx="14" fill="#121b22" stroke="#22323f"/>';
      s += '<rect x="' + (x + 18) + '" y="18" width="214" height="140" rx="8" fill="' + (i ? '#15343a' : '#1a2530') + '"/>';
      // 用同心斜线暗示"同一张图的两个版本"
      for (var k = 0; k < 5; k++) {
        s += '<path d="M' + (x + 40 + k * 26) + ' 158 L' + (x + 70 + k * 26) + ' 22" stroke="' +
             (i ? '#2f6f70' : '#2c3b48') + '" stroke-width="10" stroke-linecap="round"/>';
      }
      s += '<path d="M' + (x + 210) + ' 142 l-16 -22 -14 26 -10 -14 -12 10" fill="none" stroke="' + (i ? '#4fd1c5' : '#3d5062') + '" stroke-width="3" stroke-linejoin="round"/>';
      // 体积条
      s += '<rect x="' + (x + 18) + '" y="178" width="152" height="8" rx="4" fill="#243240"/>';
      s += '<rect x="' + (x + 18) + '" y="178" width="' + (i ? 46 : 152) + '" height="8" rx="4" fill="' + (i ? '#4fd1c5' : '#5a6d7d') + '"/>';
      s += '<text x="' + (x + 18) + '" y="212" fill="' + (i ? '#6ee0d4' : '#7e8f9d') + '" font-family="monospace" font-size="22" font-weight="700">' + (i ? '184 KB' : '2.1 MB') + '</text>';
      s += '<text x="' + (x + 18) + '" y="240" fill="#5b6a78" font-family="monospace" font-size="12" letter-spacing="2">' + (i ? 'AFTER · Q70' : 'BEFORE · ORIGINAL') + '</text>';
    }
    s += '</g>';
    // 中间的比较手柄
    s += '<rect x="312" y="130" width="18" height="86" rx="9" fill="#0e151b" stroke="#4fd1c5" stroke-width="2"/>';
    s += '<path d="M318 152 l-6 8 6 8M324 152 l6 8 -6 8" fill="none" stroke="#4fd1c5" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
    // 打包下载
    s += '<rect x="190" y="332" width="260" height="40" rx="20" fill="#4fd1c5"/>';
    s += '<text x="320" y="358" text-anchor="middle" fill="#07120f" font-family="monospace" font-size="15" font-weight="700" letter-spacing="1">打包下载全部 (6)</text>';
    return s;
  }

  /* ---- 02 流水账：热敏小票 ---- */
  function artLedger() {
    var s = '';
    // 桌垫
    s += '<rect width="640" height="400" fill="#101a14"/>';
    for (var k = 0; k < 40; k++) {
      s += '<path d="M' + (6 + k * 16) + ' 400 L' + (26 + k * 16) + ' 0" stroke="#16241c" stroke-width="1"/>';
    }
    // 小票：顶部撕口
    var teeth = '';
    for (var t = 0; t < 14; t++) {
      teeth += '<path d="M' + (158 + t * 24) + ' 44 l12 -14 12 14z" fill="#f1f1ec"/>';
    }
    s += teeth;
    s += '<rect x="158" y="44" width="324" height="298" fill="#f1f1ec"/>';
    // 小票内容
    s += '<text x="182" y="86" fill="#23282a" font-family="monospace" font-size="17" font-weight="700" letter-spacing="4">流水账</text>';
    s += '<text x="182" y="108" fill="#8b8f8b" font-family="monospace" font-size="10" letter-spacing="2">2026-09 · MONTHLY</text>';
    s += '<path d="M182 122 H458" stroke="#c9c9c2" stroke-width="1" stroke-dasharray="4 4"/>';
    s += '<text x="182" y="152" fill="#23282a" font-family="monospace" font-size="13">餐饮</text>';
    s += '<text x="458" y="152" text-anchor="end" fill="#b8322a" font-family="monospace" font-size="13" font-weight="700">-1,286.50</text>';
    s += '<text x="182" y="180" fill="#23282a" font-family="monospace" font-size="13">交通</text>';
    s += '<text x="458" y="180" text-anchor="end" fill="#b8322a" font-family="monospace" font-size="13" font-weight="700">-342.00</text>';
    s += '<text x="182" y="208" fill="#23282a" font-family="monospace" font-size="13">稿费</text>';
    s += '<text x="458" y="208" text-anchor="end" fill="#23282a" font-family="monospace" font-size="13" font-weight="700">+8,000.00</text>';
    s += '<path d="M182 224 H458" stroke="#c9c9c2" stroke-width="1" stroke-dasharray="4 4"/>';
    // 分类条码
    var widths = [7, 3, 11, 5, 3, 9, 4, 13, 3, 6, 4, 3, 8, 3, 7, 4, 3, 10, 5, 3, 6, 3, 9, 4, 7, 3, 5, 11, 3, 4, 8, 3, 6, 3, 9, 4, 5, 3, 7, 12, 3, 6, 4, 3, 8, 5, 3, 9, 4, 3];
    var bx = 182;
    for (var i = 0; i < widths.length; i++) {
      bx += widths[i] + 1;
      if (bx > 456) break;
      s += '<rect x="' + bx + '" y="240" width="' + widths[i] + '" height="46" fill="#23282a"/>';
    }
    s += '<text x="182" y="308" fill="#8b8f8b" font-family="monospace" font-size="10" letter-spacing="2">餐饮 61% · 交通 16% · 其他 8%</text>';
    s += '<text x="182" y="326" fill="#23282a" font-family="monospace" font-size="11" font-weight="700">本机数据 · 未上传</text>';
    return s;
  }

  /* ---- 03 水尺：刻度与水位 ---- */
  function artWater() {
    var s = '<rect width="640" height="400" fill="#0d161c"/>';
    s += '<circle cx="520" cy="60" r="150" fill="#123039" opacity="0.5"/>';
    s += '<rect x="96" y="46" width="132" height="308" rx="18" fill="#111c24" stroke="#25404a"/>';
    // 水面：缺口用斜线填充
    s += '<rect x="98" y="178" width="128" height="174" rx="16" fill="#1d5b62"/>';
    s += '<path d="M98 178 h128 l-128 34z" fill="#4fd1c5" opacity="0.85"/>';
    for (var k = 0; k < 7; k++) {
      s += '<path d="M' + (108 + k * 18) + ' 352 L' + (136 + k * 18) + ' 200" stroke="#4fd1c5" stroke-width="2" opacity="0.28"/>';
    }
    // 刻度
    for (var i = 0; i <= 10; i++) {
      var y = 56 + i * 29;
      var major = i % 2 === 0;
      s += '<path d="M' + (major ? 106 : 116) + ' ' + y + ' H' + (major ? 134 : 128) + '" stroke="#3d5d69" stroke-width="1.6"/>';
      if (major) s += '<text x="' + 208 + '" y="' + (y + 4) + '" fill="#6c8b96" font-family="monospace" font-size="10">' + (2000 - i * 200) + '</text>';
    }
    // 计划时刻标记
    var plan = [['08:00', 60], ['11:00', 122], ['15:00', 214], ['19:00', 306]];
    for (var j = 0; j < plan.length; j++) {
      s += '<circle cx="238" cy="' + plan[j][1] + '" r="5" fill="#e6a758"/>';
      s += '<path d="M132 ' + plan[j][1] + ' H232" stroke="#e6a758" stroke-width="1" stroke-dasharray="3 5" opacity="0.65"/>';
      s += '<text x="250" y="' + (plan[j][1] + 4) + '" fill="#a8834d" font-family="monospace" font-size="11">' + plan[j][0] + '</text>';
    }
    // 拖拽手柄
    s += '<rect x="84" y="170" width="156" height="16" rx="8" fill="#4fd1c5"/>';
    s += '<circle cx="162" cy="178" r="7" fill="#0d161c" stroke="#4fd1c5" stroke-width="3"/>';
    // 读数
    s += '<text x="352" y="122" fill="#eef4f7" font-family="monospace" font-size="52" font-weight="700">1,240</text>';
    s += '<text x="352" y="150" fill="#6c8b96" font-family="monospace" font-size="13" letter-spacing="2">ML / 2000 ML</text>';
    s += '<rect x="352" y="176" width="200" height="10" rx="5" fill="#1d2c36"/>';
    s += '<rect x="352" y="176" width="124" height="10" rx="5" fill="#4fd1c5"/>';
    s += '<text x="352" y="216" fill="#e6a758" font-family="monospace" font-size="12">下一杯 · 距离上次 31 分钟</text>';
    s += '<rect x="352" y="238" width="96" height="34" rx="17" fill="#16232c" stroke="#2b414d"/>';
    s += '<text x="400" y="260" text-anchor="middle" fill="#a8bcc6" font-family="monospace" font-size="12">150 ml</text>';
    s += '<rect x="458" y="238" width="96" height="34" rx="17" fill="#16232c" stroke="#2b414d"/>';
    s += '<text x="506" y="260" text-anchor="middle" fill="#a8bcc6" font-family="monospace" font-size="12">250 ml</text>';
    s += '<rect x="352" y="290" width="202" height="64" rx="12" fill="#111c24" stroke="#243a45"/>';
    s += '<text x="366" y="314" fill="#6c8b96" font-family="monospace" font-size="10" letter-spacing="2">最近 7 天</text>';
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
    s += '<text x="320" y="196" text-anchor="middle" fill="#e9eef3" font-family="monospace" font-size="22" font-weight="700" letter-spacing="3">第 2 天</text>';
    s += '<text x="320" y="220" text-anchor="middle" fill="#6d8296" font-family="monospace" font-size="11" letter-spacing="2">白天 · 投票中</text>';
    var roles = ['1', '狼', '3', '民', '预', '6', '7', '民', '9'];
    var colors = ['#5b7fa6', '#c0563f', '#5b7fa6', '#4e8f6b', '#4fd1c5', '#5b7fa6', '#5b7fa6', '#4e8f6b', '#5b7fa6'];
    for (var i = 0; i < 9; i++) {
      var a = -Math.PI / 2 + (i * 2 * Math.PI) / 9;
      var cx = 320 + Math.cos(a) * 138;
      var cy = 200 + Math.sin(a) * 138;
      var me = i === 0;
      s += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="25" fill="#141d26" stroke="' + (me ? '#4fd1c5' : '#2b3d4e') + '" stroke-width="' + (me ? 3 : 2) + '"/>';
      s += '<text x="' + cx.toFixed(1) + '" y="' + (cy + 7).toFixed(1) + '" text-anchor="middle" fill="' + (roles[i] === '狼' ? colors[i] : '#c8d4de') + '" font-family="monospace" font-size="17" font-weight="700">' + roles[i] + '</text>';
      if (!me) s += '<circle cx="' + (cx + 22).toFixed(1) + '" cy="' + (cy - 20).toFixed(1) + '" r="5" fill="#4e8f6b"/>';
    }
    s += '<rect x="252" y="342" width="136" height="34" rx="17" fill="#4fd1c5"/>';
    s += '<text x="320" y="364" text-anchor="middle" fill="#07120f" font-family="monospace" font-size="13" font-weight="700">投票放逐</text>';
    s += '<text x="252" y="46" fill="#8aa0b2" font-family="monospace" font-size="12" letter-spacing="2">3 狼 · 预 · 女 · 猎 · 3 民</text>';
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
    s += '<text x="150" y="204" text-anchor="middle" fill="#eaf3fb" font-family="monospace" font-size="12" font-weight="700">登录</text>';
    s += '<text x="62" y="246" fill="#5b6f7e" font-family="monospace" font-size="10" letter-spacing="1">BCrypt 校验通过</text>';
    s += '<rect x="62" y="258" width="176" height="60" rx="8" fill="#101820" stroke="#24343f"/>';
    s += '<text x="74" y="278" fill="#4fd1c5" font-family="monospace" font-size="10">Authorization:</text>';
    s += '<text x="74" y="296" fill="#8fa8b8" font-family="monospace" font-size="10">Bearer eyJhbGci…</text>';
    s += '<text x="74" y="312" fill="#5b6f7e" font-family="monospace" font-size="9">exp 24h · HS256</text>';
    // 流程
    var steps = ['POST /login', '签发 JWT', 'GET /me', '200 OK'];
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
    // 导航
    s += '<rect x="30" y="30" width="580" height="46" rx="16" fill="#0e151c"/>';
    s += '<rect x="30" y="60" width="580" height="16" fill="#0e151c"/>';
    s += '<path d="M30 76 H610" stroke="#22323f"/>';
    s += '<text x="56" y="58" fill="#e9eef3" font-family="monospace" font-size="12" font-weight="700">REACT ROUTER</text>';
    var navs = [['/', 0], ['/about', 1], ['/work', 0], ['*', 0]];
    var nx = 300;
    var labels = ['首页', '关于', '作品', '404'];
    for (var i = 0; i < 4; i++) {
      var active = i === 1;
      var w = 58 + labels[i].length * 2;
      s += '<rect x="' + nx + '" y="44" width="' + w + '" height="24" rx="12" fill="' + (active ? '#173b3c' : 'transparent') + '" stroke="' + (active ? '#2f6f70' : '#233442') + '"/>';
      s += '<text x="' + (nx + w / 2) + '" y="60" text-anchor="middle" fill="' + (active ? '#6ee0d4' : '#7e8f9d') + '" font-family="monospace" font-size="10">' + labels[i] + '</text>';
      nx += w + 8;
    }
    // 出口：Outlet 承载的页面
    s += '<rect x="56" y="102" width="528" height="196" rx="12" fill="#0d151c" stroke="#1f2f3e"/>';
    s += '<text x="76" y="132" fill="#4fd1c5" font-family="monospace" font-size="11" letter-spacing="1">&lt;Outlet /&gt;</text>';
    s += '<rect x="76" y="150" width="240" height="14" rx="7" fill="#1c2a36"/>';
    s += '<rect x="76" y="176" width="392" height="10" rx="5" fill="#182430"/>';
    s += '<rect x="76" y="196" width="344" height="10" rx="5" fill="#182430"/>';
    s += '<rect x="76" y="222" width="120" height="52" rx="8" fill="#141f29" stroke="#22323f"/>';
    s += '<rect x="208" y="222" width="120" height="52" rx="8" fill="#141f29" stroke="#22323f"/>';
    s += '<rect x="340" y="222" width="120" height="52" rx="8" fill="#141f29" stroke="#22323f"/>';
    s += '<text x="76" y="322" fill="#7e8f9d" font-family="monospace" font-size="11">location.pathname → "/about"</text>';
    s += '<rect x="440" y="306" width="144" height="26" rx="13" fill="#173b3c" stroke="#2f6f70"/>';
    s += '<text x="512" y="323" text-anchor="middle" fill="#6ee0d4" font-family="monospace" font-size="10">Layout 常驻</text>';
    return s;
  }

  /* ----------------------------------------------------------
     3. 渲染
     ---------------------------------------------------------- */
  function renderProjects() {
    var host = $('[data-cards]');
    if (!host) return;

    host.innerHTML = site.projects.map(function (p, i) {
      var chips = p.stack.map(function (t) {
        return '<li class="chip">' + t + '</li>';
      }).join('');

      return '' +
        '<article class="card" data-reveal style="--reveal-delay:' + (i % 2 === 0 ? 0 : 90) + 'ms">' +
          '<div class="card__thumb">' +
            media(p) +
            '<span class="card__year">' + p.year + '</span>' +
            '<span class="thumb__cap">' + p.cap + '</span>' +
          '</div>' +
          '<div class="card__body">' +
            '<div class="card__head">' +
              '<span class="card__index">' + String(i + 1).padStart(2, '0') + '</span>' +
              '<h3 class="card__title">' + p.name + '</h3>' +
            '</div>' +
            '<p class="card__sub">' + p.sub + '</p>' +
            '<p class="card__desc">' + p.desc + '</p>' +
            '<ul class="card__stack" aria-label="技术栈">' + chips + '</ul>' +
            '<div class="card__foot">' +
              '<a class="card__link" href="' + p.href + '" target="_blank" rel="noopener noreferrer">' +
                '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">' +
                  '<path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38l-.01-1.49c-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48l-.01 2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0z"/>' +
                '</svg>' +
                '查看源码' +
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

    host.innerHTML = site.links.map(function (l) {
      var action = l.href
        ? ' href="' + l.href + '" target="_blank" rel="noopener noreferrer"'
        : ' href="mailto:' + site.email + '"';
      return '' +
        '<a class="link" data-reveal' + action + '>' +
          '<div>' +
            '<p class="link__kind">' + l.kind + '</p>' +
            '<p class="link__value">' + l.label + '</p>' +
            (l.note ? '<p class="link__note">' + l.note + '</p>' : '') +
          '</div>' +
          '<span class="link__go" aria-hidden="true">' + (l.href ? '↗' : '→') + '</span>' +
        '</a>';
    }).join('');

    // 写信入口用 mailto，复制按钮单独处理（见 5）
    var mail = $('.link');
    if (mail && site.links[0] && !site.links[0].href) {
      mail.setAttribute('href', 'mailto:' + site.email);
    }
  }

  function setText(sel, value) {
    $$(sel).forEach(function (el) { el.textContent = value; });
  }

  /* ----------------------------------------------------------
     4. 主题
     ---------------------------------------------------------- */
  var THEME_KEY = 'portfolio.theme';

  /**
   * 主题优先顺序：地址栏 ?theme=dark|light ＞ 本地记住的 ＞ 系统偏好
   * （?theme= 主要是给截图和视觉回归用的）
   */
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
    setText('[data-theme-glyph]', '');
    $$('[data-theme-toggle]').forEach(function (btn) {
      btn.setAttribute('aria-label', theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
      btn.setAttribute('title', theme === 'dark' ? '浅色' : '深色');
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

  /* ----------------------------------------------------------
     5. 滚动揭示 / 索引栏 / 扫描成像
     ---------------------------------------------------------- */
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function initReveal(showAll) {
    var items = $$('[data-reveal]');

    // 截图 / 打印模式，或者浏览器不支持 IntersectionObserver：
    // 什么都不等，直接全部显示（没 JS 时靠 .no-js 兜底）
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
    var sections = ['about', 'work', 'contact']
      .map(function (id) { return document.getElementById(id); })
      .filter(Boolean);

    if ('IntersectionObserver' in window && sections.length) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          links.forEach(function (a) {
            if (a.getAttribute('data-nav') === entry.target.id) {
              a.setAttribute('aria-current', 'true');
            } else {
              a.removeAttribute('aria-current');
            }
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

    // 减少动效、不支持 IntersectionObserver、或截图模式：直接落地，不做扫描动画
    if (showAll || reduceMotion || !('IntersectionObserver' in window)) {
      settle();
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        io.disconnect();
        // 延迟一点再播，让首屏的文字先落位；settle() 会同时摘掉揭示队列
        window.setTimeout(settle, 260);
      });
    }, { threshold: 0.35 });
    io.observe(fig);
  }

  /* ----------------------------------------------------------
     6. 头像上传
     —— 照片只存在这台机器的浏览器里（localStorage），不上传任何服务器。
        存之前先在 canvas 里缩到 1200px 以内再转 JPEG，否则一张手机原图
        直接塞进 localStorage 会超配额。
     ---------------------------------------------------------- */
  var PHOTO_KEY = 'portfolio.photo';
  var PHOTO_MAX = 1200;      // 长边上限（像素）
  var PHOTO_QUALITY = 0.86;
  var DEFAULT_PHOTO = './assets/avatar.jpg';        // 默认照片
  var FALLBACK_PHOTO = './assets/avatar-line-art.svg';  // 照片缺失时的线描兜底

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

  /** 缩小 + 转码，返回 dataURL。quality 传低一点是给"还是太大"的第二次机会 */
  function fitImage(file, quality) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();

      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth || img.width;
        var h = img.naturalHeight || img.height;
        if (!w || !h) return reject(new Error('这张图读不出宽高，换一张试试'));

        var scale = Math.min(1, PHOTO_MAX / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(h * scale));

        var canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        var ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.fillStyle = '#0b1015';       // 透明图（PNG）铺个底，转 JPEG 才不会发黑
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(img, 0, 0, cw, ch);

        try {
          resolve({
            dataUrl: canvas.toDataURL('image/jpeg', quality || PHOTO_QUALITY),
            w: cw, h: ch, from: w + '×' + h
          });
        } catch (e) {
          reject(new Error('这张图没法处理，换一张试试'));
        }
      };

      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('这不是一张能打开的图片文件'));
      };

      img.src = url;
    });
  }

  function initPhotoUpload() {
    var input = $('[data-photo-input]');
    var uploadBtn = $('[data-photo-upload]');
    var resetBtn = $('[data-photo-reset]');
    if (!input || !uploadBtn) return;

    // 之前传过就恢复（先直接给 img.src，避免闪一下默认头像）
    var saved = readStoredPhoto();
    if (saved && /^data:image\//.test(saved)) applyPhoto(saved);

    uploadBtn.addEventListener('click', function () {
      input.value = '';        // 允许重复选同一个文件
      input.click();
    });

    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;

      if (!/^image\//.test(file.type)) {
        setHint('这个文件不是图片，选 jpg / png / webp 都行', 'error');
        return;
      }

      var label = $('span', uploadBtn);
      var idleLabel = label ? label.textContent : '上传照片';
      if (label) label.textContent = '处理中…';
      setHint('');

      fitImage(file).then(function (r) {
        // dataURL 是 base64，比原图大 1/3；超过 3.2M 字符就降质再来一次，
        // 否则 localStorage 的 5MB 配额会直接顶穿
        if (r.dataUrl.length > 3.2e6) return fitImage(file, 0.6);
        return r;
      }).then(function (r) {
        try {
          localStorage.setItem(PHOTO_KEY, r.dataUrl);
          setHint('已换成本机照片 · ' + r.w + '×' + r.h + '（' + Math.round(r.dataUrl.length / 1024) + ' KB，只存在你本机）', 'ok');
        } catch (e) {
          // 存不下也要让用户看到照片，只是刷新后会回到默认
          setHint('照片已显示，但这台浏览器存不下（换小一点的图，或刷新后需重传）', 'warn');
        }
        applyPhoto(r.dataUrl);
      }).catch(function (err) {
        setHint(err && err.message ? err.message : '上传失败，换一张试试', 'error');
      }).then(function () {
        if (label) label.textContent = idleLabel;
      });
    });

    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        try { localStorage.removeItem(PHOTO_KEY); } catch (e) { /* 忽略 */ }
        applyPhoto(null);
        setHint('已恢复默认头像', 'ok');
      });
    }
  }

  /* ----------------------------------------------------------
     7. 复制邮箱
     ---------------------------------------------------------- */
  function initCopy() {
    var btn = $('[data-copy-email]');
    if (!btn) return;
    var label = $('[data-copy-label]', btn);
    var idle = label ? label.textContent : '复制邮箱';
    var timer = null;

    function flash(text) {
      if (!label) return;
      label.textContent = text;
      window.clearTimeout(timer);
      timer = window.setTimeout(function () { label.textContent = idle; }, 2000);
    }

    btn.addEventListener('click', function () {
      var value = site.email;

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(
          function () { flash('已复制 ✓'); },
          function () { flash('复制失败，请手动选中'); }
        );
        return;
      }

      // 老浏览器 / file:// 下的兜底
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
        flash('已复制 ✓');
      } catch (e) {
        flash('复制失败，请手动选中');
      }
    });
  }

  /* ----------------------------------------------------------
     启动
     ---------------------------------------------------------- */
  function init() {
    // ?reveal=all 让所有节点直接显示：整页截图和打印用得上
    var showAll = /[?&]reveal=all\b/.test(window.location.search);

    setText('[data-year]', String(new Date().getFullYear()));
    renderProjects();
    renderLinks();
    initTheme();
    initReveal(showAll);
    initRail();
    initPortrait(showAll);
    initPhotoUpload();
    initCopy();

    // 图片加载完成后高度会变，进度条需要重新算一次
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
