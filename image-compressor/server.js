/**
 * server.js
 * 图片压缩工具 —— 后端服务
 *
 * 职责：
 *   1. 托管前端静态页面（public/）
 *   2. POST /api/compress      批量上传并压缩（multipart，files[] + quality）
 *   3. POST /api/recompress    对已上传的原始文件按新质量重新压缩（免重复上传）
 *   4. GET  /api/files/:token/outputs/:name   访问压缩结果
 *   5. GET  /api/files/:token/zip             将整批压缩结果打包下载（zip）
 *   6. GET  /api/health        健康检查
 *
 * 存储布局（data/ 目录，随服务启动自动清理过期会话）：
 *   data/<token>/originals/   上传的原始图片（multer 落盘，供重新压缩）
 *   data/<token>/outputs/     压缩产物
 *
 * 运行：npm start   ->   http://localhost:3210
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const archiver = require('archiver');
const { compressImage, clampQuality } = require('./lib/processor');

const PORT = Number(process.env.PORT) || 3210;
const DATA_DIR = path.join(__dirname, 'data');

// ---------------- 基础目录 ----------------
fs.mkdirSync(DATA_DIR, { recursive: true });

const TTL_MS = Number(process.env.CLEANUP_TTL_MIN) * 60 * 1000 || 60 * 60 * 1000; // 默认保留 1 小时

/** 每个上传会话一个目录：data/<token>/{originals,outputs} */
function sessionDirs(token) {
  return {
    root: path.join(DATA_DIR, token),
    originals: path.join(DATA_DIR, token, 'originals'),
    outputs: path.join(DATA_DIR, token, 'outputs'),
  };
}

function safeName(name, index) {
  const base = path.basename(String(name || '').replace(/[\\/]/g, '_')) || 'image';
  // 去除易引起歧义的字符，保留可读性；合并连续下划线、去掉首尾分隔符，避免出现“____”这类怪异前缀
  const cleaned = base
    .replace(/[^\w.\-\u4e00-\u9fa5 ()（）【】\[\]]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[\s_.\-]+|[\s_.\-]+$/g, '')
    .slice(0, 120);
  return `${index}-${cleaned || 'image'}`;
}

// ---------------- 上传配置 ----------------

/** 校验 token 是否为仍存在的有效会话 */
function isValidToken(t) {
  return typeof t === 'string' &&
    /^[a-f0-9]{16}$/.test(t) &&
    fs.existsSync(path.join(DATA_DIR, t, 'originals'));
}

/** 本次请求使用已有会话（追加压缩）或创建新会话（首次上传） */
function resolveToken(req) {
  const existing = req.body && req.body.token;
  return isValidToken(existing) ? existing : crypto.randomBytes(8).toString('hex');
}

/** 会话内下一条可用序号（前缀补零，保证追加后排序稳定） */
function nextFileIndex(token) {
  const dir = sessionDirs(token).originals;
  try {
    const names = fs.readdirSync(dir);
    let max = -1;
    for (const n of names) {
      const m = /^(\d+)-/.exec(n);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max + 1;
  } catch {
    return 0;
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      if (!req.token) {
        req.token = resolveToken(req);
        req.curIndex = nextFileIndex(req.token);
      }
      const dirs = sessionDirs(req.token).originals;
      fs.mkdirSync(dirs, { recursive: true });
      cb(null, dirs);
    },
    filename: (req, file, cb) => {
      const idx = String(req.curIndex).padStart(4, '0');
      req.curIndex += 1;
      cb(null, safeName(file.originalname, idx));
    },
  }),
  limits: {
    fileSize: 60 * 1024 * 1024, // 单文件最大 60MB
    files: 20,                  // 单批最多 20 张
  },
});

// ---------------- 服务 ----------------
const app = express();
app.use(express.json({ limit: '1mb' }));

