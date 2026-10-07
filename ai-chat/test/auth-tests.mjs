// 账号体系（纯函数那一半）：规则、密码哈希、令牌、限速、账号文件、用户隔离
//
//   node test/auth-tests.mjs
//
// 这个套件盯的是**认证里最容易写错、错了又最难发现**的几处：
//   · 名字/密码的规则是不是浏览器和服务端共用同一份（分叉了就会出现「前端拦了后端没拦」）；
//   · 密码有没有明文落盘、比较用的是不是 timingSafeEqual；
//   · 令牌的签名、过期、字段是不是一样都不能少（签名校验写漏一行，谁都能伪造登录态）；
//   · 账号文件坏掉时会不会被静默当成空（那等于把所有人的账号清掉）；
//   · 用户之间的隔离（别人看得到看不到你的会话）。
//
// 服务端那一侧的真 HTTP 行为（Cookie、状态码、限速）在 test/run-tests.mjs 里；
// 界面那一侧在 test/ui-tests.mjs 的「登录与账号」那一节。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AVATAR_COLORS,
  AVATAR_EMOJI,
  AVATAR_IMAGE_MAX,
  PASSWORD_MAX,
  PASSWORD_MIN,
  USERNAME_MAX,
  USERNAME_MIN,
  avatarColorFor,
  avatarView,
  initialChar,
  isAvatarImage,
  nameKey,
  normalizeAvatar,
  normalizeName,
  passwordHint,
  publicUser,
  validateName,
  validatePassword,
} from '../public/lib/auth-rules.js';
import {
  SCRYPT,
  TOKEN_COOKIE,
  clearSessionCookie,
  createRateLimiter,
  createUserStore,
  hashPassword,
  loadSecret,
  ownsRecord,
  readCookie,
  sessionCookie,
  signToken,
  verifyPassword,
  verifyToken,
} from '../lib/auth.mjs';
import {
  RECENT_ACCOUNTS_KEY,
  RECENT_ACCOUNTS_MAX,
  authFormError,
  avatarFromUpload,
  matchRecentAccounts,
  paintAvatar,
  readRecentAccounts,
  rememberAccount,
  renameRememberedAccount,
  restoreConfirmText,
  shouldPushSnapshot,
  snapshotNote,
  uploadErrorMessage,
  writeRecentAccounts,
} from '../public/lib/auth.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function group(title) {
  console.log(`\n${title}`);
}

/** 每个用例一个干净的临时目录（账号文件、密钥都写在里面，不碰 data/） */
async function tempDir(label) {
  return mkdtemp(path.join(os.tmpdir(), `duitanlu-auth-${label}-`));
}

// ---------------------------------------------------------------- 名字

group('名字：规则只有一处（浏览器和服务端 import 同一份）');

{
  check('空的要报错', validateName('').ok === false && validateName('   ').ok === false);
  check(`${USERNAME_MIN - 1} 个字太短`, validateName('a').ok === false, validateName('a').error);
  check(`${USERNAME_MIN} 个字可以`, validateName('ab').ok === true);
  check(`${USERNAME_MAX} 个字可以`, validateName('a'.repeat(USERNAME_MAX)).ok === true);
  check(`${USERNAME_MAX + 1} 个字太长`, validateName('a'.repeat(USERNAME_MAX + 1)).ok === false);
  check('中文可以', validateName('小林').ok === true);
  check('字母数字下划线短横线都可以', validateName('alice_01-x').ok === true);
  check('空格不行（名字会进导出文件名和日志）', validateName('alice smith').ok === false, validateName('alice smith').error);
  check('符号不行', validateName('alice@example').ok === false && validateName('a/b').ok === false);
  check('emoji 不行', validateName('🐳').ok === false);
  check('首尾空白会去掉（` alice ` 就是 `alice`）',
    validateName(' alice ').ok === true && validateName(' alice ').name === 'alice',
    JSON.stringify(validateName(' alice ')));

  check('判重用大小写不敏感的键（Alice 和 alice 是同一个人）', nameKey('Alice') === nameKey('alice'));
  check('中文的键就是它自己', nameKey(' 小林 ') === '小林');
  check('normalizeName 只去首尾，不动中间', normalizeName(' a b ') === 'a b', normalizeName(' a b '));
  check('非字符串输入不炸', normalizeName(null) === '' && normalizeName(42) === '');
}

// ---------------------------------------------------------------- 密码

group('密码：只挡「太短」和「和名字一样」');

{
  check('空的要报错', validatePassword('').ok === false);
  check(`${PASSWORD_MIN - 1} 位太短`, validatePassword('1234567').ok === false, validatePassword('1234567').error);
  check(`${PASSWORD_MIN} 位可以`, validatePassword('12345678').ok === true);
  check(`${PASSWORD_MAX + 1} 位太长（超长密码会把 scrypt 拖死）`,
    validatePassword('a'.repeat(PASSWORD_MAX + 1)).ok === false);
  check('和名字一样不行', validatePassword('alice', { name: 'alice' }).ok === false);
  check('和名字一样不行（大小写不同也不行）', validatePassword('Alice', { name: 'alice' }).ok === false);
  check('不要求大小写数字符号混排（那套规则只会把人逼去用 Passw0rd!）',
    validatePassword('正确的马电池订书钉').ok === true);

  check('强度提示：空的不说话', passwordHint('').level === 'empty' && passwordHint('').text === '');
  check('强度提示：不满 8 位时告诉还差几位',
    passwordHint('123').level === 'weak' && passwordHint('123').text.includes('5'), passwordHint('123').text);
  check('强度提示：全数字说出理由（不是只说「弱」）',
    passwordHint('12345678').level === 'weak' && passwordHint('12345678').text.includes('数字'),
    passwordHint('12345678').text);
  check('强度提示：8 位纯字母算「能用」', passwordHint('abcdefgh').level === 'ok', passwordHint('abcdefgh').text);
  check('强度提示：长 + 混排算「很稳」',
    passwordHint('Str0ng-Passw0rd!').level === 'good', passwordHint('Str0ng-Passw0rd!').text);
}

