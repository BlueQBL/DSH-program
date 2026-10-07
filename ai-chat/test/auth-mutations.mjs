// 账号体系的变异测试：确认那一批断言真的抓得住缺陷
//
//   node test/auth-mutations.mjs
//
// 骨架在 test/mutation-harness.mjs（快照、还原、崩溃判定、收尾都在那边）。
//
// 这里打的都是**认证里最不能错的地方**：签名校验、过期、密码比较、账号唯一性、
// 用户隔离、改密码后旧令牌失效、限速、Cookie 属性、头像白名单、坏文件的处理。
// 每一条被改坏之后都必须有断言失败 —— 没失败的那条断言就是摆设。
//
// 界面那一侧（登录后换笔记本、恢复前要确认、401 之后数据不丢）的变异在
// test/ui-mutations.mjs 里，因为那些要跑 ui-tests。

import { createMutationRunner } from './mutation-harness.mjs';

const AUTH = 'lib/auth.mjs';
const RULES = 'public/lib/auth-rules.js';
const CLIENT = 'public/lib/auth.js';

const runner = createMutationRunner({
  label: '账号与登录',
  suite: 'test/auth-tests.mjs',
  files: [AUTH, RULES, CLIENT],
});

// ---------------------------------------------------------------- 令牌

runner.run('不校验令牌签名（谁都能伪造一张登录票）', AUTH, (src) =>
  src.replace('  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;', '  if (a.length !== b.length) return null;'),
);

runner.run('不看过期时间（30 天变永久）', AUTH, (src) =>
  src.replace(
    '  if (!Number.isFinite(payload.exp) || payload.exp <= now) return null;',
    '  if (!Number.isFinite(payload.exp)) return null;',
  ),
);

runner.run('不检查令牌里的 uid（载荷随便填也算数）', AUTH, (src) =>
  src.replace('  if (typeof payload.uid !== \'string\' || !payload.uid) return null;\n', ''),
);

// ---------------------------------------------------------------- 密码

runner.run('密码比较换成 ===（Buffer 按引用比，永远不相等 —— 谁都登不进来）', AUTH, (src) =>
  src.replace(
    '  if (actual.length !== expected.length) return false;\n  return timingSafeEqual(actual, expected);',
    '  if (actual.length !== expected.length) return false;\n  return actual === expected;',
  ),
);

runner.run('密码验证恒真（认证彻底失效）', AUTH, (src) =>
  src.replace(
    '  if (actual.length !== expected.length) return false;\n  return timingSafeEqual(actual, expected);',
    '  if (actual.length !== expected.length) return false;\n  return true;',
  ),
);

runner.run('哈希不用随机盐（同一个密码所有人同一个哈希）', AUTH, (src) =>
  src.replace(
    "export function hashPassword(password, { salt = randomBytes(16).toString('hex') } = {}) {",
    "export function hashPassword(password, { salt = 'fixed-salt-for-everyone' } = {}) {",
  ),
);

runner.run('改密码不校验原密码（拿到一台没锁屏的机器就能把号占了）', AUTH, (src) =>
  src.replace(
    "      if (!verifyPassword(oldPassword, user.password)) {\n        return { ok: false, code: 'bad_old_password', error: '原密码不对' };\n      }\n",
    '',
  ),
);

runner.run('改密码不把 tokenVersion +1（别处偷到的那张票继续有效）', AUTH, (src) =>
  src.replace('      user.tokenVersion = (Number(user.tokenVersion) || 1) + 1;\n', ''),
);

// ---------------------------------------------------------------- 名字与密码规则

runner.run('名字判重不分大小写（Alice 和 alice 变成两个人）', RULES, (src) =>
  src.replace('  return normalizeName(name).toLowerCase();', '  return normalizeName(name);'),
);

runner.run('名字什么字符都收（空格、符号、emoji 全放进来）', RULES, (src) =>
  src.replace(
    "  if (!/^[\\w\\u4e00-\\u9fa5-]+$/.test(name)) {\n    return { ok: false, error: '名字只能用中文、字母、数字、下划线和短横线' };\n  }",
    '',
  ),
);

runner.run('密码不查最短长度', RULES, (src) =>
  src.replace('  if (password.length < PASSWORD_MIN) return { ok: false, error: `密码至少 ${PASSWORD_MIN} 位` };\n', ''),
);

// ---------------------------------------------------------------- 头像

