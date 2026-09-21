/**
 * API 层快速自检（开发用，不属于站点）
 * 用临时数据目录起一个服务器，把 /api/* 全跑一遍。
 *   node scripts/test-api.js
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-api-'));
process.env.DSH_PORTFOLIO_DATA = tmp;
// 打开反代信任，这样测试可以用 X-Forwarded-For 模拟"不同访客"，
// 否则本机全都是同一个 IP，连发两条就会被自己的限速拦住
process.env.TRUST_PROXY = '1';

const { createServer } = require(path.join(__dirname, '..', 'server.js'));

let pass = 0, fail = 0;
function ok(name, extra) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`); }
function bad(name, extra) { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
function check(c, name, extra) { c ? ok(name, extra) : bad(name, extra); }

let ipSeq = 1;
function nextIP() { return '10.0.0.' + (++ipSeq); }

function req(port, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign(
      { 'X-Forwarded-For': nextIP() },
      data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      headers || {}
    );
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, text: out });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** 用同一个 IP 连发，专门测限速 */
function reqSameIP(port, method, p, body, ip) {
  return req(port, method, p, body, { 'X-Forwarded-For': ip });
}

(async function main() {
  console.log('API 自检（临时数据目录）');
  const port = 5900 + Math.floor(Math.random() * 80);
  const server = createServer();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));

  try {
    /* --- 统计 --- */
    console.log('\n统计');
    let r = await req(port, 'GET', '/api/stats');
    check(r.status === 200 && r.json.ok, 'GET /api/stats 200');
    check(r.json.stats.total === 0, '初始 PV 为 0');

    r = await req(port, 'POST', '/api/visit', { visitorId: 'alice' });
    check(r.status === 200 && r.json.ok, 'POST /api/visit 200');
    check(r.json.stats.total === 1, 'PV 记到 1', 'total=' + r.json.stats.total);
    check(r.json.isNew === true, '新访客标记为 isNew');

    r = await req(port, 'POST', '/api/visit', { visitorId: 'alice' });
    check(r.json.stats.total === 2, '同一访客再来一次 PV=2');
    check(r.json.isNew === false, '同一访客不再算 UV');
    check(r.json.stats.uvSum === 1, 'UV 仍为 1', 'uv=' + r.json.stats.uvSum);

    await req(port, 'POST', '/api/visit', { visitorId: 'bob' });
    r = await req(port, 'GET', '/api/stats');
    check(r.json.stats.uvSum === 2, '第二个访客让 UV=2');
    check(r.json.stats.today === 3, '今日 PV=3', 'today=' + r.json.stats.today);
    check(r.json.stats.days.length === 14, '返回 14 天趋势', r.json.stats.days.length + ' 天');
    check(r.json.stats.days[13].pv === 3, '最后一天就是今天');

    /* --- 留言板 --- */
    console.log('\n留言板');
    r = await req(port, 'GET', '/api/guestbook?limit=8');
    check(r.json.total === 0 && r.json.hideUrl === true, '空留言板返回 hideUrl');

    r = await req(port, 'POST', '/api/guestbook', { name: '张三', text: '这个作品集做得挺用心的，加油。' });
    check(r.status === 201 && r.json.ok, 'POST 留言 201');
    const firstId = r.json.message && r.json.message.id;
    check(!!firstId, '返回了新留言 id');
    check(r.json.message.name === '张三', '名字存下来了');

    r = await req(port, 'POST', '/api/guestbook', { name: '', text: '匿名也能发，留个脚印。', lang: 'zh' });
    check(r.json.message.name === '匿名访客', '空名字自动叫"匿名访客"');
    r = await req(port, 'POST', '/api/guestbook', { text: 'Anonymous please', lang: 'en' });
    check(r.json.message.name === 'Anonymous', '英文环境叫 Anonymous');

    r = await req(port, 'GET', '/api/guestbook?limit=8');
    check(r.json.total === 3, '三条留言都存下来了', 'total=' + r.json.total);
    check(r.json.messages[0].text.indexOf('Anonymous') === 0, '最新的排在最前面');
    check(r.json.hideUrl === false, '有留言后 hideUrl=false');
    check(!('ipHash' in r.json.messages[0]), '对外不返回 ipHash（隐私）');

    r = await req(port, 'POST', '/api/guestbook', { text: '' });
    check(r.status === 400 && r.json.error === 'EMPTY', '空留言被拒');
    r = await req(port, 'POST', '/api/guestbook', { text: 'a' });
    check(r.status === 400 && r.json.error === 'TOO_SHORT', '太短被拒');
    r = await req(port, 'POST', '/api/guestbook', { text: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    check(r.status === 400 && r.json.error === 'LOW_QUALITY', '灌水重复字符被拒');
    r = await req(port, 'POST', '/api/guestbook', { text: '看这里 http://a.com http://b.com http://c.com' });
    check(r.status === 400 && r.json.error === 'LOW_QUALITY', '塞满链接被拒');
    r = await req(port, 'POST', '/api/guestbook', { text: 'x'.repeat(4000) });
    check(r.status === 413 || r.status === 400, '超长请求体被挡', 'status=' + r.status);

    // 蜜罐
    const before = (await req(port, 'GET', '/api/guestbook')).json.total;
    r = await req(port, 'POST', '/api/guestbook', { name: 'bot', text: '买号加微信 abcdefg', website: 'http://spam' });
    const after = (await req(port, 'GET', '/api/guestbook')).json.total;
    check(r.status === 200 && r.json.spam === true, '蜜罐被识别（返回成功但不入库）');
    check(after === before, '蜜罐留言没有写进存储');

    // 频率限制：同一个 IP 连发两条
    const spamIP = '10.9.9.9';
    r = await reqSameIP(port, 'POST', '/api/guestbook', { text: '第一条来自同一个地址的留言，长度够。' }, spamIP);
    check(r.status === 201, '同一 IP 第一条能发出去', 'status=' + r.status);
    const totalAfterFirst = (await req(port, 'GET', '/api/guestbook')).json.total;
    r = await reqSameIP(port, 'POST', '/api/guestbook', { text: '紧接着第二条同地址留言，应该被限速。' }, spamIP);
    check(r.status === 429 && r.json.error === 'RATE_WAIT', '同一 IP 连发被限速', 'status=' + r.status + ' err=' + (r.json && r.json.error));
    check(typeof r.json.wait === 'number' && r.json.wait > 0, '限速响应带等待秒数', 'wait=' + (r.json && r.json.wait));
    const totalAfterSecond = (await req(port, 'GET', '/api/guestbook')).json.total;
    check(totalAfterSecond === totalAfterFirst, '被限速的那条没有入库');

    // 分页
    r = await req(port, 'GET', '/api/guestbook?offset=0&limit=2');
    check(r.json.messages.length === 2 && r.json.hasMore === true, 'limit 生效且 hasMore=true');
    r = await req(port, 'GET', '/api/guestbook?offset=2&limit=2');
    check(!r.json.hasMore, '翻到最后一页 hasMore=false', '本页 ' + r.json.messages.length + ' 条');

    /* --- 删除（管理员） --- */
    console.log('\n管理员删除');
    const beforeDelete = (await req(port, 'GET', '/api/guestbook')).json.total;
    r = await req(port, 'DELETE', '/api/guestbook?id=' + firstId);
    check(r.status === 401, '没有令牌删不掉', 'status=' + r.status);
    r = await req(port, 'DELETE', '/api/guestbook?id=' + firstId, null, { Authorization: 'Bearer wrong-token' });
    check(r.status === 401, '错误令牌也删不掉', 'status=' + r.status);

    const token = fs.readFileSync(path.join(tmp, 'admin-token'), 'utf8').trim();
    r = await req(port, 'DELETE', '/api/guestbook?id=' + firstId, null, { Authorization: 'Bearer ' + token });
    check(r.status === 200 && r.json.ok, '带正确令牌删除成功');
    r = await req(port, 'DELETE', '/api/guestbook?id=' + firstId, null, { Authorization: 'Bearer ' + token });
    check(r.status === 404, '删第二次报 NOT_FOUND', 'status=' + r.status);
    r = await req(port, 'GET', '/api/guestbook');
    const afterDelete = r.json.total;
    check(afterDelete === beforeDelete - 1, '删掉之后就少一条', beforeDelete + ' → ' + afterDelete);

    /* --- 持久化 --- */
    console.log('\n持久化');
    const store = JSON.parse(fs.readFileSync(path.join(tmp, 'store.json'), 'utf8'));
    check(store.visits.total === 3, 'store.json 里的 PV 正确', 'total=' + store.visits.total);
    check(store.messages.length === afterDelete, 'store.json 里的留言条数对得上',
      store.messages.length + ' 条 = 接口返回的 ' + afterDelete);
    check(!store.messages.some((m) => m.text.indexOf('买号') >= 0), '蜜罐留言没进存储');
    check(store.messages.every((m) => typeof m.ipHash === 'string'), '存储里保留了 ipHash（只用于限速）');
    check(fs.existsSync(path.join(tmp, 'store.jsonl')), '追加日志也在');
    const logLines = fs.readFileSync(path.join(tmp, 'store.jsonl'), 'utf8').trim().split('\n').length;
    check(logLines >= 5, '日志里有访问与留言记录', logLines + ' 行');

    /* --- 隐私：data 目录怎么都读不到 --- */
    console.log('\n隐私');
    r = await req(port, 'GET', '/data/store.json');
    check(r.status === 403, '即便数据目录在仓库外，/data/store.json 也被挡住', 'status=' + r.status);
    r = await req(port, 'GET', '/data/admin-token');
    check(r.status === 403, '/data/admin-token 被挡住', 'status=' + r.status);
    r = await req(port, 'GET', '/data/../data/store.json');
    check(r.status === 403 || r.status === 400, '绕过尝试也无效', 'status=' + r.status);
    r = await req(port, 'GET', '/server.js');
    check(r.status === 200, 'server.js 本身是源码，可以下载（里面没有密钥）');
    check(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').indexOf('ADMIN_TOKEN =') > 0 &&
      !/ADMIN_TOKEN = '[0-9a-f]{32}'/.test(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')),
      'server.js 里没有硬编码令牌');

    /* --- 崩溃恢复：store.json 坏了也能从 jsonl 捞回来 --- */
    console.log('\n崩溃恢复');
    fs.writeFileSync(path.join(tmp, 'store.json'), '{"broken": tru');   // 故意写坏
    process.env.DSH_PORTFOLIO_DATA = tmp;
    delete require.cache[require.resolve(path.join(__dirname, '..', 'server.js'))];
    const reloaded = require(path.join(__dirname, '..', 'server.js'));
    const recovered = reloaded.getStore();
    check(recovered.messages.length === afterDelete, '从 jsonl 重建出留言',
      recovered.messages.length + ' / ' + afterDelete);
    check(recovered.visits.total === 3, '从 jsonl 重建出 PV', 'total=' + recovered.visits.total);
    check(recovered.messages.every((m) => m.id !== firstId), '重建时不会让删过的留言复活');
    const repaired = JSON.parse(fs.readFileSync(path.join(tmp, 'store.json'), 'utf8'));
    check(repaired.messages && repaired.messages.length === afterDelete,
      '启动时就把修复后的状态写回了 store.json（不再反复重放日志）',
      repaired.messages ? repaired.messages.length + ' 条' : '还是坏文件');
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n' + '─'.repeat(50));
  if (fail === 0) console.log(`全部通过  ${pass} 项`);
  else { console.log(`${fail} 项失败 / 共 ${pass + fail} 项`); process.exitCode = 1; }
})().catch((e) => { console.error('自检自身出错:', e); process.exitCode = 1; });