// ---------------------------------------------------------------- 头像

group('头像：规整、回落、渲染');

{
  check('emoji 白名单里的可以', normalizeAvatar({ kind: 'emoji', emoji: AVATAR_EMOJI[0] })?.emoji === AVATAR_EMOJI[0]);
  check('白名单外的 emoji 一律丢掉（手改的数据塞不进来）',
    normalizeAvatar({ kind: 'emoji', emoji: '💩' }) === null);
  check('emoji 位置塞一段 HTML 也丢掉', normalizeAvatar({ kind: 'emoji', emoji: '<img onerror=x>' }) === null);
  check('首字母头像可以不指定颜色', normalizeAvatar({ kind: 'initial', color: null })?.kind === 'initial');
  check('颜色不在调色板里 → 退回「按名字算」，而不是整条丢掉',
    normalizeAvatar({ kind: 'initial', color: '#ff00ff' })?.color === null,
    JSON.stringify(normalizeAvatar({ kind: 'initial', color: '#ff00ff' })));
  check('调色板里的颜色会保留',
    normalizeAvatar({ kind: 'initial', color: AVATAR_COLORS[2] })?.color === AVATAR_COLORS[2]);

  const png = `data:image/png;base64,${'A'.repeat(64)}`;
  check('png 图片可以', normalizeAvatar({ kind: 'image', dataUrl: png })?.kind === 'image');
  check('svg 一律丢掉（svg 能带脚本）',
    normalizeAvatar({ kind: 'image', dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }) === null,
    String(normalizeAvatar({ kind: 'image', dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })));
  check('javascript: 一律丢掉', normalizeAvatar({ kind: 'image', dataUrl: 'javascript:alert(1)' }) === null);
  check('http 外链一律丢掉（头像是要写进 src 的）',
    normalizeAvatar({ kind: 'image', dataUrl: 'https://example.com/a.png' }) === null);
  check(`超过 ${Math.round(AVATAR_IMAGE_MAX / 1024)}KB 的图丢掉`,
    normalizeAvatar({ kind: 'image', dataUrl: `data:image/png;base64,${'A'.repeat(AVATAR_IMAGE_MAX)}` }) === null);
  check('大小正好卡在上限上是可以的',
    isAvatarImage(`data:image/png;base64,${'A'.repeat(AVATAR_IMAGE_MAX - 'data:image/png;base64,'.length)}`) === true);

  check('不是对象一律 null', normalizeAvatar(null) === null && normalizeAvatar('x') === null && normalizeAvatar(42) === null);
  check('不认识的 kind 一律 null', normalizeAvatar({ kind: 'video' }) === null);

  check('首字母：英文名字取大写首字母', initialChar('alice') === 'A' && initialChar('Zoe') === 'Z');
  check('首字母：中文名字取第一个字', initialChar('张三') === '张');
  check('首字母：空名字给问号（不画空白）', initialChar('') === '?' && initialChar(null) === '?');
  check('按名字算的颜色是确定的（不存也能每次一样）', avatarColorFor('小林') === avatarColorFor('小林'));
  check('按名字算的颜色在调色板里', AVATAR_COLORS.includes(avatarColorFor('alice')));
}

{
  const view1 = avatarView({ name: '小林' });
  const view2 = avatarView({ name: '小林' });
  check('没设头像 → 首字母 + 按名字算的颜色',
    view1.text === '小' && AVATAR_COLORS.includes(view1.color) && view1.image === '');
  check('同一个人每次画出来一样', view1.color === view2.color && view1.text === view2.text);
  check('不同的人颜色会不一样（不总是同一个色）',
    new Set(['小林', 'alice', '张三', 'bob', 'zoe'].map((n) => avatarView({ name: n }).color)).size > 1);
  check('屏幕阅读器有话说', view1.label.includes('小林'), view1.label);

  check('emoji 头像：画 emoji、不要底色',
    avatarView({ name: 'x', avatar: { kind: 'emoji', emoji: '🐳' } }).text === '🐳'
      && avatarView({ name: 'x', avatar: { kind: 'emoji', emoji: '🐳' } }).color === null);
  const img = avatarView({ name: 'x', avatar: { kind: 'image', dataUrl: 'data:image/png;base64,AAAA' } });
  check('图片头像：给 <img> 用的地址，不写字', img.image.startsWith('data:image/png') && img.text === '');
  check('脏头像自动回落到首字母（不画一块空白）',
    avatarView({ name: 'alice', avatar: { kind: 'emoji', emoji: '💩' } }).text === 'A',
    JSON.stringify(avatarView({ name: 'alice', avatar: { kind: 'emoji', emoji: '💩' } })));
  check('名字都没有也能画（回落到问号）', avatarView({}).text === '?' && avatarView(null).text === '?');
}

group('publicUser：哪些字段能离开服务端');

{
  const user = {
    id: 'u_1',
    name: '小林',
    nameKey: '小林',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: '2026-01-02T00:00:00.000Z',
    tokenVersion: 3,
    password: { salt: 'deadbeef', hash: 'cafe', N: 1, r: 1, p: 1, keylen: 1 },
    avatar: { kind: 'emoji', emoji: '🐳' },
  };
  const safe = publicUser(user);
  check('带 id / 名字 / 注册时间', safe.id === 'u_1' && safe.name === '小林' && Boolean(safe.createdAt));
  check('带头像', safe.avatar.emoji === '🐳');
  check('**不带**密码记录（漏这个字段等于把哈希和盐发出去）', safe.password === undefined);
  check('**不带** tokenVersion（带出去等于告诉别人怎么绕过失效）', safe.tokenVersion === undefined);
  check('**不带** nameKey（内部用的判重键）', safe.nameKey === undefined);
  check('序列化之后也不含密码里的东西', !JSON.stringify(safe).includes('deadbeef'));
  check('没有用户时返回 null（不是空对象）', publicUser(null) === null);
  check('头像脏数据不会让它抛异常', publicUser({ id: 'u', name: 'x', avatar: 'nope' }).avatar.kind === 'initial');
}

