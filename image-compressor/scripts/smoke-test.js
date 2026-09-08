/**
 * smoke-test.js —— 端到端冒烟测试
 * 自动拉起 server（随机端口）、生成多种真实图片、调用全部接口并断言结果。
 *
 * 运行：node scripts/smoke-test.js   （或 npm run smoke）
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const PORT = 3321;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHealth(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  return false;
}

// ---------- 生成测试图片 ----------
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 平滑渐变 + 径向色块，生成易压缩的“照片风”RGB */
function makePhoto(w, h) {
  const rnd = mulberry32(7);
  const buf = Buffer.alloc(w * h * 3);
  const blobs = [];
  for (let i = 0; i < 9; i++) {
    blobs.push({ x: rnd() * w, y: rnd() * h, r: (40 + rnd() * 160) * (w / 1600), c: [rnd() * 255 | 0, rnd() * 255 | 0, rnd() * 255 | 0] });
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = x / w, ny = y / h;
      let r = 210 + 30 * ny, g = 170 + 60 * nx, b = 130 + 90 * (1 - ny); // 暖→冷渐变
      for (const bl of blobs) {
        const d = Math.hypot(x - bl.x, y - bl.y) / bl.r;
        if (d < 3) {
          const k = Math.max(0, 1 - d / 3) * 0.55;
          r = r * (1 - k) + bl.c[0] * k;
          g = g * (1 - k) + bl.c[1] * k;
          b = b * (1 - k) + bl.c[2] * k;
        }
      }
      const i = (y * w + x) * 3;
      buf[i] = Math.min(255, Math.max(0, r | 0));
      buf[i + 1] = Math.min(255, Math.max(0, g | 0));
      buf[i + 2] = Math.min(255, Math.max(0, b | 0));
    }
  }
  return buf;
}

/** UI 截图风 PNG：扁平色块 + 透明度 */
function makeUiPng(w, h) {
  const rnd = mulberry32(11);
  const buf = Buffer.alloc(w * h * 4);
  const bars = [];
  for (let i = 0; i < 26; i++) bars.push({ y: rnd() * h, h: 6 + rnd() * 30, c: [rnd() * 255 | 0, rnd() * 255 | 0, rnd() * 255 | 0], a: 120 + rnd() * 130 | 0 });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      buf[i] = 245; buf[i + 1] = 248; buf[i + 2] = 246; buf[i + 3] = 255;
      for (const b of bars) {
        if (Math.abs(y - b.y) < b.h / 2) {
          buf[i] = b.c[0]; buf[i + 1] = b.c[1]; buf[i + 2] = b.c[2]; buf[i + 3] = b.a;
        }
      }
      // 右侧竖栏：让图片更有“界面感”
      if (x > w * 0.78) { buf[i] = 40; buf[i + 1] = 130; buf[i + 2] = 90; buf[i + 3] = 235; }
    }
  }
  return buf;
}

async function genImages() {
  const W = 1600, H = 1100;
  const jpeg = await sharp(makePhoto(W, H), { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: 95, mozjpeg: true }).toBuffer();
  const webp = await sharp(makePhoto(W, H), { raw: { width: W, height: H, channels: 3 } })
    .webp({ quality: 90 }).toBuffer();
  const png = await sharp(makeUiPng(1200, 800), { raw: { width: 1200, height: 800, channels: 4 } })
    .png({ compressionLevel: 6 }).toBuffer();
  const txt = Buffer.from('this is definitely not an image file');
  console.log(`  生成测试图片: jpeg=${jpeg.length}B webp=${webp.length}B png=${png.length}B`);
  return [
    { name: 'photo-test.jpg', buf: jpeg, type: 'image/jpeg' },
    { name: 'screenshot-ui.png', buf: png, type: 'image/png' },
    { name: 'landscape.webp', buf: webp, type: 'image/webp' },
    { name: 'fake.jpg', buf: txt, type: 'image/jpeg' }, // 坏文件：应返回逐文件错误
  ];
}