// 兜底：multer 磁盘存储的 dest 需要 token；这里在存储回调里按需解析（新建或复用）
// 不校验 mimetype：交给 processor 逐张判断并返回“逐文件错误”，个别坏文件不影响整批。
function uploadWithToken(req, res, next) {
  upload.array('files', 20)(req, res, (err) => {
    if (err) {
      // multer 抛出的业务错误（fileFilter）带 message
      const msg = err && err.code === 'LIMIT_FILE_SIZE'
        ? '单个文件不能超过 60MB'
        : (err && err.message) || '上传失败，请重试';
      return res.status(400).json({ ok: false, message: msg });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ ok: false, message: '没有收到图片文件' });
    }
    if (!req.token) req.token = resolveToken(req);
    next();
  });
}

/** 读取会话内的原始文件列表（按文件名序号排序，保证与上传顺序一致） */
async function listOriginals(token) {
  const dir = sessionDirs(token).originals;
  try {
    const names = await fsp.readdir(dir);
    return names
      .filter((n) => /^\d+-/.test(n))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  } catch {
    return [];
  }
}

/** 依次处理原始文件并写入 outputs/，返回逐项结果 */
async function processOriginals(token, quality) {
  const names = await listOriginals(token);
  const results = [];
  const dirs = sessionDirs(token);
  fs.mkdirSync(dirs.outputs, { recursive: true });

  for (let i = 0; i < names.length; i++) {
    const fileName = names[i];
    const filePath = path.join(dirs.originals, fileName);
    const rawName = fileName.replace(/^\d+-/, '');
    const stat = await fsp.stat(filePath);
    const originalSize = stat.size;

    try {
      const buf = await fsp.readFile(filePath);
      const out = await compressImage(buf, quality);

      const outFileName = fileName.replace(/\.\w+$/, '') + out.ext;
      const outPath = path.join(dirs.outputs, outFileName);
      await fsp.writeFile(outPath, out.buffer);

      const outStat = await fsp.stat(outPath);
      results.push({
        index: i,
        originalName: rawName,
        fileName: outFileName,
        format: out.format,
        converted: out.converted,
        originalWidth: out.width,
        originalHeight: out.height,
        width: out.width,
        height: out.height,
        originalSize,
        compressedSize: outStat.size,
        savedBytes: originalSize - outStat.size,
        savedPercent: originalSize > 0 ? ((originalSize - outStat.size) / originalSize) * 100 : 0,
        quality,
        url: `/api/files/${token}/outputs/${encodeURIComponent(outFileName)}`,
      });
    } catch (e) {
      results.push({
        index: i,
        originalName: rawName,
        error: e.message || '压缩失败',
      });
    }
  }
  return results;
}

// ---------------- 路由 ----------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

// 上传 + 压缩（一个请求完成整批；携带已有 token 时追加到同一会话）
app.post('/api/compress', uploadWithToken, async (req, res) => {
  const quality = clampQuality(req.body && req.body.quality);
  try {
    const all = await processOriginals(req.token, quality);
    // 仅返回本次新增文件的结果（追加时旧文件排在前面）
    const added = Math.min(req.files.length, all.length);
    const results = all.slice(all.length - added);
    res.json({ ok: true, token: req.token, quality, results });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || '服务端处理失败' });
  }
});

// 按新质量重新压缩（前端已有 token，直接用原始文件，无需重新上传）
app.post('/api/recompress', async (req, res) => {
  const token = String((req.body && req.body.token) || '').replace(/[^a-z0-9]/gi, '');
  const quality = clampQuality(req.body && req.body.quality);
  if (!token) return res.status(400).json({ ok: false, message: '缺少会话标识' });
  const dirs = sessionDirs(token);
  if (!fs.existsSync(dirs.originals)) {
    return res.status(404).json({ ok: false, message: '会话已过期，请重新上传图片' });
  }
  try {
    const results = await processOriginals(token, quality);
    res.json({ ok: true, token, quality, results });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || '服务端处理失败' });
  }
});