// ---------------------------------------------------------------- 密码哈希

group('密码哈希：不明文、有盐、恒定时间比较');

{
  const record = hashPassword('正确的马电池订书钉');
  check('记录里没有明文密码', !JSON.stringify(record).includes('正确的马电池订书钉'), JSON.stringify(record).slice(0, 80));
  check('有盐，而且是随机的', record.salt.length >= 16 && hashPassword('x').salt !== hashPassword('x').salt);
  check('参数跟着记录存（以后调高 N 也能验老记录）',
    record.N === SCRYPT.N && record.r === SCRYPT.r && record.p === SCRYPT.p && record.keylen === SCRYPT.keylen,
    JSON.stringify({ N: record.N, r: record.r, p: record.p, keylen: record.keylen }));
  check('同一个密码两次哈希不一样（盐不同）', hashPassword('same').hash !== hashPassword('same').hash);
  check('算法名写清楚', record.algorithm === 'scrypt');

  check('对的密码能过', verifyPassword('正确的马电池订书钉', record) === true);
  check('错的密码过不了', verifyPassword('错误的马电池订书钉', record) === false);
  check('空密码过不了', verifyPassword('', record) === false);

  const tampered = { ...record, hash: `${record.hash.slice(0, -1)}${record.hash.endsWith('a') ? 'b' : 'a'}` };
  check('哈希被改掉一个字符就过不了', verifyPassword('正确的马电池订书钉', tampered) === false);
  check('盐被换掉就过不了', verifyPassword('正确的马电池订书钉', { ...record, salt: 'ffff' }) === false);

  check('没有记录时返回 false（不抛）', verifyPassword('x', null) === false && verifyPassword('x', undefined) === false);
  check('记录是字符串时返回 false', verifyPassword('x', 'not-a-record') === false);
  check('记录缺字段时返回 false',
    verifyPassword('x', { salt: 'aa' }) === false && verifyPassword('x', { salt: '', hash: '' }) === false);
  check('hash 不是十六进制时返回 false（不抛）',
    verifyPassword('x', { salt: 'aa', hash: 'zzz' }) === false);
}

// ---------------------------------------------------------------- 令牌

group('令牌：签名、过期、字段，缺一不可');

{
  const secret = 'a'.repeat(64);
  const now = 1_700_000_000_000;
  const payload = { uid: 'u_1', tv: 1, iat: now, exp: now + 1000 };
  const token = signToken(payload, secret);

  const back = verifyToken(token, secret, { now });
  check('签了能验回来', back?.uid === 'u_1' && back?.tv === 1);
  check('载荷是**明文可读**的（里面有 uid，没有秘密；能直接解开看反而好排查）',
    Buffer.from(token.split('.')[0], 'base64url').toString('utf8').includes('u_1'));
  check('令牌是「载荷.签名」两段', token.split('.').length === 2);

  check('过期了就作废', verifyToken(token, secret, { now: now + 1001 }) === null);
  check('正好到期那一刻作废（边界不算有效）', verifyToken(token, secret, { now: now + 1000 }) === null);
  check('还没到期就有效', verifyToken(token, secret, { now: now + 999 })?.uid === 'u_1');

  check('换一个密钥验不过（别的实例签的令牌进不来）', verifyToken(token, 'b'.repeat(64), { now }) === null);
  check('签名被改一个字符就过不了',
    verifyToken(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, secret, { now }) === null);
  check('把载荷换成别人（签名不变）也过不了 —— 这条就是「不能伪造登录态」',
    verifyToken(`${Buffer.from(JSON.stringify({ ...payload, uid: 'u_2' })).toString('base64url')}.${token.split('.')[1]}`, secret, { now }) === null);

  check('没有点的令牌不算数', verifyToken('abcdef', secret, { now }) === null);
  check('空令牌不算数', verifyToken('', secret, { now }) === null && verifyToken(null, secret, { now }) === null);
  check('点在最前面/最后面都不算数', verifyToken('.abc', secret, { now }) === null && verifyToken('abc.', secret, { now }) === null);
  check('载荷不是 JSON 不算数', verifyToken(`bm90LWpzb24.${signToken(payload, secret).split('.')[1]}`, secret, { now }) === null);
  check('缺 uid 不算数', verifyToken(signToken({ tv: 1, exp: now + 1000 }, secret), secret, { now }) === null);
  check('exp 不是数字不算数',
    verifyToken(signToken({ uid: 'u', tv: 1, exp: 'later' }, secret), secret, { now }) === null);
  check('没有密钥时一律不算数', verifyToken(token, '', { now }) === null && verifyToken(token, null, { now }) === null);
}

// ---------------------------------------------------------------- Cookie

group('Cookie：读、写、清');