runner.run('头像不查大小（一次上传就能把账号文件撑爆）', RULES, (src) =>
  src.replace(
    "  if (typeof dataUrl !== 'string' || dataUrl.length > AVATAR_IMAGE_MAX) return false;",
    "  if (typeof dataUrl !== 'string') return false;",
  ),
);

runner.run('头像图片放开类型（svg 也能当头像 —— 那东西能带脚本）', RULES, (src) =>
  src.replace(
    '  return /^data:image\\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl);',
    '  return /^data:image\\//.test(dataUrl);',
  ),
);

runner.run('emoji 不查白名单（塞什么进去都画）', RULES, (src) =>
  src.replace(
    '    return AVATAR_EMOJI.includes(raw.emoji) ? { kind: \'emoji\', emoji: raw.emoji } : null;',
    '    return typeof raw.emoji === \'string\' ? { kind: \'emoji\', emoji: raw.emoji } : null;',
  ),
);

runner.run('emoji 头像不画 emoji（一律当首字母处理）', RULES, (src) =>
  src.replace('  if (avatar.kind === \'emoji\') {', '  if (false) {'),
);

runner.run('publicUser 把密码记录一起发出去', RULES, (src) =>
  src.replace(
    '  return {\n    id: user.id,\n    name: user.name,',
    '  return {\n    id: user.id,\n    password: user.password,\n    tokenVersion: user.tokenVersion,\n    name: user.name,',
  ),
);

// ---------------------------------------------------------------- 用户隔离与账号文件

runner.run('不判记录归谁（谁都能看别人的会话）', AUTH, (src) =>
  src.replace("  return (record?.userId ?? 'local') === owner;", '  return true;'),
);

runner.run('账号文件坏了当成空（所有人的账号被清掉，谁都能拿原来的名字重新注册）', AUTH, (src) =>
  src.replace(
    '    } catch {\n      throw Object.assign(new Error(`账号文件不是合法 JSON：${file}`), { code: \'users_file_broken\' });\n    }',
    '    } catch {\n      users = [];\n      loaded = true;\n      return;\n    }',
  ),
);

runner.run('注册不查重名（同名账号可以建无数个）', AUTH, (src) =>
  src.replace(
    "      if (findByName(checkedName.name)) {\n        return { ok: false, code: 'name_taken', error: '这个名字已经有人用了' };\n      }\n",
    '',
  ),
);

// ---------------------------------------------------------------- 限速与 Cookie

runner.run('限速不记失败（可以对着密码试一整夜）', AUTH, (src) =>
  src.replace('      list.push(at);\n      hits.set(String(key), list);', '      hits.set(String(key), list);'),
);

runner.run('成功登录不清零（真正的主人回来也被自己锁住）', AUTH, (src) =>
  src.replace('    succeed(key) {\n      hits.delete(String(key));\n    },', '    succeed(key) {\n      void key;\n    },'),
);

runner.run('http 下也给 Cookie 加 Secure（本机 http 根本发不出去，登录看起来成功但立刻失效）', AUTH, (src) =>
  src.replace('  if (secure) parts.push(\'Secure\');', "  parts.push('Secure');"),
);

runner.run('退出登录不把 Cookie 清掉', AUTH, (src) =>
  src.replace(
    '  return `${TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;',
    '  return `${TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax`;',
  ),
);

runner.run('Cookie 名字按「包含」匹配（x_session 也会被当成这张票）', AUTH, (src) =>
  src.replace(
    '    if (part.slice(0, eq).trim() !== name) continue;',
    '    if (!part.slice(0, eq).trim().includes(name)) continue;',
  ),
);

// ---------------------------------------------------------------- 浏览器那一侧

runner.run('注册时不管两次密码一不一样（打错了也提交，然后登不进来）', CLIENT, (src) =>
  src.replace("    if (password !== confirm) return '两次输入的密码不一样';\n", ''),
);

runner.run('生成回答的时候也推快照（每几秒把整本笔记本传一遍）', CLIENT, (src) =>
  src.replace('  if (busy) return false;\n', ''),
);

runner.run('快照没存上也显示成存好了', CLIENT, (src) =>
  src.replace("  if (failed) return '快照没存上（服务端没接住），下次改动会再试';\n", ''),
);

// ---------------------------------------------------------------- 换名字

runner.run('换名字不查重（两个人的名字可以一样）', AUTH, (src) =>
  src.replace(
    "      if (users.some((u) => u.id !== id && u.nameKey === nextKey)) {\n        return { ok: false, code: 'name_taken', error: '这个名字已经有人用了' };\n      }\n",
    '',
  ),
);

