'use strict';

/**
 * 图片仓库测试：纯函数 + 仓库逻辑（用内存 backend，不需要浏览器）。
 * 运行：node test/images.test.js
 */

const assert = require('assert');
const images = require('../js/images.js');

let pass = 0;
const failures = [];
const tasks = [];

function eq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
    pass += 1;
  } catch {
    failures.push(`${label}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`);
  }
}

function ok(value, label) { eq(Boolean(value), true, label); }
function no(value, label) { eq(Boolean(value), false, label); }

function has(text, needle, label) {
  if (String(text).indexOf(needle) >= 0) pass += 1;
  else failures.push(`${label}\n    应包含 ${JSON.stringify(needle)}\n    实际 ${JSON.stringify(text)}`);
}

function group(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      tasks.push(out.catch((err) => {
        failures.push(`[${name}] 异步抛错：${err && err.stack ? err.stack : err}`);
      }));
    }
  } catch (err) {
    failures.push(`[${name}] 抛错：${err && err.stack ? err.stack : err}`);
  }
}

/** 假的 Blob：只要有 type/size/arrayBuffer 就够仓库逻辑用了 */
function fakeBlob(type, size, tag) {
  return {
    type: type,
    size: size,
    tag: tag,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(size)),
  };
}

let urlSeq = 0;
function fakeStore(options) {
  return images.createStore(Object.assign({
    backend: images.memoryBackend(),
    createObjectURL: () => 'blob:fake-' + (++urlSeq),
    revokeObjectURL: () => {},
  }, options || {}));
}

/* ------------------------------------------------------------ 文件名清洗 */

group('文件名的清洗与去重', () => {
  eq(images.sanitizeName('截图.png'), '截图.png', '普通名字不动');
  eq(images.sanitizeName('C:\\用户\\图片\\照片.jpg'), '照片.jpg', '去掉路径，只留文件名');
  eq(images.sanitizeName('a/b/c.png'), 'c.png', '正斜杠路径也一样');
  eq(images.sanitizeName('我的 图 片.png'), '我的 图 片.png', '中间的空格留着（可读）');
  eq(images.sanitizeName('  前后空格  .png'), '前后空格.png', '首尾空格与点去掉');
  eq(images.sanitizeName('a:b*c?d"e<f>g|h.png'), 'a-b-c-d-e-f-g-h.png', '文件系统不认的字符换成短横');
  eq(images.sanitizeName('无扩展名', 'image/webp'), '无扩展名.webp', '没有扩展名时按类型补');
  eq(images.sanitizeName('图.png', 'image/jpeg'), '图.jpg', '类型与扩展名打架时听类型的（按实际字节才对）');
  eq(images.sanitizeName('...'), '图片.png', '清洗成空就给个兜底名字');
  eq(images.sanitizeName('', 'image/gif'), '图片.gif', '空名字按类型兜底');
  ok(images.sanitizeName('长'.repeat(300) + '.png').length <= 120, '过长的名字被截断');

  eq(images.uniqueName('图.png', []), '图.png', '没重名就不动');
  eq(images.uniqueName('图.png', ['图.png']), '图-2.png', '重名加 -2');
  eq(images.uniqueName('图.png', ['图.png', '图-2.png']), '图-3.png', '再加就 -3');
  eq(images.uniqueName('a.b.png', ['a.b.png']), 'a.b-2.png', '名字里有多个点时只管最后那个扩展名');

  eq(images.extOf('image/png'), 'png', 'png 类型');
  eq(images.extOf('image/jpeg'), 'jpg', 'jpeg 归一成 jpg');
  eq(images.extOf('image/svg+xml'), 'svg', 'svg');
  eq(images.extOf('', 'x.PNG'), 'png', '按文件名兜底并转小写');

  const guessed = images.guessName('image/png', new Date('2026-03-05T09:07:05'));
  eq(guessed, '粘贴图片-20260305-090705.png', '剪贴板图片按时间命名');
});

/* -------------------------------------------------------------- 目录命名 */