// 访问压缩产物
app.get(
  '/api/files/:token/outputs/:name',
  (req, res, next) => {
    const token = String(req.params.token).replace(/[^a-z0-9]/gi, '');
    const name = req.params.name;
    const filePath = path.join(sessionDirs(token).outputs, name);
    // 防目录穿越
    if (!filePath.startsWith(path.join(sessionDirs(token).outputs))) {
      return res.status(400).json({ ok: false, message: '非法路径' });
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, message: '文件不存在或已过期' });
    }
    res.sendFile(filePath, {
      headers: {
        'Cache-Control': 'public, max-age=300',
      },
    }, next);
  }
);

// 整批打包下载
app.get('/api/files/:token/zip', async (req, res) => {
  const token = String(req.params.token).replace(/[^a-z0-9]/gi, '');
  const dirs = sessionDirs(token);
  if (!fs.existsSync(dirs.outputs)) {
    return res.status(404).json({ ok: false, message: '没有可打包的文件' });
  }

  const names = (await fsp.readdir(dirs.outputs)).filter((n) => n !== '.gitkeep');
  if (names.length === 0) {
    return res.status(404).json({ ok: false, message: '没有可打包的文件' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="compressed-${token.slice(0, 6)}.zip"`
  );

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('[zip]', err.message);
    res.status(500).end();
  });
  archive.pipe(res);
  const used = new Set();
  for (const n of names) {
    // 展示名：去掉序号前缀 + 加“_压缩”后缀，与单张下载命名保持一致
    const pretty = n.replace(/^\d+-/, '');
    const ext = path.extname(pretty);
    const base = (pretty.slice(0, pretty.length - ext.length) || 'image');
    let entryName = `${base}_压缩${ext}`;
    // 重名时保留完整文件名避免覆盖
    if (used.has(entryName)) entryName = n;
    used.add(entryName);
    archive.file(path.join(dirs.outputs, n), { name: entryName });
  }
  await archive.finalize();
});

// 静态托管前端
app.use(express.static(path.join(__dirname, 'public')));

// JSON 404 / 错误处理
app.use('/api', (req, res) => res.status(404).json({ ok: false, message: '接口不存在' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ ok: false, message: '服务器内部错误' });
});

// ---------------- 过期会话清理 ----------------
async function sweepOldSessions() {
  try {
    const tokens = await fsp.readdir(DATA_DIR);
    const now = Date.now();
    for (const t of tokens) {
      const dir = path.join(DATA_DIR, t);
      try {
        const st = await fsp.stat(dir);
        if (now - st.mtimeMs > TTL_MS) {
          await fsp.rm(dir, { recursive: true, force: true });
          console.log(`[cleanup] 已清理过期会话 ${t}`);
        }
      } catch { /* 单个目录失败不影响其他 */ }
    }
  } catch (e) {
    console.error('[cleanup]', e.message);
  }
}
const sweepTimer = setInterval(sweepOldSessions, 15 * 60 * 1000);

const server = app.listen(PORT, () => {
  console.log('==============================================');
  console.log('  图片压缩工具已启动');
  console.log(`  本机访问  : http://localhost:${PORT}`);
  console.log(`  局域网访问: http://<本机IP>:${PORT}`);
  console.log('==============================================');
});

// 端口被占用等启动错误：给出可读提示而不是裸堆栈
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[启动失败] 端口 ${PORT} 已被其他进程占用。\n`);
    console.error(`  排查步骤：`);
    console.error(`  1) 可能已有实例在运行 —— 直接访问 http://localhost:${PORT} 试试；`);
    console.error(`  2) 或结束占用进程后重试：`);
    console.error(`       netstat -ano | findstr :${PORT}`);
    console.error(`       taskkill /PID <上面的PID> /F`);
    console.error(`  3) 或换一个端口启动：`);
    console.error(`       set PORT=3211 && npm start\n`);
  } else {
    console.error('[启动失败]', err.message);
  }
  process.exit(1);
});

// 优雅退出
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(sweepTimer);
    process.exit(0);
  });
}