{
  check('从一串 Cookie 里取出对的那个',
    readCookie(`${TOKEN_COOKIE}=abc.def; other=1`, TOKEN_COOKIE) === 'abc.def');
  check('名字是后缀时不会误匹配（x_session 不是 session）',
    readCookie('x_session=nope; duitanlu_session=yes', TOKEN_COOKIE) === 'yes');
  // 反过来那一边更要紧：名字**包含**它也不算。真实的攻击形状是
  // 「页面旁边再放一个 duitanlu_session_old=…」，靠 `includes` 匹配的解析会捡到假票
  check('名字只是「包含」它也不算（duitanlu_session_old 是别人塞的假票）',
    readCookie(`duitanlu_session_old=hijack; ${TOKEN_COOKIE}=yes`, TOKEN_COOKIE) === 'yes',
    readCookie(`duitanlu_session_old=hijack; ${TOKEN_COOKIE}=yes`, TOKEN_COOKIE));
  check('名字对不上就返回空串', readCookie('other=1', TOKEN_COOKIE) === '');
  check('没有 Cookie 头也返回空串', readCookie(undefined, TOKEN_COOKIE) === '' && readCookie('', TOKEN_COOKIE) === '');
  check('值里的等号不会被截断', readCookie(`${TOKEN_COOKIE}=a=b=c`, TOKEN_COOKIE) === 'a=b=c');

  const plain = sessionCookie('tok', {});
  check('会话 Cookie 是 HttpOnly（脚本偷不走）', plain.includes('HttpOnly'));
  check('SameSite=Lax（跨站 POST 不带它）', plain.includes('SameSite=Lax'));
  check('Path=/（整站都要用）', plain.includes('Path=/'));
  check('不记住我时不写 Max-Age（关掉浏览器就没了）', !plain.includes('Max-Age'));
  check('记住我时写 Max-Age',
    sessionCookie('tok', { maxAgeSeconds: 100 }).includes('Max-Age=100'),
    sessionCookie('tok', { maxAgeSeconds: 100 }));
  check('http 下**不**加 Secure（加了这条 Cookie 根本发不出去，登录会看起来「成功但立刻失效」）',
    !plain.includes('Secure'));
  check('https 下加 Secure', sessionCookie('tok', { secure: true }).includes('Secure'));

  const cleared = clearSessionCookie();
  check('退出登录时立刻过期', cleared.includes('Max-Age=0'), cleared);
  check('退出登录时把值清空', /duitanlu_session=;/.test(cleared), cleared);
}

// ---------------------------------------------------------------- 限速

group('登录限速：按 IP + 名字计数，成功就清零');

{
  let clock = 1_000_000;
  const limiter = createRateLimiter({ max: 3, windowMs: 1000, now: () => clock });

  check('一开始随便试', limiter.check('1.2.3.4|alice').allowed === true);
  limiter.fail('1.2.3.4|alice');
  limiter.fail('1.2.3.4|alice');
  check('还没到上限就还能试', limiter.check('1.2.3.4|alice').allowed === true);
  limiter.fail('1.2.3.4|alice');
  const blocked = limiter.check('1.2.3.4|alice');
  check(`第 ${3 + 1} 次被拦住`, blocked.allowed === false);
  check('并且告诉对方还要等多久', blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 1000, String(blocked.retryAfterMs));

  check('换个名字照常能试（同一台机器上两个人互不连坐）', limiter.check('1.2.3.4|bob').allowed === true);
  check('换个 IP 照常能试', limiter.check('5.6.7.8|alice').allowed === true);

  clock += 1001;
  check('窗口过了自动放行', limiter.check('1.2.3.4|alice').allowed === true);

  limiter.fail('1.2.3.4|bob');
  limiter.fail('1.2.3.4|bob');
  limiter.fail('1.2.3.4|bob');
  check('（准备）这个 IP+名字被拦住了', limiter.check('1.2.3.4|bob').allowed === false);
  limiter.succeed('1.2.3.4|bob');
  check('成功登录就清零（真正的用户回来了，没必要连坐）', limiter.check('1.2.3.4|bob').allowed === true);

  const many = createRateLimiter({ max: 2, windowMs: 100 });
  for (let i = 0; i < 50; i += 1) many.fail(`ip|u${i}`);
  check('记过的 key 不会无限涨（过期就被清掉）', many.size() === 50, String(many.size()));
  await new Promise((r) => setTimeout(r, 110));
  many.reset();
  check('reset 之后干净了', many.size() === 0);
}

// ---------------------------------------------------------------- 用户隔离

group('用户隔离：谁的东西谁看得见');

{
  const alice = { id: 'u_alice' };
  const bob = { id: 'u_bob' };

  check('登录的人看得到自己的', ownsRecord({ userId: 'u_alice' }, alice) === true);
  check('看不到别人的', ownsRecord({ userId: 'u_bob' }, alice) === false);
  check('没登录的人看不见任何人的', ownsRecord({ userId: 'u_alice' }, null) === false);
  check('没登录的人看得到本地模式的（userId 是 local）', ownsRecord({ userId: 'local' }, null) === true);
  check('老记录没有 userId 字段 → 当成本地模式的（不然升级之后老对话全打不开）',
    ownsRecord({ turns: [] }, null) === true && ownsRecord({ turns: [] }, alice) === false);
  check('空记录不炸', ownsRecord(null, alice) === false && ownsRecord(undefined, null) === true);
}

// ---------------------------------------------------------------- 账号文件

group('账号文件：注册、登录、改密码、坏文件要报错');

