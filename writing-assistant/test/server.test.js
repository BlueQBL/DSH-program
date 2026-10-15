'use strict';

/**
 * 服务端接口的测试：静态托管、生成流（SSE）、一键优化、历史留档。
 * 用随机端口起一个真实服务，按真实 HTTP 请求打进去，不 mock。
 * 运行：node test/server.test.js
 */

const assert = require('assert');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// 必须在 require 服务端之前设置：这些值在模块加载时读取
const DATA_DIR = path.join(os.tmpdir(), 'wa-server-test-' + process.pid + '-' + Date.now());
process.env.WA_DATA_DIR = DATA_DIR;
process.env.AI_FORCE_OFFLINE = '1';   // 保证测试永远走离线引擎，不受本机 Key 影响
process.env.WA_OFFLINE_SPEED = '0';   // 不要逐字延迟
process.env.WA_OFFLINE_CHUNK = '200';

const Polisher = require('../lib/polisher.js');
const { start } = require('../server.js');

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
    failures.push(`${name} 抛异常：${err.message}`);
  }
  console.log(`  ${failures.length === before ? '✓' : '✗'} ${name}`);
}

/** 解析一帧 SSE */
function parseFrame(frame) {
  let event = 'message';
  const data = [];
  frame.split(/\r?\n/).forEach((line) => {
    if (line.startsWith(':')) return;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  });
  let payload = null;
  try {
    payload = data.length ? JSON.parse(data.join('\n')) : null;
  } catch {
    payload = null;
  }
  return { event, payload };
}