runner.run('换名字查重时不排除自己（换回自己现在的名字会被自己拦住）', AUTH, (src) =>
  src.replace('users.some((u) => u.id !== id && u.nameKey === nextKey)', 'users.some((u) => u.nameKey === nextKey)'),
);

runner.run('换名字不更新判重键（旧名字还占着、新名字谁都能抢）', AUTH, (src) =>
  src.replace('      user.name = checked.name;\n      user.nameKey = nextKey;\n', '      user.name = checked.name;\n'),
);

runner.run('换名字不校验名字规则（空格、符号、超长全放进来）', AUTH, (src) =>
  src.replace(
    "      if (!checked.ok) return { ok: false, code: 'bad_name', error: checked.error };\n\n      const nextKey",
    '\n      const nextKey',
  ),
);

runner.run('换名字那一档不校验（空名字、非法字符都提交出去）', CLIENT, (src) =>
  src.replace(
    "  if (mode === 'name') {\n    // 改名字只查名字：它是个显示用的名字，改它不要密码\n    const checked = validateName(name);\n    return checked.ok ? '' : checked.error;\n  }",
    "  if (mode === 'name') return '';",
  ),
);

// ---------------------------------------------------------------- 最近登录过的账号

runner.run('登录成功之后不记名字（下次登录列表还是空的）', CLIENT, (src) =>
  src.replace(
    '  const key = nameKey(clean);\n  return [{ name: clean, at }, ...rows.filter((item) => nameKey(item.name) !== key)].slice(0, max);',
    '  const key = nameKey(clean);\n  void key;\n  return rows.slice(0, max);',
  ),
);

runner.run('不去重（同一个账号在列表里出现两条）', CLIENT, (src) =>
  src.replace(
    '  return [{ name: clean, at }, ...rows.filter((item) => nameKey(item.name) !== key)].slice(0, max);',
    '  return [{ name: clean, at }, ...rows].slice(0, max);',
  ),
);

runner.run('判重看大小写（ALICE 和 alice 变成两个账号）', CLIENT, (src) =>
  src.replace(
    '  return [{ name: clean, at }, ...rows.filter((item) => nameKey(item.name) !== key)].slice(0, max);',
    '  return [{ name: clean, at }, ...rows.filter((item) => item.name !== clean)].slice(0, max);',
  ),
);

runner.run('不封顶（列表可以无限长）', CLIENT, (src) =>
  src.replace(
    '  return [{ name: clean, at }, ...rows.filter((item) => nameKey(item.name) !== key)].slice(0, max);',
    '  return [{ name: clean, at }, ...rows.filter((item) => nameKey(item.name) !== key)];',
  ),
);

runner.run('读的时候不封顶（一份超长的旧数据把列表撑爆）', CLIENT, (src) =>
  src.replace(
    '      .map((item) => ({ name: item.name.trim().slice(0, 40), at: Number(item.at) || 0 }))\n      .slice(0, RECENT_ACCOUNTS_MAX);',
    '      .map((item) => ({ name: item.name.trim().slice(0, 40), at: Number(item.at) || 0 }));',
  ),
);

runner.run('匹配用「包含」而不是前缀（打中间的字也冒出来）', CLIENT, (src) =>
  src.replace(
    '  const matched = needle ? rows.filter((item) => nameKey(item.name).startsWith(needle)) : rows;',
    '  const matched = needle ? rows.filter((item) => nameKey(item.name).includes(needle)) : rows;',
  ),
);

runner.run('匹配时不分大小写（打 AL 找不到 alice）', CLIENT, (src) =>
  src.replace(
    '  const matched = needle ? rows.filter((item) => nameKey(item.name).startsWith(needle)) : rows;',
    "  const matched = needle ? rows.filter((item) => item.name.startsWith(needle)) : rows;",
  ),
);

runner.run('空输入时什么都不列（点一下名字格看到一片空白）', CLIENT, (src) =>
  src.replace(
    '  const matched = needle ? rows.filter((item) => nameKey(item.name).startsWith(needle)) : rows;',
    '  const matched = needle ? rows.filter((item) => nameKey(item.name).startsWith(needle)) : [];',
  ),
);

runner.run('换名字之后名单里还是旧名字（下次点它登不上去）', CLIENT, (src) =>
  src.replace(
    '  const rest = rows.filter((item) => nameKey(item.name) !== oldKey);',
    '  const rest = rows.slice();',
  ),
);

runner.finish();