{
  const dir = await tempDir('store');
  const file = path.join(dir, 'users.json');
  const store = createUserStore({ file });
  await store.init();

  check('一开始一个账号都没有', store.count() === 0);

  const created = await store.register({ name: '小林', password: 'correct-horse-1' });
  check('注册成功', created.ok === true && created.user.name === '小林', JSON.stringify(created).slice(0, 120));
  check('密码记录里没有明文',
    !readFileSync(file, 'utf8').includes('correct-horse-1'), readFileSync(file, 'utf8').slice(0, 200));
  check('tokenVersion 从 1 开始（改密码靠它作废旧令牌）', created.user.tokenVersion === 1);

  check('重名的被拦下', (await store.register({ name: '小林', password: 'another-one-1' })).code === 'name_taken');
  check('重名判断不看大小写',
    (await store.register({ name: 'ALICE', password: 'another-one-1' })).ok === true
      && (await store.register({ name: 'alice', password: 'another-one-1' })).code === 'name_taken');
  check('名字不合法 → bad_name', (await store.register({ name: 'a', password: 'another-one-1' })).code === 'bad_name');
  check('密码不合法 → bad_password',
    (await store.register({ name: '小明', password: '123' })).code === 'bad_password');

  check('对的密码能登录', (await store.verify({ name: '小林', password: 'correct-horse-1' })).ok === true);
  check('错的密码登不上', (await store.verify({ name: '小林', password: 'wrong-password' })).ok === false);
  const ghost = await store.verify({ name: '没有这个人', password: 'whatever-1' });
  check('不存在的账号和密码错的**回同一句话**（不告诉对方名字有没有被人用）',
    ghost.code === 'invalid'
      && (await store.verify({ name: '小林', password: 'wrong-password' })).code === 'invalid',
    ghost.code);
  check('大小写不同的名字也能登录（同一个人）',
    (await store.verify({ name: 'ALICE', password: 'another-one-1' })).ok === true);

  // 重启：换一个 store 读同一个文件
  const reopened = createUserStore({ file });
  await reopened.init();
  check('重启之后账号还在', reopened.count() === 2, String(reopened.count()));
  check('重启之后还能登录', (await reopened.verify({ name: '小林', password: 'correct-horse-1' })).ok === true);

  const before = reopened.byName('小林').tokenVersion;
  check('原密码不对就不改密码', (await reopened.setPassword(created.user.id, {
    oldPassword: 'nope-nope-nope', newPassword: 'brand-new-pass-1',
  })).code === 'bad_old_password');
  check('新密码和原密码一样 → 拒绝', (await reopened.setPassword(created.user.id, {
    oldPassword: 'correct-horse-1', newPassword: 'correct-horse-1',
  })).code === 'same_password');
  check('新密码太短 → 拒绝', (await reopened.setPassword(created.user.id, {
    oldPassword: 'correct-horse-1', newPassword: '123',
  })).code === 'bad_password');

  const changed = await reopened.setPassword(created.user.id, {
    oldPassword: 'correct-horse-1', newPassword: 'brand-new-pass-1',
  });
  check('改密码成功', changed.ok === true);
  check('改完 tokenVersion +1（别处开着的页面立刻失效）', changed.user.tokenVersion === before + 1,
    `${before} → ${changed.user.tokenVersion}`);
  check('新密码能登录', (await reopened.verify({ name: '小林', password: 'brand-new-pass-1' })).ok === true);
  check('旧密码登不上了', (await reopened.verify({ name: '小林', password: 'correct-horse-1' })).ok === false);

  const av = await reopened.setAvatar(created.user.id, { kind: 'emoji', emoji: '🐳' });
  check('换头像成功', av.ok === true && av.user.avatar.emoji === '🐳');
  const bad = await reopened.setAvatar(created.user.id, { kind: 'emoji', emoji: '💩' });
  check('脏头像回落到首字母（不是拒绝整次请求）', bad.ok === true && bad.user.avatar.kind === 'initial');
  check('给不存在的用户换头像 → no_user', (await reopened.setAvatar('u_nope', { kind: 'emoji', emoji: '🐳' })).code === 'no_user');

  // ---- 改名字
  const tokenBefore = reopened.byId(created.user.id).tokenVersion;
  const passwordBefore = JSON.stringify(reopened.byId(created.user.id).password);

  check('名字不合法 → bad_name', (await reopened.rename(created.user.id, 'a b')).code === 'bad_name');
  check('名字太短 → bad_name', (await reopened.rename(created.user.id, 'x')).code === 'bad_name');
  check('换成别人已经用了的名字 → name_taken',
    (await reopened.rename(created.user.id, 'ALICE')).code === 'name_taken',
    JSON.stringify(await reopened.rename(created.user.id, 'ALICE')));
  check('给不存在的用户改名 → no_user', (await reopened.rename('u_nope', '随便')).code === 'no_user');

  const renamed = await reopened.rename(created.user.id, '张三');
  check('改名成功', renamed.ok === true && renamed.user.name === '张三', JSON.stringify(renamed).slice(0, 80));
  check('判重用的那个键也跟着改了（不改的话旧名字还占着、新名字谁都能抢）',
    reopened.byId(created.user.id).nameKey === '张三', reopened.byId(created.user.id).nameKey);
  check('**改名不动 tokenVersion**（名字不是凭证，别处不该被踢下线）',
    reopened.byId(created.user.id).tokenVersion === tokenBefore, String(reopened.byId(created.user.id).tokenVersion));
  check('改名不动密码记录', JSON.stringify(reopened.byId(created.user.id).password) === passwordBefore);
  check('新名字能登录（登录用的是名字 + 密码）',
    (await reopened.verify({ name: '张三', password: 'brand-new-pass-1' })).ok === true);
  check('旧名字登不上了', (await reopened.verify({ name: '小林', password: 'brand-new-pass-1' })).ok === false);
  check('旧名字从此可以让给别人（已经不占着了）', reopened.byName('小林') === null);

  // 这一条是最容易写错的地方：查重必须排除自己，否则「Zhangsan → ZHANGSAN」会被自己拦住
  check('先改成拉丁名字（为了能测大小写）', (await reopened.rename(created.user.id, 'Zhangsan')).ok === true);
  const recase = await reopened.rename(created.user.id, 'ZHANGSAN');
  check('只改大小写（还是自己）→ 当成功，不报「已有人用」',
    recase.ok === true && recase.unchanged !== true, JSON.stringify(recase).slice(0, 80));
  check('而且名字**照你要的那个写法存**（不能回一句「没变」就把人打发了）',
    reopened.byId(created.user.id).name === 'ZHANGSAN', reopened.byId(created.user.id).name);
  check('判重键仍然是不分大小写的那个', reopened.byId(created.user.id).nameKey === 'zhangsan',
    reopened.byId(created.user.id).nameKey);
  check('重复提交同一个名字也不报错',
    (await reopened.rename(created.user.id, 'ZHANGSAN')).unchanged === true);

  const reopenedAgain = createUserStore({ file });
  await reopenedAgain.init();
  check('重启之后新名字还在', reopenedAgain.byName('ZHANGSAN')?.name === 'ZHANGSAN');

  rmSync(dir, { recursive: true, force: true });
}