group('目录名 = 文章标题', () => {
  eq(images.folderName('我的笔记'), '我的笔记', '直接用标题');
  eq(images.folderName('  '), '未命名笔记', '空标题用兜底名');
  eq(images.folderName('a/b:c*d?e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i', '干掉文件系统不认的字符');
  eq(images.folderName('学习笔记/第一章'), '学习笔记-第一章', '斜杠不能变成一层新目录');
  eq(images.folderName('标题.  '), '标题', '收尾的点和空格去掉（Windows 上会出问题）');
  ok(images.folderName('长'.repeat(200)).length <= 60, '标题过长时截断');

  const map = images.folderNames([
    { id: 'a', title: '笔记' },
    { id: 'b', title: '笔记' },
    { id: 'c', title: '笔记 (2)' },
    { id: 'd', title: '' },
  ]);
  eq(map.get('a'), '笔记', '第一篇用标题本身');
  eq(map.get('b'), '笔记 (2)', '同名往后排');
  eq(map.get('c'), '笔记 (2) (2)', '跟已有名字也不撞');
  eq(map.get('d'), '未命名笔记', '没标题的用兜底名');
  eq(images.folderNames([]).size, 0, '没有笔记时是空表');
});

/* ---------------------------------------------------------- Markdown 路径 */

group('Markdown 里的路径', () => {
  eq(images.srcFor('截图.png'), '截图.png', '普通名字');
  eq(images.srcFor('我的 截图.png'), '我的%20截图.png', '空格转义（不然链接语法被截断）');
  eq(images.markdownFor('截图.png', '首页'), '![首页](截图.png)', '生成图片语法');
  eq(images.markdownFor('我的 截图.png'), '![](我的%20截图.png)', '没有 alt 也能生成');
  eq(images.markdownFor('a.png', '[方括号]'), '![方括号](a.png)', 'alt 里的方括号被去掉，但 alt 还在');

  eq(images.nameFromSrc('截图.png'), '截图.png', '还原');
  eq(images.nameFromSrc('我的%20截图.png'), '我的 截图.png', '还原转义');
  eq(images.nameFromSrc('./子目录/图.png'), '图.png', '带目录前缀时按文件名匹配');
  eq(images.nameFromSrc('笔记/图.png'), '图.png', '带目录名也一样');

  eq(images.formatBytes(512), '512 B', '字节');
  eq(images.formatBytes(2048), '2.0 KB', 'KB');
  eq(images.formatBytes(3 * 1024 * 1024), '3.00 MB', 'MB');
});

/* ---------------------------------------------------------------- 仓库 */

group('仓库：添加、列出、解析', async () => {
  const store = fakeStore();
  const rec = await store.add('note-1', fakeBlob('image/png', 1234, 'A'), { name: '首页截图.png' });
  eq(rec.name, '首页截图.png', '名字按给的名字走');
  eq(rec.size, 1234, '大小记下来');
  eq(rec.type, 'image/png', '类型记下来');
  ok(rec.url, '拿到可用的对象地址');
  eq(rec.key, 'note-1/首页截图.png', '键是 笔记/名字');

  const second = await store.add('note-1', fakeBlob('image/png', 10, 'B'), { name: '首页截图.png' });
  eq(second.name, '首页截图-2.png', '同一篇里重名自动加序号');

  const list = await store.list('note-1');
  eq(list.length, 2, '列出两张');
  eq(list.map((r) => r.name), ['首页截图.png', '首页截图-2.png'], '按加入顺序');

  eq(await store.list('note-2'), [], '别的笔记互不干扰');
  ok(store.resolve('note-1', '首页截图.png'), '解析出地址');
  eq(store.resolve('note-1', '不存在.png'), null, '找不到就返回 null');
  eq(store.resolve('note-2', '首页截图.png'), null, '别的笔记里没有这张图');
  ok(store.resolve('note-1', '首页截图-2.png'), '第二张也能解析');

  const detached = await store.add('note-3', fakeBlob('image/png', 5, 'C'), { name: '别的图.png' });
  ok(detached.url, '另一篇的图有自己的地址');
  eq(store.resolve('note-3', '别的图.png'), detached.url, '各解析各的');
});

group('仓库：光标解析的宽松匹配', async () => {
  const store = fakeStore();
  await store.add('n1', fakeBlob('image/png', 1), { name: 'Diagram.PNG' });
  ok(store.resolve('n1', 'Diagram.PNG'), '完全一致');
  ok(store.resolve('n1', 'diagram.png'), '大小写不敏感');
  ok(store.resolve('n1', './Diagram.PNG'), '带 ./ 前缀也认');
  ok(store.resolve('n1', 'n1/Diagram.PNG'), '带目录前缀也认');
  eq(store.resolve('n1', '别的.png'), null, '确实没有的还是 null');
});

group('仓库：引用计数与删除', async () => {
  const store = fakeStore();
  await store.add('n1', fakeBlob('image/png', 1), { name: 'a.png' });

  const body = '![一](a.png)\n\n文字\n\n![二](a.png)\n![三](别的.png)';
  eq(store.references(body, 'a.png'), 2, '数得清引用了两次');
  eq(store.references(body, '别的.png'), 1, '另算一张');
  eq(store.references(body, '没有.png'), 0, '没引用就是 0');

  await store.remove('n1', 'a.png');
  eq((await store.list('n1')).length, 0, '删掉了');
  eq(store.resolve('n1', 'a.png'), null, '删掉后解析不到');
});

group('仓库：用量与孤儿清理', async () => {
  const store = fakeStore();
  await store.add('keep', fakeBlob('image/png', 1000), { name: 'a.png' });
  await store.add('keep', fakeBlob('image/png', 2000), { name: 'b.png' });
  await store.add('gone', fakeBlob('image/png', 500), { name: 'c.png' });

  const use = await store.usage();
  eq(use.count, 3, '三张图');
  eq(use.bytes, 3500, '总计字节数');
  eq(use.persisted, false, '内存 backend 如实报告不会落盘');

  const cleaned = await store.cleanup(['keep']);
  eq(cleaned.removed, 1, '清掉一篇已删除笔记的图片');
  eq(cleaned.bytes, 500, '清掉的字节数');
  eq((await store.usage()).count, 2, '剩下两张');
  eq((await store.list('keep')).length, 2, '留下那篇没被动');

  const again = await store.cleanup(new Set(['keep']));
  eq(again.removed, 0, '再清一次没有可清的（幂等）');
});

group('仓库：没有 IndexedDB 时的退路', async () => {
  const store = images.createStore({ indexedDB: null, createObjectURL: () => 'blob:x' });
  await store.ready();
  eq(store.available, false, '如实报告"不会落盘"');
  ok(store.reason, '给出原因');
  const rec = await store.add('n1', fakeBlob('image/png', 7), { name: 'x.png' });
  eq(rec.name, 'x.png', '内存里照样能用');
  eq((await store.list('n1')).length, 1, '本次会话内可用');
});

group('仓库：打不开数据库时退回内存', async () => {
  const broken = {
    open() {
      const req = {};
      setTimeout(() => {
        req.error = new Error('权限被拒');
        if (req.onerror) req.onerror();
      }, 0);
      return req;
    },
  };
  const store = images.createStore({ indexedDB: broken, createObjectURL: () => 'blob:y' });
  await store.ready();
  eq(store.available, false, '打不开就退回内存');
  has(store.reason, '权限', '把底层原因带出来');
  await store.add('n1', fakeBlob('image/png', 3), { name: 'y.png' });
  eq((await store.list('n1')).length, 1, '退路可用');
});

group('导出时把图片路径补成 目录/文件名', () => {
  // 注意：判据收的是**文件名**（正文里带目录的话会先取文件名再判）
  const has = (name) => ['图.png', '我的 图.png', '深层.png'].indexOf(name) >= 0;

  eq(images.rewritePaths('![说明](图.png)', '我的笔记', has),
    '![说明](我的笔记/图.png)', '补上目录前缀');
  eq(images.rewritePaths('没图的正文', '我的笔记', has), '没图的正文', '没有图片就原样');
  eq(images.rewritePaths('![x](图.png)', '', has), '![x](图.png)', '没有目录名就不动');
  eq(images.rewritePaths('![x](https://a.dev/x.png)', 'N', has),
    '![x](https://a.dev/x.png)', '外链不动');
  eq(images.rewritePaths('![x](data:image/png;base64,AA)', 'N', has),
    '![x](data:image/png;base64,AA)', 'data URL 不动');
  eq(images.rewritePaths('![x](别人的图.png)', 'N', has),
    '![x](别人的图.png)', '不属于这篇笔记的图不动');
  eq(images.rewritePaths('![x](我的%20图.png)', 'N', has),
    '![x](N/我的%20图.png)', '名字里有空格（源码里是 %20）照样补前缀');
  eq(images.rewritePaths('![x](旧目录/图.png)', 'N', has),
    '![x](N/图.png)', '已经带目录的会归一化，不会叠成两层');
  eq(images.rewritePaths('![x](子目录/深层.png)', 'N', has),
    '![x](N/深层.png)', '带子目录的按文件名归到这一篇的目录下');
  eq(images.rewritePaths('![a](图.png) 和 ![b](图.png)', 'N', has),
    '![a](N/图.png) 和 ![b](N/图.png)', '同一张图引用多次都改');
  eq(images.rewritePaths('![x](图.png "标题")', 'N', has),
    '![x](N/图.png "标题")', '带标题的写法也认');
  eq(images.rewritePaths('![x](我的 图.png)', 'N', has), '![x](我的 图.png)', '源码里直接写空格（本来就是坏语法）不硬改');
});

/* ------------------------------------------------------------------ 汇总 */

(async () => {
  await Promise.all(tasks);
  const total = pass + failures.length;
  if (failures.length) {
    console.error(`\n✗ 图片层：${pass}/${total} 通过，${failures.length} 个失败\n`);
    failures.forEach((f, idx) => console.error(`  ${idx + 1}) ${f}\n`));
    process.exit(1);
  }
  console.log(`✓ 图片层：${pass}/${total} 全部通过`);
})();