(async function main() {
  const app = await start({ port: 0, banner: false });
  const base = app.url.replace(/\/$/, '');
  console.log(`三易服务端接口（${base}）`);

  async function post(url, body) {
    const res = await fetch(base + url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 不是 JSON 就留着原文 */
    }
    return { status: res.status, json, text };
  }

  async function collect(url, body) {
    const res = await fetch(base + url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status !== 200) {
      const json = await res.json().catch(() => null);
      return { status: res.status, json, events: [] };
    }
    const text = await res.text();
    const events = [];
    text.split('\n\n').forEach((frame) => {
      if (!frame.trim()) return;
      const parsed = parseFrame(frame);
      if (parsed.event !== 'message') events.push(parsed);
    });
    return { status: 200, events };
  }

  const MESSY = '今天我们进行了一次讨论,大家都觉得这个方案非常非常的重要，需要尽快的落实下去，我们必须要加以重视!!!';

  await group('健康检查：说明当前成稿方式与模式清单', async () => {
    const res = await fetch(base + '/api/health');
    eq(res.status, 200, '状态码');
    const data = await res.json();
    eq(data.ok, true, 'ok');
    eq(data.app, 'writing-assistant', '应用标识');
    eq(data.engine.live, false, '测试环境强制离线');
    eq(data.engine.model, '离线引擎', '离线时模型名');
    eq(data.modes.length, 10, '十个板块');
    eq(data.modes[0].mark, '续', '模式的稿签单字');
    ok(typeof data.history.count === 'number', '带留档篇数');
  });

  await group('引擎自检：离线时如实说明', async () => {
    const data = await (await fetch(base + '/api/engine/test')).json();
    eq(data.ok, true, 'ok');
    eq(data.engine, 'offline', '离线');
    ok(data.message.includes('离线') || data.message.includes('Key'), '给出了可读的说明');
  });

  await group('模型列表：离线时只有一个「离线引擎」，不假装有模型可选', async () => {
    const data = await (await fetch(base + '/api/models')).json();
    eq(data.ok, true, '接口本身是通的');
    eq(data.live, false, '标记为离线');
    eq(data.models, [], '没有可选模型');
    eq(data.current, '离线引擎', '当前就是离线引擎');
    ok(data.note.includes('Key') || data.note.includes('离线'), '说明了为什么');
  });

  await group('离线时带上 model 字段也不会出错，成稿照旧', async () => {
    const out = await collect('/api/generate', {
      params: { mode: 'summary', length: 'short', versions: 1 },
      material: { input: '会议决定：周五前出方案，下周一过方案。' },
      model: 'gpt-4o',   // 离线模式下这个字段会被忽略
    });
    eq(out.status, 200, '状态码 200');
    const meta = out.events.find((e) => e.event === 'meta');
    eq(meta.payload.engine, 'offline', '仍然是离线引擎');
    eq(meta.payload.model, '离线引擎', '模型名如实回填');
    ok(meta.payload.modelNote.includes('离线'), '说明了模型选择不生效');
    const done = out.events.find((e) => e.event === 'done').payload;
    ok(done.versions[0].text.length > 20, '照样出了内容');
  });

  await group('静态托管：首页、样式、脚本都能取到', async () => {
    const html = await fetch(base + '/');
    eq(html.status, 200, '首页 200');
    eq(html.headers.get('content-type').includes('text/html'), true, '是 HTML');
    const body = await html.text();
    ok(body.includes('三易'), '页面里有应用名');
    ok(body.includes('lib/modes.js'), '引用了共享模式定义');

    const css = await fetch(base + '/css/styles.css');
    eq(css.status, 200, '样式 200');
    ok((await css.text()).includes('--zhu'), '样式里有朱砂色令牌');

    const lib = await fetch(base + '/lib/modes.js');
    eq(lib.status, 200, '共享逻辑可被浏览器加载');
    ok((await lib.text()).includes('WriterModes'), '挂到 window 上');
  });

  await group('静态托管：留档目录、服务端代码与越界路径取不到', async () => {
    const data = await fetch(base + '/data/history/x.json');
    eq(data.status, 403, 'data 目录被挡住');
    const tests = await fetch(base + '/test/server.test.js');
    eq(tests.status, 403, '测试目录被挡住');
    const escape = await fetch(base + '/..%2F..%2Fpackage.json');
    eq(escape.status, 403, '越界路径被挡住');
    // 服务端专用代码不给浏览器取：上游接入、留档落盘、服务本身
    for (const path of ['/server.js', '/lib/llm.js', '/lib/store.js', '/lib/template-store.js']) {
      eq((await fetch(base + path)).status, 403, `${path} 取不到`);
    }
    // 前后端共用的纯函数模块要取得到（页面靠它们跑）
    for (const path of ['/lib/modes.js', '/lib/record.js', '/lib/polisher.js', '/lib/mock-writer.js', '/lib/template.js']) {
      eq((await fetch(base + path)).status, 200, `${path} 取得到`);
    }
    const missing = await fetch(base + '/不存在的文件.txt');
    eq(missing.status, 404, '没有的文件 404');
  });

  await group('任何接口响应里都不会出现 API Key', async () => {
    // 测试环境没配 Key，这里断言的是「结构上不可能」：响应里不含鉴权字段与请求头
    const paths = ['/api/health', '/api/models', '/api/engine/test', '/api/history'];
    for (const path of paths) {
      const text = await (await fetch(base + path)).text();
      ok(!/Bearer\s+\S/.test(text), `${path} 里没有 Authorization 值`);
      ok(!/"apiKey"\s*:/.test(text), `${path} 里没有 apiKey 字段`);
      ok(!/process\.env/.test(text), `${path} 里没有读环境变量的服务端代码`);
    }
  });

  await group('起稿：SSE 先给计划，再逐字推，最后给结果', async () => {
    const out = await collect('/api/generate', {
      params: { mode: 'rewrite', creativity: 0.5, length: 'short', versions: 3, tone: 'formal' },
      material: { input: MESSY },
    });
    eq(out.status, 200, '状态码 200');
    const kinds = out.events.map((e) => e.event);
    eq(kinds[0], 'meta', '第一帧是计划');
    eq(kinds[kinds.length - 1], 'done', '最后一帧是结果');
    ok(kinds.includes('delta'), '中间有内容帧');

    const meta = out.events.find((e) => e.event === 'meta');
    eq(meta.payload.versions.length, 3, '三稿的计划');
    eq(meta.payload.engine, 'offline', '离线引擎');
    eq(new Set(meta.payload.versions.map((v) => v.angleLabel)).size, 3, '三个角度各不相同');

    const done = out.events.find((e) => e.event === 'done').payload;
    eq(done.versions.length, 3, '三稿都成了');
    eq(done.failed.length, 0, '没有失败');
    eq(done.engine, 'offline', '结果里标明成稿方式');
    ok(done.elapsedMs >= 0, '有用时');
    done.versions.forEach((v) => {
      ok(v.text.length > 20, `第 ${v.index + 1} 稿有内容`);
      eq(v.chars, v.text.length, `第 ${v.index + 1} 稿字数对得上`);
      ok(v.angleLabel, '带角度名');
      ok(v.text !== MESSY, `第 ${v.index + 1} 稿不是照抄原文`);
    });
    eq(new Set(done.versions.map((v) => v.text)).size, 3, '三稿内容互不相同');
  });

  await group('起稿：篇幅档位真的影响长度', async () => {
    const input = '远程团队开周会最容易变成念进度。每个人轮流说三分钟，说完谁也记不住。要改这件事，先把周会拆成两半。';
    const shortRun = await collect('/api/generate', {
      params: { mode: 'continue', length: 'short', versions: 1 },
      material: { input },
    });
    const longRun = await collect('/api/generate', {
      params: { mode: 'continue', length: 'long', versions: 1 },
      material: { input },
    });
    const shortText = shortRun.events.find((e) => e.event === 'done').payload.versions[0].text;
    const longText = longRun.events.find((e) => e.event === 'done').payload.versions[0].text;
    ok(shortText.length >= 80, `短篇至少写满一段（实际 ${shortText.length} 字）`);
    ok(longText.length > shortText.length, `长篇比短篇长（${longText.length} > ${shortText.length}）`);
  });

  await group('起稿：文案模式带平台排版，邮件模式带主题行', async () => {
    const copy = await collect('/api/generate', {
      params: { mode: 'copywriting', length: 'short', versions: 1, fields: { platform: 'xiaohongshu' } },
      material: { input: '一款给通勤族用的折叠电煮锅' },
    });
    const copyText = copy.events.find((e) => e.event === 'done').payload.versions[0].text;
    ok(copyText.includes('#'), '小红书文案带话题标签');

    const mail = await collect('/api/generate', {
      params: { mode: 'email', length: 'short', versions: 1 },
      material: { input: '通知客户验收顺延到下周三' },
    });
    const mailText = mail.events.find((e) => e.event === 'done').payload.versions[0].text;
    ok(mailText.startsWith('主题'), '邮件第一行是主题');
  });

  await group('起稿：把逐字推的内容拼起来，与最终结果一致', async () => {
    const out = await collect('/api/generate', {
      params: { mode: 'continue', length: 'short', versions: 2 },
      material: { input: '我搬进这间老房子的第一个晚上，听见楼上有弹珠落地的声音。' },
    });
    const done = out.events.find((e) => e.event === 'done').payload;
    const glued = {};
    out.events
      .filter((e) => e.event === 'delta')
      .forEach((e) => {
        glued[e.payload.version] = (glued[e.payload.version] || '') + e.payload.text;
      });
    done.versions.forEach((v) => {
      eq(glued[v.index], v.text, `第 ${v.index + 1} 稿流式内容与结果一致`);
    });
  });

  await group('起稿：参数会被服务端重新规整，越界值不生效', async () => {
    const out = await collect('/api/generate', {
      params: { mode: 'email', creativity: 99, versions: 99, length: '瞎写的' },
      material: { input: '通知客户验收顺延到下周三' },
    });
    const meta = out.events.find((e) => e.event === 'meta').payload;
    eq(meta.params.mode, 'email', '模式保留');
    eq(meta.params.creativity, 1.6, '创意度封顶');
    eq(meta.params.versions, 4, '版本数被夹到该板块的角度数上限');
    eq(meta.params.length, 'medium', '非法篇幅退回中篇');
    const done = out.events.find((e) => e.event === 'done').payload;
    eq(done.versions.length, 4, '按规整后的数量成稿');
  });

  await group('起稿：没素材直接拒绝', async () => {
    const out = await post('/api/generate', { params: { mode: 'continue' }, material: { input: '   ' } });
    eq(out.status, 400, '状态码 400');
    ok(out.json.message.includes('先写点什么'), '给了人话提示');
  });

  await group('起稿：请求体不是 JSON 时给出可读错误', async () => {
    const res = await fetch(base + '/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{这不是 JSON',
    });
    eq(res.status, 400, '状态码 400');
    const data = await res.json();
    ok(data.message.includes('JSON'), '说明是 JSON 的问题');
  });

  await group('一键优化：挑得出毛病，且改动能落回原文', async () => {
    const out = await post('/api/polish', { text: MESSY });
    eq(out.status, 200, '状态码 200');
    eq(out.json.ok, true, 'ok');
    eq(out.json.engine, 'offline', '离线校对');
    ok(out.json.edits.length > 0, `挑出了改动（实际 ${out.json.edits.length} 处）`);
    eq(out.json.stats.total, out.json.edits.length, '统计与条目数一致');
    eq(out.json.changed, true, '标记为有改动');
    ok(out.json.polished !== out.json.before, '润色稿与原文不同');

    const accepted = new Set(out.json.edits.map((e) => e.id));
    eq(Polisher.applyEdits(out.json.before, out.json.edits, accepted), out.json.polished, '全部采纳后等于润色稿');
    eq(Polisher.applyEdits(out.json.before, out.json.edits, []), MESSY, '一条都不采纳等于原文');
    out.json.edits.forEach((e) => {
      ok(e.id && e.type && Polisher.TYPES[e.type], '条目的类型合法');
      ok(e.start <= e.end, '坐标合法');
      eq(e.before !== e.after, true, '改前与改后不同');
      if (e.source === 'model') ok(e.reason.length > 0, '带说明的条目必有原因');
      eq(MESSY.slice(e.start, e.end), e.before, '坐标切出来的就是改前片段');
    });
    eq(out.json.edits.length, Polisher.stats(out.json.edits).total, '统计条目与列表一致');
  });

  await group('一键优化：干净的原文不会被硬改', async () => {
    const clean = '会议定在周四下午三点，地点在二楼会议室。请你确认能否到场。';
    const out = await post('/api/polish', { text: clean });
    eq(out.status, 200, '状态码 200');
    eq(out.json.polished, clean, '一个字都没动');
    eq(out.json.edits.length, 0, '没有朱批');
    eq(out.json.changed, false, '标记为没有改动');
  });

  await group('一键优化：空文本被拒绝', async () => {
    const out = await post('/api/polish', { text: '   ' });
    eq(out.status, 400, '状态码 400');
    ok(out.json.message.includes('没有可优化'), '给了人话提示');
  });

  let createdId = '';

  await group('留档：存一篇、取一篇', async () => {
    const out = await post('/api/history', {
      record: {
        mode: 'copywriting',
        params: { mode: 'copywriting', creativity: 1.1, length: 'short', tone: 'lively', fields: { platform: 'xiaohongshu', selling: '静音' } },
        material: { input: '一款静音咖啡机' },
        versions: [
          { index: 0, angleId: 'pain', angleLabel: '痛点开场', text: '早上七点，磨豆机吵醒了全家。' },
          { index: 1, angleId: 'scene', angleLabel: '场景故事', text: '她在厨房按下开关，只有水声。' },
        ],
        adoptedIndex: 1,
      },
    });
    eq(out.status, 201, '状态码 201');
    eq(out.json.ok, true, 'ok');
    createdId = out.json.record.id;
    ok(/^d_/.test(createdId), '生成了 id');
    ok(out.json.record.title.includes('文案生成'), '标题带模式名');
    eq(out.json.record.adoptedIndex, 1, '记住采用了第二稿');

    const one = await (await fetch(base + '/api/history/' + createdId)).json();
    eq(one.record.versions.length, 2, '取回两稿');
    eq(one.record.versions[1].text, '她在厨房按下开关，只有水声。', '正文完整');
  });

  await group('留档：列表、筛选、搜索', async () => {
    const list = await (await fetch(base + '/api/history')).json();
    eq(list.ok, true, 'ok');
    eq(list.total, 1, '共一篇');
    eq(list.items[0].mark, '文', '带稿签单字');
    eq(list.items[0].versions, 2, '带版本数');
    eq(list.items[0].text, undefined, '摘要里不带正文');
    ok(list.modes.length === 10, '带各板块计数');

    const byMode = await (await fetch(base + '/api/history?mode=copywriting')).json();
    eq(byMode.total, 1, '按模式筛得到');
    const none = await (await fetch(base + '/api/history?mode=email')).json();
    eq(none.total, 0, '别的模式筛不到');
    const byWord = await (await fetch(base + '/api/history?q=' + encodeURIComponent('咖啡机'))).json();
    eq(byWord.total, 1, '搜素材命中');
    const byText = await (await fetch(base + '/api/history?q=' + encodeURIComponent('水声'))).json();
    eq(byText.total, 1, '搜正文命中');
    const miss = await (await fetch(base + '/api/history?q=' + encodeURIComponent('绝不存在的词'))).json();
    eq(miss.total, 0, '搜不到就是零');
  });

  await group('留档：星标、改名、记下朱批', async () => {
    const res = await fetch(base + '/api/history/' + createdId, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        starred: true,
        title: '静音咖啡机 · 小红书',
        polished: { source: 'version:0', before: '吵醒了全家人', after: '吵醒了全家', edits: [{ id: 'e1' }], accepted: ['e1'] },
      }),
    });
    eq(res.status, 200, '状态码 200');
    const data = await res.json();
    eq(data.record.starred, true, '星标生效');
    eq(data.record.title, '静音咖啡机 · 小红书', '改名生效');
    eq(data.record.polished.after, '吵醒了全家', '朱批结果存下');

    const starred = await (await fetch(base + '/api/history?starred=1')).json();
    eq(starred.total, 1, '只看星标能筛到');
    ok(starred.items[0].hasPolish, '列表里能看出有朱批');

    const missing = await fetch(base + '/api/history/d_不存在', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    eq(missing.status, 404, '改不存在的返回 404');
  });

  await group('留档：导出三种格式', async () => {
    const md = await fetch(base + '/api/history/export?format=md');
    eq(md.status, 200, '状态码 200');
    ok(md.headers.get('content-type').includes('markdown'), 'MIME 是 markdown');
    ok(md.headers.get('content-disposition').includes('attachment'), '是下载');
    const mdText = await md.text();
    ok(mdText.includes('## 第一稿'), '有稿次');
    ok(mdText.includes('### 朱批'), '有朱批小节');
    ok(mdText.includes('小红书'), '附加字段没丢');

    const json = await (await fetch(base + '/api/history/export?format=json')).json();
    eq(json.app, 'writing-assistant', 'json 带应用标识');
    eq(json.count, 1, '导出篇数正确');

    const txt = await fetch(base + '/api/history/export?format=txt');
    ok((await txt.text()).includes('第一稿'), 'txt 里有稿次');
  });

  await group('留档：删除、以及清空必须显式确认', async () => {
    const del = await fetch(base + '/api/history/' + createdId, { method: 'DELETE' });
    eq(del.status, 200, '状态码 200');
    eq((await (await fetch(base + '/api/history/' + createdId)).json()).ok, false, '取不到了');
    eq((await fetch(base + '/api/history/' + createdId, { method: 'DELETE' })).status, 404, '重复删除 404');

    const noConfirm = await fetch(base + '/api/history', { method: 'DELETE' });
    eq(noConfirm.status, 400, '不给 confirm 时拒绝清空');
    ok((await noConfirm.json()).message.includes('confirm'), '说明了为什么拒绝');
  });

  await group('留档：清空之后列表为空', async () => {
    await post('/api/history', {
      record: { mode: 'outline', material: { input: '临时' }, versions: [{ index: 0, text: '内容' }] },
    });
    const cleared = await fetch(base + '/api/history?confirm=1', { method: 'DELETE' });
    eq(cleared.status, 200, '状态码 200');
    ok((await cleared.json()).removed >= 1, '报告清掉的篇数');
    const list = await (await fetch(base + '/api/history')).json();
    eq(list.total, 0, '清空后为空');
    const health = await (await fetch(base + '/api/health')).json();
    eq(health.history.count, 0, '健康检查里的篇数也归零');
  });

  await group('路由：不认识的接口与不支持的方法都有明确回话', async () => {
    const nope = await fetch(base + '/api/不存在');
    eq(nope.status, 404, '未知接口 404');
    ok((await nope.json()).message.includes('没有这个接口'), '说明了原因');

    const wrongMethod = await fetch(base + '/api/generate');
    eq(wrongMethod.status, 404, 'GET 起稿接口不认');
    const post2 = await fetch(base + '/', { method: 'POST' });
    eq(post2.status, 405, '静态资源不接受 POST');
  });

  await group('留档落盘：真的写进了 data/history', async () => {
    await post('/api/history', {
      record: { mode: 'summary', material: { input: '落盘检查' }, versions: [{ index: 0, text: '一段摘要。' }] },
    });
    const names = await fsp.readdir(path.join(DATA_DIR, 'history'));
    ok(names.some((n) => n.startsWith('d_') && n.endsWith('.json')), '有稿件文件');
    eq(names.filter((n) => n.endsWith('.tmp')).length, 0, '没有临时文件残留');
  });

  let templateId = '';

  await group('模板库：建、列、改、删（离线模式也能用，它只是存储）', async () => {
    const bad = await post('/api/templates', { template: { name: 'x', system: '短' } });
    eq(bad.status, 400, '校验不过时 400');
    eq(bad.json.field, 'name', '指明了是哪个字段的问题');

    const created = await post('/api/templates', {
      template: {
        name: '产品周报',
        mark: '周',
        system: '你是资深产品经理，替团队写周报，只输出正文，分进展、问题、下周计划三块。',
        outputHint: '每块不超过五条',
      },
    });
    eq(created.status, 201, '创建成功');
    templateId = created.json.template.id;
    ok(/^t_/.test(templateId), '生成了模板 id');

    const list = await (await fetch(base + '/api/templates')).json();
    eq(list.total, 1, '列表里有一个');
    eq(list.items[0].modeId, 'tpl_' + templateId, '带板块 id');
    ok(list.templates[0].system.includes('产品经理'), '完整记录也返回（浏览器注册板块要用）');

    const renamed = await fetch(base + '/api/templates/' + templateId, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template: { tagline: '每周同步' } }),
    });
    eq(renamed.status, 200, '改成功');
    eq((await renamed.json()).template.tagline, '每周同步', '改到了');
    eq((await fetch(base + '/api/templates/t_不存在', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404, '改不存在的 404');
  });

  await group('模板注册成板块：留档列表里能看到这个板块', async () => {
    const list = await (await fetch(base + '/api/history')).json();
    const custom = list.modes.filter((m) => m.id.indexOf('tpl_') === 0);
    eq(custom.length, 1, '多出来一个自定义板块');
    eq(custom[0].name, '产品周报', '板块名就是模板名');
    eq(custom[0].mark, '周', '稿签单字也对');
  });

  await group('带模板起稿：meta 里能看出用的是哪个模板', async () => {
    const out = await collect('/api/generate', {
      params: { mode: 'tpl_' + templateId, length: 'short', versions: 2 },
      material: { input: '这周上线了新版搜索，顺手修了三个线上问题' },
      template: {
        id: templateId,
        name: '产品周报',
        system: '你是资深产品经理，替团队写周报，只输出正文，分进展、问题、下周计划三块。',
        outputHint: '每块不超过五条',
      },
    });
    eq(out.status, 200, '起稿成功');
    const meta = out.events.find((e) => e.event === 'meta');
    eq(meta.payload.mode, 'tpl_' + templateId, '用的是自定义板块');
    eq(meta.payload.template.name, '产品周报', 'meta 里带了模板名');
    eq(meta.payload.versions.length, 2, '自定义板块也有多个角度');
    const done = out.events.find((e) => e.event === 'done').payload;
    ok(done.versions[0].text.length > 20, '离线引擎给出了内容（它自己会说明做不了自定义提示词）');
  });

  await group('删掉模板后板块也消失', async () => {
    const del = await fetch(base + '/api/templates/' + templateId, { method: 'DELETE' });
    eq(del.status, 200, '删除成功');
    eq((await fetch(base + '/api/templates/' + templateId, { method: 'DELETE' })).status, 404, '重复删除 404');
    const list = await (await fetch(base + '/api/history')).json();
    eq(list.modes.filter((m) => m.id.indexOf('tpl_') === 0).length, 0, '自定义板块没了');
    eq(list.modes.length, 10, '只剩十个内置板块');
  });

  await app.close();
  await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});

  const total = pass + failures.length;
  console.log(`\n通过 ${pass}/${total}`);
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exitCode = 1;
  }
})();