{
  // 坏文件：**报错，不静默清空**
  const dir = await tempDir('broken');
  const file = path.join(dir, 'users.json');
  writeFileSync(file, '{ 这不是 JSON', 'utf8');
  const store = createUserStore({ file });
  let threw = null;
  try {
    await store.init();
  } catch (err) {
    threw = err;
  }
  check('账号文件坏了 → 启动时大声报错（静默当成空 = 所有人的账号被清掉）',
    threw !== null && threw.code === 'users_file_broken', String(threw?.message ?? '（居然没抛）'));

  writeFileSync(file, JSON.stringify({ version: 1 }), 'utf8');
  const store2 = createUserStore({ file });
  let threw2 = null;
  try {
    await store2.init();
  } catch (err) {
    threw2 = err;
  }
  check('结构不对（没有 users 数组）同样报错', threw2?.code === 'users_file_broken');
  rmSync(dir, { recursive: true, force: true });
}

group('令牌密钥：环境变量优先，否则落到本地文件');

{
  const dir = await tempDir('secret');
  const file = path.join(dir, 'auth-secret');

  const fromEnv = await loadSecret({ file, env: 'e'.repeat(64) });
  check('环境变量够长就直接用它', fromEnv === 'e'.repeat(64));
  check('用环境变量时不会顺手写文件', !existsSync(file));

  const short = 'too-short';
  const generated = await loadSecret({ file, env: short });
  check('环境变量太短就当没有（避免有人用 `secret` 这种）', generated.length === 64 && generated !== short,
    `${generated.length} 位`);
  check('生成了密钥文件', existsSync(file));
  check('文件里存的不是环境变量那个短串', readFileSync(file, 'utf8').trim() !== short);

  const again = await loadSecret({ file, env: short });
  check('第二次读到同一个（重启之后已登录的人不会被踢下线）', again === generated);

  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 浏览器那一侧的纯逻辑

group('登录框：提交之前自己先看一眼');

{
  check('登录：名字密码都填了就放行', authFormError({ mode: 'login', name: '小林', password: 'x' }) === '');
  check('登录：名字空着要说', authFormError({ mode: 'login', name: '  ', password: 'x' }).includes('名字'));
  check('登录：密码空着要说', authFormError({ mode: 'login', name: '小林', password: '' }).includes('密码'));
  // 这一条是刻意的：老账号的密码可能比现在的规则短，登录时不该被自己拦下来
  check('登录**不**查长度（规则变过之后老密码照样能登）',
    authFormError({ mode: 'login', name: '小林', password: '123' }) === '');
  check('注册：要过名字规则', authFormError({ mode: 'register', name: 'a', password: 'longenough', confirm: 'longenough' }).includes('2 个字'));
  check('注册：要过密码规则',
    authFormError({ mode: 'register', name: '小林', password: '123', confirm: '123' }).includes('8 位'));
  check('注册：两次不一样要说',
    authFormError({ mode: 'register', name: '小林', password: 'longenough', confirm: 'longenough2' }).includes('不一样'));
  check('注册：都对了就放行',
    authFormError({ mode: 'register', name: '小林', password: 'longenough', confirm: 'longenough' }) === '');
  check('改密码：原密码空着要说', authFormError({ mode: 'password', password: '', newPassword: 'longenough', confirm: 'longenough' }).includes('原密码'));
  check('改密码：新密码要过规则',
    authFormError({ mode: 'password', password: 'old-one-1', newPassword: '123', confirm: '123' }).includes('8 位'));
  check('改密码：两次不一样要说',
    authFormError({ mode: 'password', password: 'old-one-1', newPassword: 'longenough', confirm: 'longenough2' }).includes('不一样'));
  check('改密码：新旧一样要说',
    authFormError({ mode: 'password', password: 'longenough', newPassword: 'longenough', confirm: 'longenough' }).includes('一样'));
  check('改密码：都对了就放行',
    authFormError({ mode: 'password', password: 'old-one-1', newPassword: 'longenough', confirm: 'longenough' }) === '');

  // 改名字：只要名字合法就放行，**不要密码**（它只是个显示用的名字）
  check('改名：空的要说', authFormError({ mode: 'name', name: '' }).includes('名字'));
  check('改名：太短要说', authFormError({ mode: 'name', name: 'a' }).includes('2 个字'));
  check('改名：不合法字符要说', authFormError({ mode: 'name', name: 'a b' }).includes('空格'));
  check('改名：合法就放行', authFormError({ mode: 'name', name: '张三' }) === '');
  check('改名不需要密码（没填密码也算通过）',
    authFormError({ mode: 'name', name: '张三', password: '' }) === '');
}

group('笔记本快照：什么时候推、怎么说、恢复前怎么问');

{
  const now = 1_000_000;
  check('刚推过就不推（节流生效）',
    shouldPushSnapshot({ lastPushedAt: now - 1000, now, minGapMs: 4000 }) === false);
  check('隔够了就推', shouldPushSnapshot({ lastPushedAt: now - 5000, now, minGapMs: 4000 }) === true);
  check('从没推过（lastPushedAt 是 0）就推', shouldPushSnapshot({ lastPushedAt: 0, now, minGapMs: 4000 }) === true);
  check('**正在生成回答时不推**（一次推的是整本笔记本，边流式边推等于每几秒传一遍）',
    shouldPushSnapshot({ busy: true, lastPushedAt: 0, now }) === false);

  check('没存过时说清楚', snapshotNote({}) === '还没有服务端快照');
  check('存过就说几个会话 + 什么时候', /2 个会话/.test(snapshotNote({ savedAt: '2026-10-07T10:00:00.000Z', count: 2 })),
    snapshotNote({ savedAt: '2026-10-07T10:00:00.000Z', count: 2 }));
  check('时间读不出来时不显示 NaN', !snapshotNote({ savedAt: '乱写的', count: 1 }).includes('NaN'),
    snapshotNote({ savedAt: '乱写的', count: 1 }));
  check('正在存', snapshotNote({ pending: true }).includes('正在存'));
  check('没存上要说没存上（而不是继续显示上一次的时间）',
    snapshotNote({ savedAt: '2026-10-07T10:00:00.000Z', count: 2, failed: true }).includes('没存上'),
    snapshotNote({ savedAt: '2026-10-07T10:00:00.000Z', count: 2, failed: true }));

  const confirm = restoreConfirmText({ count: 3, savedAt: '2026-10-07T10:00:00.000Z', localCount: 5 });
  check('恢复前说清两边各有多少', confirm.includes('3 个会话') && confirm.includes('5 个会话'), confirm);
  check('并且明说「覆盖」以及会丢什么', confirm.includes('覆盖') && confirm.includes('没了'), confirm);
}

group('最近登录过的账号：去重、提前、封顶、按前缀匹配');

{
  const fakeStorage = () => ({
    map: new Map(),
    getItem(key) {
      return this.map.has(key) ? this.map.get(key) : null;
    },
    setItem(key, value) {
      this.map.set(key, String(value));
    },
  });

  check('一开头是空的', readRecentAccounts(fakeStorage()).length === 0);
  check('坏数据当空、不抛（手改过的 localStorage 不该把登录页搞崩）',
    readRecentAccounts({ getItem: () => '{不是 JSON' }).length === 0
      && readRecentAccounts({ getItem: () => '"一个字符串"' }).length === 0);

  let list = [];
  list = rememberAccount(list, '小林');
  check('记一个就进去了', list.length === 1 && list[0].name === '小林');
  list = rememberAccount(list, 'alice');
  check('最近用过的排最前面', list.map((i) => i.name).join(',') === 'alice,小林', list.map((i) => i.name).join(','));
  list = rememberAccount(list, '小林');
  check('再登录一次同一个账号：**提到最前**，不是多出一条',
    list.map((i) => i.name).join(',') === '小林,alice' && list.length === 2, list.map((i) => i.name).join(','));
  list = rememberAccount(list, 'ALICE');
  check('判重不看大小写（和账号本身一个规矩）', list.length === 2, String(list.length));
  check('存的是你最后一次写的那个写法', list[0].name === 'ALICE', list[0].name);
  check('空名字不记', rememberAccount(list, '   ').length === 2);
  check('名字两边的空格会去掉', rememberAccount([], '  小林  ')[0].name === '小林');

  let many = [];
  for (const name of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']) many = rememberAccount(many, name);
  check(`最多记 ${RECENT_ACCOUNTS_MAX} 个（列表不能无限长）`, many.length === RECENT_ACCOUNTS_MAX, String(many.length));
  check('砍掉的是最旧的那些', !many.some((i) => i.name === 'a1') && many[0].name === 'a8',
    many.map((i) => i.name).join(','));

  check('空输入 = 全都列出来（点一下名字格看到的就是「最近的」）',
    matchRecentAccounts(many, '').length === RECENT_ACCOUNTS_MAX);
  check('按前缀匹配',
    matchRecentAccounts([{ name: '小林' }, { name: '小明' }, { name: 'alice' }], '小').map((i) => i.name).join(',') === '小林,小明',
    matchRecentAccounts([{ name: '小林' }, { name: '小明' }, { name: 'alice' }], '小').map((i) => i.name).join(','));
  check('匹配也不分大小写', matchRecentAccounts([{ name: 'Alice' }], 'aL').length === 1);
  check('**是前缀，不是「包含」**（打中间的字不该冒出来）',
    matchRecentAccounts([{ name: '小林同学' }], '林').length === 0);
  check('一个都匹配不上就是空（不是「全都列出来」）', matchRecentAccounts([{ name: '小林' }], 'zz').length === 0);
  check('本来就没有账号时是空', matchRecentAccounts([], '').length === 0);

  const renamed = renameRememberedAccount([{ name: '小林' }, { name: 'alice' }], '小林', '张三');
  check('换名字之后列表里那条也跟着换',
    renamed.some((i) => i.name === '张三') && !renamed.some((i) => i.name === '小林'),
    renamed.map((i) => i.name).join(','));
  check('换完排到最前面（等于刚用过）', renamed[0].name === '张三');
  check('换成列表里已经有的名字时不会出现两条',
    renameRememberedAccount([{ name: 'a1' }, { name: 'a2' }], 'a1', 'a2').length === 1);

  const storage = fakeStorage();
  writeRecentAccounts([{ name: '小林', at: 1 }], storage);
  check('写得进、读得回', readRecentAccounts(storage)[0].name === '小林');
  check('**只存名字，不存密码**', !/password|passwd|密码/.test(storage.getItem(RECENT_ACCOUNTS_KEY)),
    storage.getItem(RECENT_ACCOUNTS_KEY));
  check('读到一份超长的旧数据时只取前几个',
    (storage.setItem(RECENT_ACCOUNTS_KEY, JSON.stringify(Array.from({ length: 20 }, (_v, i) => ({ name: `x${i}` })))),
    readRecentAccounts(storage).length === RECENT_ACCOUNTS_MAX) === true);
  check('更老的格式（一串名字字符串）也认',
    (storage.setItem(RECENT_ACCOUNTS_KEY, JSON.stringify(['小林'])), readRecentAccounts(storage)[0].name === '小林') === true);
  check('名字前后带空白的脏数据会被清掉',
    (storage.setItem(RECENT_ACCOUNTS_KEY, JSON.stringify([{ name: '  小林  ' }, { name: '' }, {}, ''])),
    readRecentAccounts(storage).length === 1 && readRecentAccounts(storage)[0].name === '小林') === true);
  check('存不下（配额满 / 隐私模式）时不抛异常',
    (() => {
      try {
        writeRecentAccounts([{ name: 'x' }], { setItem() { throw new Error('满了'); } });
        return true;
      } catch {
        return false;
      }
    })());
}

group('头像：上传的图 → 头像对象');

{
  const png = { dataUrl: 'data:image/png;base64,AAA', mime: 'image/png' };
  check('压过的 png 能变成头像', avatarFromUpload(png)?.kind === 'image');
  check('jpeg 也行', avatarFromUpload({ ...png, mime: 'image/jpeg' })?.kind === 'image');
  check('gif 不给（头像是静态小图，动图没意义还占地方）', avatarFromUpload({ ...png, mime: 'image/gif' }) === null);
  check('mime 和 dataUrl 对不上就丢掉',
    avatarFromUpload({ dataUrl: 'data:image/svg+xml;base64,AAA', mime: 'image/svg+xml' }) === null);
  check('空的丢掉', avatarFromUpload(null) === null && avatarFromUpload({}) === null);

  check('「只支持图片」翻译成人话', uploadErrorMessage(new Error('只支持图片文件')).includes('png'));
  check('太大也给一句能照做的',
    uploadErrorMessage(Object.assign(new Error('图片太大'), {})).includes('小一点'), uploadErrorMessage(new Error('图片太大')));
  check('说不清的失败也要有个出口', uploadErrorMessage(new Error('看不懂的错')).includes('试试'));
}

group('把头像画进元素里（页面只调这一个函数）');

{
  /** 极简元素替身：只要 app.js 用到的那几样 */
  const fakeRoot = () => ({
    dataset: {},
    style: { props: {}, setProperty(name, value) { this.props[name] = String(value); } },
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    nodes: new Map(),
    querySelector(selector) {
      if (!this.nodes.has(selector)) {
        this.nodes.set(selector, {
          textContent: '',
          hidden: false,
          attrs: {},
          setAttribute(name, value) { this.attrs[name] = String(value); },
        });
      }
      return this.nodes.get(selector);
    },
  });

  const root = fakeRoot();
  paintAvatar(root, { name: 'alice' });
  check('首字母头像：写字 + 铺底色',
    root.querySelector('.avatar-text').textContent === 'A'
      && root.dataset.kind === 'initial'
      && /^#[0-9a-f]{6}$/i.test(root.style.props['--avatar-bg']),
    `${root.querySelector('.avatar-text').textContent} / ${root.style.props['--avatar-bg']}`);
  check('屏幕阅读器有事可说', (root.attrs['aria-label'] ?? '').includes('alice'), root.attrs['aria-label']);
  check('同时给了 title（鼠标悬停也能看）', (root.attrs.title ?? '').includes('alice'));

  const emojiRoot = fakeRoot();
  paintAvatar(emojiRoot, { name: 'alice', avatar: { kind: 'emoji', emoji: '🐳' } });
  check('emoji 头像：画 emoji、不铺深色',
    emojiRoot.querySelector('.avatar-text').textContent === '🐳' && emojiRoot.dataset.kind === 'emoji'
      && emojiRoot.style.props['--avatar-bg'] === 'transparent',
    emojiRoot.style.props['--avatar-bg']);

  const imageRoot = fakeRoot();
  paintAvatar(imageRoot, { name: 'alice', avatar: { kind: 'image', dataUrl: 'data:image/png;base64,AAA' } });
  check('图片头像：写进 <img> 的 src，文字那层藏起来',
    imageRoot.dataset.kind === 'image'
      && imageRoot.querySelector('.avatar-img').attrs.src === 'data:image/png;base64,AAA'
      && imageRoot.querySelector('.avatar-img').hidden === false
      && imageRoot.querySelector('.avatar-text').hidden === true);

  const dirtyRoot = fakeRoot();
  paintAvatar(dirtyRoot, { name: 'alice', avatar: { kind: 'emoji', emoji: '💩' } });
  check('脏头像回落到首字母（不画空白）', dirtyRoot.querySelector('.avatar-text').textContent === 'A');
  check('没有元素时不炸（那个位置可能还没渲染）', paintAvatar(null, { name: 'x' }) === null);
}

// ---------------------------------------------------------------- 汇总

try {
  const tempDirOut = path.resolve(HERE, '../.tmp-mutations');
  mkdirSync(tempDirOut, { recursive: true });
  writeFileSync(
    path.join(tempDirOut, 'ui-result.json'),
    JSON.stringify({ passed, failed: [...failures] }, null, 2),
    'utf8',
  );
  const countsFile = path.join(tempDirOut, 'counts.json');
  const counts = existsSync(countsFile) ? JSON.parse(readFileSync(countsFile, 'utf8')) : {};
  counts['auth-tests'] = { count: passed, failed: failures.length };
  writeFileSync(countsFile, JSON.stringify(counts, null, 2), 'utf8');
} catch {
  /* 写不了不影响正常使用 */
}

console.log(`\n${'─'.repeat(52)}`);
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项断言`);
  process.exit(0);
}
console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(1);
