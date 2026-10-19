'use strict';

/**
 * 账号体系的测试：名字 / 密码 / 头像的规矩、密码哈希、令牌签名、Cookie、
 * 登录限速、账号文件的读写与「坏了不许当空」，以及浏览器那一侧的纯逻辑。
 *
 * 这一层**不碰 HTTP**（那是 test/server.test.js 的事），也不碰真浏览器（那是 ui.test.js）。
 * 运行：node test/auth.test.js
 */

const assert = require('assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const Rules = require('../lib/auth-rules.js');
const Auth = require('../lib/auth.js');
const BrowserAuth = require('../js/auth.js');

const TMP = path.join(os.tmpdir(), 'wa-auth-test-' + process.pid + '-' + Date.now());

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
    pass += 1;
  } catch {
    failures.push(`${label}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`);
  }
}

function ok(value, label) {
  eq(Boolean(value), true, label);
}

async function group(name, fn) {
  const before = failures.length;
  try {
    await fn();
  } catch (err) {
    failures.push(`${name} 抛异常：${err && err.message}`);
  }
  console.log(`  ${failures.length === before ? '✓' : '✗'} ${name}`);
}

(async function main() {
  console.log('账号：规则、密码、令牌、限速、账号文件');

  /* ── 名字 ───────────────────────────────────────────────── */
  await group('名字：2–20 个字，不许空格和奇怪符号，判重不分大小写', () => {
    eq(Rules.validateName('').error, '请填一个名字', '空的要说清楚');
    eq(Rules.validateName('三').error, '名字至少 2 个字', '一个字太短');
    eq(Rules.validateName('三易测试员').ok, true, '中文名字可以');
    eq(Rules.validateName('  Zhang San  ').error, '名字里不能有空格', '空格不行');
    eq(Rules.validateName('a@b').error, '名字只能用中文、字母、数字、下划线和短横线', '符号不行');
    eq(Rules.validateName('zhang_san-1').ok, true, '下划线与短横线可以');
    eq(Rules.validateName('x'.repeat(21)).error, '名字最多 20 个字', '超过 20 个字不行');
    eq(Rules.validateName('  三易  ').name, '三易', '首尾空白去掉，内部不动');
    eq(Rules.nameKey(' ZhangSan ') === Rules.nameKey('zhangsan'), true, '判重键不分大小写');
  });

  /* ── 密码 ───────────────────────────────────────────────── */
  await group('密码：至少 8 位、不能和名字一样；强度提示说得出理由', () => {
    eq(Rules.validatePassword('').error, '请填一个密码', '空的要说清楚');
    eq(Rules.validatePassword('1234567').error, '密码至少 8 位', '七位不行');
    eq(Rules.validatePassword('12345678').ok, true, '八位可以');
    eq(Rules.validatePassword('abcdefgh', { name: 'abcdefgh' }).error, '密码不能和名字一样', '和名字一样不行');
    eq(Rules.passwordHint('123').text, '还差 5 位', '短了就说还差几位');
    eq(Rules.passwordHint('12345678').text, '全是数字，容易被猜到', '全数字要说出来');
    eq(Rules.passwordHint('abcDEF123!@#').level, 'good', '又长又杂的算稳');
    eq(Rules.passwordHint('').level, 'empty', '空的不提示');
  });

  /* ── 头像 ───────────────────────────────────────────────── */
  await group('头像：只认白名单 emoji、首字母配色与自己压过的小图，认不出来就回落到首字母', () => {
    eq(Rules.normalizeAvatar({ kind: 'emoji', emoji: '🖋' }).emoji, '🖋', '白名单里的 emoji 认');
    eq(Rules.normalizeAvatar({ kind: 'emoji', emoji: '💩' }), null, '白名单外的 emoji 丢掉');
    eq(Rules.normalizeAvatar({ kind: 'initial', color: '#123456' }).color, null, '不在配色表里的颜色换成 null');
    eq(Rules.normalizeAvatar({ kind: 'initial', color: '#b23a2b' }).color, '#b23a2b', '配色表里的颜色留着');
    eq(Rules.normalizeAvatar('随便什么'), null, '不是对象就是认不出来');
    eq(Rules.initialChar('zhangsan'), 'Z', '拉丁字母转大写');
    eq(Rules.initialChar('三易'), '三', '中文照原样');
    eq(Rules.initialChar(''), '?', '什么都没有就用问号');
    eq(Rules.avatarColorFor('同一个名字') === Rules.avatarColorFor('同一个名字'), true, '同一个名字永远同一个色');
    ok(Rules.AVATAR_COLORS.indexOf(Rules.avatarColorFor('三易')) >= 0, '算出来的色一定在配色表里');

    const view = Rules.avatarView({ name: '三易', avatar: { kind: 'emoji', emoji: '📝' } });
    eq(view.text, '📝', 'emoji 头像直接给 emoji');
    eq(view.label, '三易：emoji 头像', '给屏幕阅读器一句说明');
    const fallback = Rules.avatarView({ name: '三易', avatar: { kind: 'nonsense' } });
    eq(fallback.text, '三', '认不出来的头像回落到首字母，不画空白');
    ok(Boolean(fallback.color), '回落的头像也有底色');
  });

  await group('自己上传的头像：只收 png/jpeg/webp，且不许把账号文件撑成相册', () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
    const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    const webp = 'data:image/webp;base64,UklGRhIAAABXRUJQ';
    eq(Rules.normalizeAvatar({ kind: 'image', dataUrl: png }).kind, 'image', 'png 认');
    eq(Rules.normalizeAvatar({ kind: 'image', dataUrl: jpeg }).kind, 'image', 'jpeg 认');
    eq(Rules.normalizeAvatar({ kind: 'image', dataUrl: webp }).kind, 'image', 'webp 认');
    eq(Rules.normalizeAvatar({ kind: 'image', dataUrl: 'data:image/svg+xml;base64,AAAA' }), null, 'svg 不收（它能带脚本）');
    eq(Rules.normalizeAvatar({ kind: 'image', dataUrl: 'data:text/html;base64,AAAA' }), null, '不是图片不收');
    eq(Rules.normalizeAvatar({ kind: 'image', dataUrl: 'https://example.com/a.png' }), null, '只认 dataURL，不认外链');
    eq(Rules.normalizeAvatar({ kind: 'image', dataUrl: '' }), null, '空的不要');
    eq(Rules.normalizeAvatar({ kind: 'image' }), null, '没有 dataUrl 的不要');

    const tooBig = 'data:image/png;base64,' + 'A'.repeat(Rules.AVATAR_IMAGE_MAX);
    eq(Rules.isAvatarImage(tooBig), false, `超过 ${Rules.AVATAR_IMAGE_MAX} 字符就不收（否则一次上传能撑爆 users.json）`);
    const justRight = 'data:image/png;base64,' + 'A'.repeat(1024);
    eq(Rules.isAvatarImage(justRight), true, '正常大小收');

    const view = Rules.avatarView({ name: '三易', avatar: { kind: 'image', dataUrl: png } });
    eq(view.image, png, '图片头像把 dataUrl 交给页面');
    eq(view.text, '', '图片头像不写文字');
    eq(view.label, '三易：自己上传的头像', '屏幕阅读器读得出这是上传的图');
  });

  await group('恢复码：12 位、抄写友好（大小写/空格/漏打短横线都认）', () => {
    const code = Auth.makeRecoveryCode();
    eq(code.length, 14, '带短横线一共 14 个字符');
    eq(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), true, '形状是 ABCD-EFGH-JKMN：' + code);
    eq(/[IO01]/.test(code), false, '不含 I / O / 0 / 1（抄写时最容易看错）');
    eq(Auth.makeRecoveryCode() === code, false, '两次生成不一样');

    eq(Rules.isRecoveryCode(code), true, '生成的码自己验得过');
    eq(Rules.isRecoveryCode(code.toLowerCase()), true, '小写也认');
    eq(Rules.isRecoveryCode(code.replace(/-/g, ' ')), true, '空格分隔也认');
    eq(Rules.isRecoveryCode(code.replace(/-/g, '')), true, '漏打短横线也认');
    eq(Rules.isRecoveryCode('AAAA-AAAA-AAA'), false, '少一位就不认');
    eq(Rules.isRecoveryCode('AAAA-AAAA-AAAO'), false, '带字母 O 就不认（它不在字母表里）');
    eq(Rules.isRecoveryCode(''), false, '空的更不认');
    eq(Rules.formatRecoveryCode('abcdefghjkmn'), 'ABCD-EFGH-JKMN', '裸码加回短横线');

    // 存的是哈希：明文码不能出现在记录里
    const record = Auth.hashRecovery(code);
    ok(JSON.stringify(record).indexOf(code.replace(/-/g, '')) < 0, '记录里找不到明文码');
    eq(Auth.verifyRecovery(code, record), true, '对的码验得过');
    eq(Auth.verifyRecovery(code.toLowerCase(), record), true, '小写照样验得过');
    eq(Auth.verifyRecovery('AAAA-AAAA-AAAA', record), false, '错的码验不过');
    eq(Auth.verifyRecovery(code, null), false, '没有记录就是不过');
  });

  await group('publicUser：只给 id / name / createdAt / avatar', () => {
    const user = {
      id: 'u_1',
      name: '三易',
      createdAt: '2026-01-01T00:00:00.000Z',
      avatar: { kind: 'emoji', emoji: '📝' },
      nameKey: '三易',
      tokenVersion: 3,
      password: { hash: 'deadbeef', salt: 'cafe' },
    };
    const out = Rules.publicUser(user);
    eq(Object.keys(out).sort(), ['avatar', 'createdAt', 'id', 'name'], '只有四个字段出去');
    eq(out.password, undefined, '密码记录绝不出去');
    eq(out.tokenVersion, undefined, '令牌版本绝不出去');
    eq(Rules.publicUser(null), null, '没人就回 null');
  });

  /* ── 密码哈希 ───────────────────────────────────────────── */
  await group('密码哈希：scrypt + 随机盐，绝不明文，坏记录不抛异常', () => {
    const a = Auth.hashPassword('correct horse battery');
    const b = Auth.hashPassword('correct horse battery');
    eq(a.hash.length, 128, '64 字节哈希写成 128 个十六进制字符');
    ok(a.salt !== b.salt, '两次的盐不一样');
    ok(a.hash !== b.hash, '两次的哈希也不一样（盐不同）');
    ok(JSON.stringify(a).indexOf('correct horse battery') < 0, '记录里找不到明文');
    eq(a.algorithm, 'scrypt', '算法记下来了');
    eq([a.N, a.r, a.p, a.keylen], [Auth.SCRYPT.N, Auth.SCRYPT.r, Auth.SCRYPT.p, Auth.SCRYPT.keylen], '参数跟着记录存');

    eq(Auth.verifyPassword('correct horse battery', a), true, '对的密码能过');
    eq(Auth.verifyPassword('correct horse batterY', a), false, '差一个大小写就不行');
    eq(Auth.verifyPassword('', a), false, '空密码不行');
    eq(Auth.verifyPassword('whatever', null), false, '没有记录就是不过');
    eq(Auth.verifyPassword('whatever', { salt: 1, hash: 2 }), false, '字段类型不对就是不过');
    eq(Auth.verifyPassword('whatever', { salt: 'ab', hash: 'zz' }), false, '哈希不是十六进制也不抛异常');
    eq(Auth.verifyPassword('whatever', { salt: 'ab', hash: '' }), false, '空哈希不过');

    // 记录里的参数说了算：把 N 改掉就验不过（说明验的时候真的读了记录里的 N，
    // 而不是写死用当前参数 —— 那样以后调高 N 就会把所有老账号锁在门外）
    eq(Auth.verifyPassword('correct horse battery', Object.assign({}, a, { N: 8192 })), false, 'N 被改过就验不过');
    eq(Auth.verifyPassword('correct horse battery', Object.assign({}, a, { keylen: 32 })), true, 'keylen 由哈希长度决定，不改结论');
  });

  /* ── 令牌 ───────────────────────────────────────────────── */
  await group('令牌：自己签、自己验；改一个字节、换个密钥、过期都不认', () => {
    const secret = 'x'.repeat(64);
    const now = 1_700_000_000_000;
    const token = Auth.signToken({ uid: 'u_1', tv: 1, iat: now, exp: now + 1000 }, secret);
    eq(token.split('.').length, 2, '形状是 载荷.签名');
    const payload = Auth.verifyToken(token, secret, { now });
    eq(payload.uid, 'u_1', 'verfiy 之后能拿到 uid');
    eq(payload.tv, 1, '令牌版本也在里面');

    // 载荷是明文可读的（刻意不加密：里面没有秘密，出问题时能直接看一眼）
    const body = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
    eq(body.uid, 'u_1', '载荷 base64 解开就能读懂');

    eq(Auth.verifyToken(token, secret, { now: now + 1001 }), null, '过期就不认');
    eq(Auth.verifyToken(token, secret + 'x', { now }), null, '换密钥就不认');
    eq(Auth.verifyToken(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), secret, { now }), null, '签名改一个字节就不认');

    // 改载荷（比如把自己写成管理员）——签名对不上
    const forgedBody = Buffer.from(JSON.stringify({ uid: 'u_2', tv: 1, exp: now + 1000 })).toString('base64url');
    eq(Auth.verifyToken(forgedBody + '.' + token.split('.')[1], secret, { now }), null, '改载荷就作废');

    eq(Auth.verifyToken('', secret), null, '空令牌不认');
    eq(Auth.verifyToken('没有点', secret), null, '没有点的不认');
    eq(Auth.verifyToken('.abc', secret), null, '点在最前面不认');
    eq(Auth.verifyToken('abc.', secret), null, '点在最后面不认');
    eq(Auth.verifyToken(token, ''), null, '没有密钥一律不认');
    eq(Auth.verifyToken('%', secret), null, '形状不对不抛异常，回 null');
  });

  /* ── Cookie ─────────────────────────────────────────────── */
  await group('Cookie：HttpOnly + SameSite=Lax；记住我才给 Max-Age；退出立刻过期', () => {
    const cookie = Auth.sessionCookie('tok.en');
    ok(cookie.indexOf(`${Auth.TOKEN_COOKIE}=tok.en`) === 0, '名字与值在最前面');
    ok(/HttpOnly/.test(cookie), '脚本读不到（HttpOnly）');
    ok(/SameSite=Lax/.test(cookie), '跨站 POST 不带它');
    ok(/Path=\//.test(cookie), '整个站点都要用');
    ok(!/Max-Age/.test(cookie), '没勾「记住我」就不写 Max-Age（浏览器会话 Cookie）');
    ok(!/Secure/.test(cookie), '本机 http 下不能加 Secure（加了就永远发不出去）');
    ok(/Max-Age=2592000/.test(Auth.sessionCookie('t', { maxAgeSeconds: 30 * 24 * 3600 })), '勾了就 30 天');
    ok(/Secure/.test(Auth.sessionCookie('t', { secure: true })), 'https 下才加 Secure');
    ok(/Max-Age=0/.test(Auth.clearSessionCookie()), '退出用一个立刻过期的空值覆盖');

    eq(Auth.readCookie('a=1; sanyi_session=tok.en; b=2', Auth.TOKEN_COOKIE), 'tok.en', '从中间也取得出来');
    eq(Auth.readCookie('sanyi_session=tok%2Een', Auth.TOKEN_COOKIE), 'tok.en', '解一次 URL 编码');
    eq(Auth.readCookie('a=1', Auth.TOKEN_COOKIE), '', '没有就是空串');
    eq(Auth.readCookie('', Auth.TOKEN_COOKIE), '', '空头也安全');
    eq(Auth.readCookie('sanyi_session=%E0%A4%A', Auth.TOKEN_COOKIE), '', '坏编码不抛异常');
  });

  /* ── 限速 ───────────────────────────────────────────────── */
  await group('登录限速：试 8 次就慢下来，成功了清零，窗口过了自动恢复', () => {
    let clock = 1_000_000;
    const limiter = Auth.createRateLimiter({ max: 3, windowMs: 1000, now: () => clock });

    eq(limiter.check('ip|三易').allowed, true, '一开始能试');
    limiter.fail('ip|三易');
    limiter.fail('ip|三易');
    eq(limiter.check('ip|三易').allowed, true, '两次失败还能试');
    limiter.fail('ip|三易');
    const blocked = limiter.check('ip|三易');
    eq(blocked.allowed, false, '第三次失败之后挡住了');
    ok(blocked.retryAfterMs > 0, '并且告诉还要等多久');
    eq(limiter.check('ip|另一个人').allowed, true, '换个人不连坐');

    clock += 1001;
    eq(limiter.check('ip|三易').allowed, true, '窗口过去自动放行');

    limiter.fail('ip|三易');
    limiter.succeed('ip|三易');
    eq(limiter.check('ip|三易').allowed, true, '成功一次就清零');
    eq(limiter.size(), 0, '清零之后表里没有它了');

    // 只数失败：连续成功不该把自己锁住
    for (let i = 0; i < 10; i += 1) limiter.succeed('ip|勤快人');
    eq(limiter.check('ip|勤快人').allowed, true, '成功不累计');
  });

  /* ── 账号文件 ───────────────────────────────────────────── */
  await group('账号文件：注册、重名、登录、改名字、改密码、重启后还在', async () => {
    const file = path.join(TMP, 'users.json');
    const store = Auth.createUserStore({ file });
    eq(await store.init(), 0, '一开始没有账号（文件不存在不算坏）');

    const created = await store.register({ name: '三易测试员', password: 'test-pass-2024' });
    eq(created.ok, true, '注册成功');
    eq(created.user.id.startsWith('u_'), true, 'id 是服务端生成的');
    eq(typeof created.user.password.hash, 'string', '密码存成哈希');
    ok(JSON.stringify(created.user.password).indexOf('test-pass-2024') < 0, '账号条目里找不到明文密码');
    eq(created.user.tokenVersion, 1, '令牌版本从 1 开始');
    eq(created.user.avatar, { kind: 'initial', color: null }, '默认是首字母头像');
    ok(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(created.recoveryCode), '注册时给一把恢复码：' + created.recoveryCode);
    eq(typeof created.user.recovery.hash, 'string', '恢复码存成哈希');

    const disk = await fsp.readFile(file, 'utf8');
    ok(disk.indexOf('test-pass-2024') < 0, '落盘的文件里也没有明文密码');
    ok(disk.indexOf(created.recoveryCode) < 0, '也没有明文恢复码');
    eq(disk.indexOf('\t'), -1, '写的是 2 空格缩进的 JSON');
    const leftovers = (await fsp.readdir(TMP)).filter((n) => n.endsWith('.tmp'));
    eq(leftovers, [], '没有留下 .tmp 残骸（先写临时文件再改名）');

    eq((await store.register({ name: '三易测试员', password: 'another-pass' })).code, 'name_taken', '重名挡住');
    eq((await store.register({ name: 'SAN YI', password: 'another-pass' })).code, 'bad_name', '带空格的名字挡住');
    eq((await store.register({ name: 'Al', password: 'al' })).code, 'bad_password', '太短的密码挡住');

    const other = await store.register({ name: 'Another', password: 'another-pass' });
    eq(other.ok, true, '第二个账号也能注册');
    eq((await store.register({ name: 'another', password: 'third-pass-1' })).code, 'name_taken', '重名不分大小写');

    eq((await store.verify({ name: '三易测试员', password: 'test-pass-2024' })).ok, true, '密码对能登录');
    const wrong = await store.verify({ name: '三易测试员', password: 'nope-nope-nope' });
    eq(wrong.ok, false, '密码错登不上');
    eq(wrong.code, 'invalid', '不告诉对方是名字错还是密码错');
    eq((await store.verify({ name: '没有这个人', password: 'whatever-123' })).code, 'invalid', '没这个人也是同一句话');

    const renamed = await store.rename(created.user.id, '新名字');
    eq(renamed.ok, true, '改名字成功');
    eq(renamed.user.name, '新名字', '名字换了');
    eq(renamed.user.nameKey, '新名字', '判重键跟着换（不然旧名字还占着）');
    eq(renamed.user.tokenVersion, 1, '改名字不动令牌版本（名字不是凭证）');
    const caseOnly = await store.rename(created.user.id, '新名字');
    eq(caseOnly.unchanged, true, '一字不差就是没变');
    eq((await store.rename(other.user.id, '新名字')).code, 'name_taken', '重名挡住');

    const changed = await store.setPassword(created.user.id, { oldPassword: 'test-pass-2024', newPassword: 'brand-new-pass' });
    eq(changed.ok, true, '改密码成功');
    eq(changed.user.tokenVersion, 2, '改密码让令牌版本 +1（别处立刻失效）');
    eq((await store.setPassword(created.user.id, { oldPassword: 'test-pass-2024', newPassword: 'x-pass-2024' })).code, 'bad_old_password', '原密码不对就不改');
    eq((await store.setPassword(created.user.id, { oldPassword: 'brand-new-pass', newPassword: 'brand-new-pass' })).code, 'same_password', '新密码和原密码一样就挡住');
    eq((await store.verify({ name: '新名字', password: 'brand-new-pass' })).ok, true, '新密码能登录');
    eq((await store.verify({ name: '新名字', password: 'test-pass-2024' })).ok, false, '旧密码不行了');

    // 认不出来的头像回落到首字母（先测这个，免得它把下面那个好头像盖掉）
    eq((await store.setAvatar(created.user.id, { kind: 'emoji', emoji: '💩' })).user.avatar.kind, 'initial', '乱七八糟的头像回落到首字母');

    const avatar = await store.setAvatar(created.user.id, { kind: 'emoji', emoji: '📝' });
    eq(avatar.user.avatar, { kind: 'emoji', emoji: '📝' }, '头像换成功');

    // 重启：新建一个 store 读同一个文件
    const reopened = Auth.createUserStore({ file });
    eq(await reopened.init(), 2, '重启之后账号还在');
    eq((await reopened.verify({ name: '新名字', password: 'brand-new-pass' })).ok, true, '重启之后还能登录');
    eq(reopened.byId(created.user.id).avatar.emoji, '📝', '头像也还在');
    eq(reopened.byId('u_不存在'), null, '没有的 id 回 null');
  });

  await group('找回密码：用恢复码换掉密码，旧码当场作废，换一把新的', async () => {
    const file = path.join(TMP, 'recover.json');
    const store = Auth.createUserStore({ file });
    await store.init();
    const reg = await store.register({ name: '忘记密码的人', password: 'forgot-this-1' });
    const code = reg.recoveryCode;

    eq((await store.recover({ name: '忘记密码的人', code: 'AAAA-AAAA-AAAA', newPassword: 'brand-new-pass' })).code, 'invalid', '错码不放行');
    eq((await store.recover({ name: '查无此人', code, newPassword: 'brand-new-pass' })).code, 'invalid', '没这个人也是同一句话');
    eq((await store.recover({ name: '忘记密码的人', code, newPassword: 'short' })).code, 'bad_password', '新密码太短挡住');
    eq((await store.recover({ name: '忘记密码的人', code, newPassword: 'forgot-this-1' })).code, 'same_password', '新密码和原密码一样挡住');

    const verifyAfter = await store.verify({ name: '忘记密码的人', password: 'forgot-this-1' });
    eq(verifyAfter.ok, true, '上面几次失败都没动原密码');

    const recovered = await store.recover({ name: '忘记密码的人', code: code.replace(/-/g, ' ').toLowerCase(), newPassword: 'brand-new-pass' });
    eq(recovered.ok, true, '码对了就重置（大小写、空格都宽容）');
    eq(recovered.user.tokenVersion, 2, 'tokenVersion + 1：别处的旧票立刻失效');
    ok(recovered.recoveryCode !== code, '换了一把新钥匙');
    eq((await store.verify({ name: '忘记密码的人', password: 'brand-new-pass' })).ok, true, '新密码能登录');
    eq((await store.verify({ name: '忘记密码的人', password: 'forgot-this-1' })).ok, false, '旧密码不行了');
    eq((await store.recover({ name: '忘记密码的人', code, newPassword: 'third-pass-9' })).code, 'invalid', '旧恢复码不能再用（否则它就是永久后门）');
    eq((await store.recover({ name: '忘记密码的人', code: recovered.recoveryCode, newPassword: 'third-pass-9' })).ok, true, '新恢复码能用');

    // 加恢复码之前的老账号：明确回 no_recovery，界面据此指到命令行
    const legacy = store.byName('忘记密码的人');
    if (legacy) legacy.recovery = null;
    eq((await store.recover({ name: '忘记密码的人', code: 'ABCD-EFGH-JKMN', newPassword: 'whatever-pass' })).code, 'no_recovery', '没有恢复码要说清是哪一种失败');

    // 本机命令行那条路：它就是「能读写这台机器的 data/」这个凭证
    const forced = await store.forcePassword('忘记密码的人', 'command-line-pass');
    eq(forced.ok, true, '命令行能强制重置');
    ok(/^[A-Z2-9]{4}-/.test(forced.recoveryCode), '顺手发一把新钥匙');
    eq((await store.verify({ name: '忘记密码的人', password: 'command-line-pass' })).ok, true, '新密码能登录');
    eq((await store.forcePassword('查无此人', 'whatever-pass')).code, 'no_user', '没有这个账号要说出来');
    eq((await store.forcePassword('忘记密码的人', 'short')).code, 'bad_password', '命令行也不能把密码设成一坨垃圾');
    eq(store.names().map((n) => n.name).indexOf('忘记密码的人') >= 0, true, '--list 能列出账号名');
    eq(store.names()[0].hash, undefined, '但名录里没有哈希');
  });

  await group('账号文件坏了：大声报错，绝不当作空', async () => {
    const file = path.join(TMP, 'broken.json');
    await fsp.writeFile(file, '{ 这不是 JSON', 'utf8');
    const store = Auth.createUserStore({ file });
    let caught = null;
    try {
      await store.init();
    } catch (err) {
      caught = err;
    }
    ok(caught, '读坏了要抛出来');
    eq(caught && caught.code, 'users_file_broken', '错误码说清是文件坏了');
    eq(store.loaded, false, '没标记成已加载');
    eq(store.count(), 0, '内存里也不装作有账号');

    const wrongShape = path.join(TMP, 'wrong-shape.json');
    await fsp.writeFile(wrongShape, JSON.stringify({ version: 1 }), 'utf8');
    let caught2 = null;
    try {
      await Auth.createUserStore({ file: wrongShape }).init();
    } catch (err) {
      caught2 = err;
    }
    eq(caught2 && caught2.code, 'users_file_broken', '结构不对也算坏了');
    ok(fs.existsSync(wrongShape), '坏文件没被悄悄删掉或覆盖');
  });

  await group('签名密钥：环境变量优先，否则生成一个 64 位十六进制的文件', async () => {
    const file = path.join(TMP, 'auth-secret');
    const fromEnv = await Auth.loadSecret({ file, env: 'e'.repeat(40) });
    eq(fromEnv, 'e'.repeat(40), '环境变量够长就直接用');
    eq(fs.existsSync(file), false, '用了环境变量就不往磁盘写');

    const generated = await Auth.loadSecret({ file, env: '' });
    eq(generated.length, 64, '生成 64 位十六进制');
    eq((await fsp.readFile(file, 'utf8')).trim(), generated, '落盘的就是它');
    eq(await Auth.loadSecret({ file, env: '' }), generated, '第二次读回来是同一个（不然重启就全掉线）');

    const tooShort = await Auth.loadSecret({ file: path.join(TMP, 'short-secret'), env: 'short' });
    ok(tooShort.length === 64, '环境变量太短不算数，照样生成');
  });

  /* ── 浏览器那一侧 ───────────────────────────────────────── */
  await group('最近登录过的账号：去重、提前、封顶，脏数据当空', () => {
    const map = new Map();
    const storage = {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => void map.set(k, String(v)),
    };
    map.set(BrowserAuth.RECENT_ACCOUNTS_KEY, '这不是 JSON');
    eq(BrowserAuth.readRecentAccounts(storage), [], '坏了就当空，绝不让登录框炸掉');
    map.set(BrowserAuth.RECENT_ACCOUNTS_KEY, JSON.stringify(['老格式的名字']));
    eq(BrowserAuth.readRecentAccounts(storage)[0].name, '老格式的名字', '只存字符串的老数据也认');

    let list = [];
    list = BrowserAuth.rememberAccount(list, '三易', { at: 1 });
    list = BrowserAuth.rememberAccount(list, 'Another', { at: 2 });
    eq(list[0].name, 'Another', '新的排最前');
    list = BrowserAuth.rememberAccount(list, '三易', { at: 3 });
    eq(list.length, 2, '重复的不新增');
    eq(list[0].name, '三易', '再登录一次就提到最前');

    for (let i = 0; i < 12; i += 1) list = BrowserAuth.rememberAccount(list, `账号${i}`, { at: i });
    eq(list.length, BrowserAuth.RECENT_ACCOUNTS_MAX, '最多留 6 个');

    eq(BrowserAuth.matchRecentAccounts(list, '账号')[0].name, '账号11', '按前缀匹配（且新的在前）');
    eq(BrowserAuth.matchRecentAccounts(list, '账号').length, 6, '最多回 6 条');
    eq(BrowserAuth.matchRecentAccounts(list, '').length, list.length, '空输入就是全都列出来');

    const renamed = BrowserAuth.renameRememberedAccount(list, '账号11', '改过的名字', { at: 99 });
    eq(renamed[0].name, '改过的名字', '换名字之后列表里也换成新的');
    eq(renamed.filter((item) => item.name === '账号11').length, 0, '旧名字那一行没了');

    eq(BrowserAuth.writeRecentAccounts([], storage), [], '写空也不炸');
    eq(BrowserAuth.readRecentAccounts({ getItem() { throw new Error('隐私模式'); } }), [], '读不了就当空');
  });

  await group('提交之前先自己看一眼：五张脸的校验说的是人话', () => {
    eq(BrowserAuth.authFormError({ mode: 'login', name: '', password: 'x' }), '请填一个名字', '登录没名字');
    eq(BrowserAuth.authFormError({ mode: 'login', name: '三易', password: '' }), '请填一个密码', '登录没密码');
    eq(BrowserAuth.authFormError({ mode: 'login', name: '三易', password: '短' }), '', '登录不查密码长度（老账号照样能进）');
    eq(BrowserAuth.authFormError({ mode: 'register', name: '三易', password: 'test-pass-2024', confirm: 'test-pass-2025' }), '两次输入的密码不一样', '注册两次密码要一样');
    eq(BrowserAuth.authFormError({ mode: 'register', name: '三易', password: '1234', confirm: '1234' }), '密码至少 8 位', '注册要查长度');
    eq(BrowserAuth.authFormError({ mode: 'name', name: 'a b' }), '名字里不能有空格', '改名字只查名字');
    eq(BrowserAuth.authFormError({ mode: 'name', name: '三易' }), '', '改名字合法就放行');
    eq(BrowserAuth.authFormError({ mode: 'password', name: '三易', password: '', newPassword: 'brand-new-pass' }), '请填原密码', '改密码要原密码');
    eq(BrowserAuth.authFormError({ mode: 'password', name: '三易', password: 'old-pass-2024', newPassword: 'old-pass-2024', confirm: 'old-pass-2024' }), '新密码和原密码一样', '新密码不能和原密码一样');
    eq(BrowserAuth.authFormError({ mode: 'password', name: '三易', password: 'old-pass-2024', newPassword: 'brand-new-pass', confirm: 'brand-new-pass' }), '', '都对就放行');

    // 找回密码那一屏：恢复码当场验形状，不把一个明显抄错的码发到服务端
    eq(BrowserAuth.authFormError({ mode: 'recover', name: '', code: 'ABCD-EFGH-JKMN', newPassword: 'brand-new-pass', confirm: 'brand-new-pass' }), '请填名字', '找回密码要名字');
    const badCode = BrowserAuth.authFormError({ mode: 'recover', name: '三易', code: 'ABCD-EFG', newPassword: 'brand-new-pass', confirm: 'brand-new-pass' });
    ok(badCode.indexOf('恢复码') === 0, '恢复码位数不对当场说清：' + badCode);
    eq(BrowserAuth.authFormError({ mode: 'recover', name: '三易', code: 'ABCD-EFGH-JKMN', newPassword: 'short', confirm: 'short' }), '密码至少 8 位', '新密码要查长度');
    eq(BrowserAuth.authFormError({ mode: 'recover', name: '三易', code: 'ABCD-EFGH-JKMN', newPassword: 'brand-new-pass', confirm: 'brand-new-pas' }), '两次输入的新密码不一样', '两次要一样');
    eq(BrowserAuth.authFormError({ mode: 'recover', name: '三易', code: 'abcd efgh jkmn', newPassword: 'brand-new-pass', confirm: 'brand-new-pass' }), '', '抄得潦草（小写 + 空格）也放行');
  });

  await group('上传前先压图：长边算得对，压完的头像对象再验一道', () => {
    eq(BrowserAuth.fitSize(400, 200, 128), { width: 128, height: 64, scaled: true }, '横图按长边缩');
    eq(BrowserAuth.fitSize(200, 400, 128), { width: 64, height: 128, scaled: true }, '竖图同理');
    eq(BrowserAuth.fitSize(100, 80, 128), { width: 100, height: 80, scaled: false }, '本来就小就不动');
    eq(BrowserAuth.fitSize(0, 0, 128).scaled, false, '量不出尺寸就当正方形兜底');
    eq(BrowserAuth.fitSize(1000, 3, 128).height >= 1, true, '再扁的图也不会缩成 0 像素');
    eq(BrowserAuth.AVATAR_MAX_EDGE, 128, '上限是 128px');

    const png = 'data:image/png;base64,iVBORw0KGgo=';
    eq(BrowserAuth.avatarFromUpload({ dataUrl: png, mime: 'image/png' }).kind, 'image', '正常的压图结果能变成头像');
    eq(BrowserAuth.avatarFromUpload({ dataUrl: png, mime: 'image/gif' }), null, 'gif 不收');
    eq(BrowserAuth.avatarFromUpload({ dataUrl: 'data:image/png;base64,' + 'A'.repeat(99999), mime: 'image/png' }), null, '压完还太大也不收');
    eq(BrowserAuth.avatarFromUpload(null), null, '什么都没有就是 null');
    eq(BrowserAuth.uploadErrorMessage(new Error('只支持图片文件')).indexOf('png / jpg / webp') >= 0, true, '说清支持哪几种格式');
    eq(BrowserAuth.uploadErrorMessage(new Error('随便什么错')).indexOf('换一张') > 0, true, '别的错也给一句能照着做的话');
  });

  await group('画头像：只问 avatarView，认不出来也画得出首字母', () => {
    const fakeRoot = () => {
      const text = { textContent: '', hidden: false };
      const img = {
        hidden: true,
        src: '',
        setAttribute(name, value) {
          if (name === 'src') this.src = String(value);
        },
      };
      return {
        dataset: {},
        attrs: {},
        text,
        img,
        style: {
          setProperty(name, value) {
            this.props = Object.assign({}, this.props, { [name]: value });
          },
        },
        setAttribute(name, value) {
          this.attrs[name] = String(value);
        },
        querySelector(sel) {
          if (sel === '.avatar__text') return text;
          if (sel === '.avatar__img') return img;
          return null;
        },
      };
    };

    const root = fakeRoot();
    const view = BrowserAuth.paintAvatar(root, { name: '三易', avatar: { kind: 'emoji', emoji: '🖋' } });
    eq(root.text.textContent, '🖋', 'emoji 写进节点');
    eq(view.text, '🖋', '返回的视图也对');
    eq(root.attrs['aria-label'], '三易：emoji 头像', '给了屏幕阅读器的说明');
    eq(root.img.hidden, true, 'emoji 头像不显示 <img>');

    const root2 = fakeRoot();
    BrowserAuth.paintAvatar(root2, { name: 'zhangsan' });
    eq(root2.text.textContent, 'Z', '没有头像就画首字母');
    eq(root2.dataset.kind, 'initial', '标了 kind');
    eq(BrowserAuth.paintAvatar(null, { name: 'x' }), null, '没有节点也不炸');

    // 自己上传的图：<img> 顶上，首字母收起来
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const root3 = fakeRoot();
    BrowserAuth.paintAvatar(root3, { name: '三易', avatar: { kind: 'image', dataUrl: png } });
    eq(root3.dataset.kind, 'image', '标成图片头像');
    eq(root3.img.hidden, false, '<img> 显示出来');
    eq(root3.img.src, png, 'src 指向那张图');
    eq(root3.text.hidden, true, '首字母收起来');
    eq(root3.attrs['aria-label'], '三易：自己上传的头像', '说明里写清是上传的图');
  });

  const total = pass + failures.length;
  console.log(`\n通过 ${pass}/${total}`);
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exitCode = 1;
  }
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
})();
