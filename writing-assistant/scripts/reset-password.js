/*!
 * 三易 · 智能写作台 —— 忘记密码时的本机兜底（scripts/reset-password.js）
 *
 * 用法：
 *   node scripts/reset-password.js <名字> <新密码>
 *   node scripts/reset-password.js <名字> --random     # 生成一个随机密码并打印出来
 *   node scripts/reset-password.js --list              # 看看这台机器上有哪些账号
 *
 * 为什么需要它：界面上「找回密码」要靠**恢复码**；恢复码丢了就没有第二条自助的路了。
 * 而这个工具的账号只在本机，所以「能在这台机器上读写 data/」本身就是最强的凭证 ——
 * 这条命令就是那个凭证的兑现方式：不需要恢复码，不需要登录。
 *
 * 它只做三件事：换掉密码、作废别处的登录（tokenVersion + 1）、发一把新的恢复码。
 * **不动留档**：稿子是按主人记着的，跟密码没关系。
 *
 * 用哪个账号文件跟服务端一致：WA_USERS_FILE，或 WA_DATA_DIR 下的 users.json。
 */
'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const Auth = require(path.join(ROOT, 'lib', 'auth.js'));
const Rules = require(path.join(ROOT, 'lib', 'auth-rules.js'));

const DATA_DIR = process.env.WA_DATA_DIR || path.join(ROOT, 'data');
const USERS_FILE = process.env.WA_USERS_FILE || path.join(DATA_DIR, 'users.json');

function usage(lines) {
  console.log(lines.join('\n'));
  console.log('\n用法：');
  console.log('  node scripts/reset-password.js <名字> <新密码>');
  console.log('  node scripts/reset-password.js <名字> --random');
  console.log('  node scripts/reset-password.js --list');
  console.log('\n账号文件：' + USERS_FILE);
}

/** 生成一个又长又不难抄的随机密码（四组，去掉了容易看错的字符） */
function makeRandomPassword() {
  const alphabet = Rules.RECOVERY_ALPHABET;
  let out = '';
  while (out.length < 16) {
    for (const byte of crypto.randomBytes(16)) {
      if (out.length >= 16) break;
      if (byte >= 256 - (256 % alphabet.length)) continue;
      out += alphabet[byte % alphabet.length];
    }
  }
  return out.slice(0, 4) + '-' + out.slice(4, 8) + '-' + out.slice(8, 12) + '-' + out.slice(12, 16);
}

(async function main() {
  const args = process.argv.slice(2);

  const store = Auth.createUserStore({ file: USERS_FILE });
  let loaded = 0;
  try {
    loaded = await store.init();
  } catch (err) {
    console.error('账号文件读不了：' + err.message);
    console.error('为了不把已有账号当成空，这条命令不再往下走。修好文件再试。');
    process.exitCode = 1;
    return;
  }

  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    usage([`三易 · 忘记密码重置（当前 ${loaded} 个账号）`]);
    return;
  }

  if (args[0] === '--list') {
    const rows = store.names();
    if (!rows.length) {
      console.log('这台机器上还没有账号。');
      return;
    }
    console.log(`这台机器上有 ${rows.length} 个账号：\n`);
    rows.forEach((row) => {
      const when = String(row.lastLoginAt || row.createdAt || '').slice(0, 16).replace('T', ' ');
      console.log(`  ${row.name}${row.hasRecovery ? '' : '（没有恢复码，只能用这条命令重置）'}   最近：${when}`);
    });
    console.log('\n重置其中一个：node scripts/reset-password.js <名字> --random');
    return;
  }

  const name = String(args[0] || '').trim();
  const wantRandom = args[1] === '--random';
  const password = wantRandom ? makeRandomPassword() : String(args[1] || '');

  const checkedName = Rules.validateName(name);
  if (!checkedName.ok) {
    usage(['名字不合法：' + checkedName.error]);
    process.exitCode = 1;
    return;
  }
  if (!password) {
    usage(['少了新密码。想让它随机生成就加 --random。']);
    process.exitCode = 1;
    return;
  }

  const result = await store.forcePassword(name, password);
  if (!result.ok) {
    console.error(result.code === 'no_user' ? `没有「${name}」这个账号。` : '重置失败：' + result.error);
    process.exitCode = 1;
    return;
  }

  console.log(`已重置「${result.user.name}」的密码。`);
  if (wantRandom) console.log('  新密码：' + password + '   （现在就能用它登录）');
  console.log('  别处的登录已经全部作废（tokenVersion + 1）。');
  console.log('  新的恢复码：' + result.recoveryCode);
  console.log('  ↑ 抄下来收好：它只显示这一次，服务端只存它的哈希。');
  console.log('  留档一篇都没动：稿子是按账号记着的，跟密码无关。');
})().catch((err) => {
  console.error('出错了：' + (err && err.message));
  process.exitCode = 1;
});