// ---------- 主流程 ----------
async function main() {
  console.log('▶ 启动服务 (node server.js) ...');
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT: String(PORT) },
  });
  try {
    if (!(await waitHealth())) throw new Error('服务在 20s 内未就绪');
    console.log('  服务已就绪\n');

    const files = await genImages();
    const fd = new FormData();
    fd.append('quality', '70');
    for (const f of files) fd.append('files', new Blob([f.buf], { type: f.type }), f.name);

    console.log('▶ POST /api/compress (quality=70)');
    const up = await fetch(`${BASE}/api/compress`, { method: 'POST', body: fd });
    const upJson = await up.json();
    check('HTTP 200', up.status === 200);
    check('ok=true 且返回 token', upJson.ok === true && /^[a-f0-9]{16}$/.test(upJson.token));
    check('返回 4 条逐文件结果', Array.isArray(upJson.results) && upJson.results.length === 4);
    const token = upJson.token;

    const byName = Object.fromEntries(upJson.results.map((r) => [r.originalName, r]));
    check('顺序与上传一致', upJson.results[0].originalName === 'photo-test.jpg' && upJson.results[3].originalName === 'fake.jpg');

    const jpg = byName['photo-test.jpg'];
    const webpR = byName['landscape.webp'];
    const pngR = byName['screenshot-ui.png'];
    const fake = byName['fake.jpg'];

    check('JPEG 压缩生效(变小)', jpg.compressedSize > 0 && jpg.compressedSize < jpg.originalSize,
      `(${jpg.originalSize}B -> ${jpg.compressedSize}B)`);
    check('WebP 压缩生效(变小)', webpR.compressedSize > 0 && webpR.compressedSize < webpR.originalSize,
      `(${webpR.originalSize}B -> ${webpR.compressedSize}B)`);
    check('PNG 处理成功且保留尺寸', pngR.width === 1200 && pngR.height === 800 && pngR.compressedSize > 0);
    check('坏文件返回逐文件错误', !!fake.error, `(${fake.error || '无错误'})`);
    check('维度信息正确(1600x1100)', jpg.originalWidth === 1600 && jpg.originalHeight === 1100 && jpg.width === 1600);

    const sizesAt70 = { jpg: jpg.compressedSize, webp: webpR.compressedSize };

    console.log('\n▶ GET 压缩产物 URL');
    const dl = await fetch(`${BASE}${jpg.url}`);
    const dlBuf = Buffer.from(await dl.arrayBuffer());
    check('产物可下载且字节一致', dl.status === 200 && dlBuf.length === jpg.compressedSize,
      `(${dlBuf.length}B vs ${jpg.compressedSize}B)`);

    console.log('\n▶ POST /api/recompress (quality=25，无需重新上传)');
    const re = await fetch(`${BASE}/api/recompress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, quality: 25 }),
    });
    const reJson = await re.json();
    check('重新压缩成功', re.ok === true && re.status === 200);
    const jpg2 = reJson.results.find((r) => r.originalName === 'photo-test.jpg');
    check('更低质量 -> JPEG 更小', jpg2.compressedSize < sizesAt70.jpg,
      `(q70:${sizesAt70.jpg}B -> q25:${jpg2.compressedSize}B)`);
    const webp2 = reJson.results.find((r) => r.originalName === 'landscape.webp');
    check('更低质量 -> WebP 更小', webp2.compressedSize < sizesAt70.webp,
      `(q70:${sizesAt70.webp}B -> q25:${webp2.compressedSize}B)`);

    console.log('\n▶ 追加上传（同一会话，覆盖旧输出）');
    const fd2 = new FormData();
    fd2.append('token', token);
    fd2.append('quality', '70');
    const one = await sharp(makePhoto(900, 600), { raw: { width: 900, height: 600, channels: 3 } })
      .jpeg({ quality: 90 }).toBuffer();
    fd2.append('files', new Blob([one], { type: 'image/jpeg' }), 'extra-photo.jpg');
    const up2 = await fetch(`${BASE}/api/compress`, { method: 'POST', body: fd2 });
    const up2Json = await up2.json();
    check('追加成功且 token 复用', up2Json.ok === true && up2Json.token === token);
    check('本次只返回新增的 1 条', up2Json.results.length === 1);

    console.log('\n▶ 重压全部应包含 5 张');
    const re2 = await fetch(`${BASE}/api/recompress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, quality: 60 }),
    });
    const re2Json = await re2.json();
    check('返回 5 条结果', re2Json.results.length === 5);

    console.log('\n▶ GET /api/files/:token/zip');
    const zip = await fetch(`${BASE}/api/files/${token}/zip`);
    const zipBuf = Buffer.from(await zip.arrayBuffer());
    check('zip 200 + application/zip', zip.status === 200 && (zip.headers.get('content-type') || '').includes('zip'));
    check('zip 非空且为 PK 头', zipBuf.length > 100 && zipBuf[0] === 0x50 && zipBuf[1] === 0x4b,
      `(${zipBuf.length}B)`);

    console.log('\n▶ 边界：缺参数 / 过期会话');
    const badTok = await fetch(`${BASE}/api/recompress`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'deadbeefdeadbeef', quality: 50 }),
    });
    check('无效会话返回 404 JSON', badTok.status === 404);
    const noFile = await fetch(`${BASE}/api/compress`, { method: 'POST', body: new FormData() });
    check('空上传返回 400', noFile.status === 400);

    console.log(`\n======== 结果：通过 ${passed} 项，失败 ${failed} 项 ========`);
    process.exit(failed ? 1 : 0);
  } catch (e) {
    console.error('冒烟测试异常中止:', e.message);
    process.exit(1);
  } finally {
    server.kill();
  }
}

main();
