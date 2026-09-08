/**
 * processor.js
 * 图片压缩核心逻辑：将上传的图片缓冲区按“质量百分比(1-100)”压缩。
 *
 * 压缩策略（输出格式尽量保持原格式，避免二次损/格式意外变化）：
 *   - JPEG  -> JPEG（mozjpeg，质量 = quality）
 *   - WebP  -> WebP（质量 = quality）
 *   - AVIF  -> AVIF（质量 = quality）
 *   - PNG   -> PNG（按质量分档：100 无损最优压缩；≥60 调色板量化；<60 更激进的量化，
 *              以“质量百分比”的形式给出连续可预期的体积-画质权衡）
 *   - BMP/TIFF -> 统一转为 PNG（这些格式本身不可“有损压缩”，转换是最实用的瘦身方式）
 *   - GIF   -> 单帧静图转 PNG；多帧动图不支持（返回明确错误，不静默丢帧）
 *
 * 所有输出都会自动按 EXIF 旋转方向校正，并剥离 EXIF 等元数据以进一步减小体积。
 */

const sharp = require('sharp');

const MIME_TYPES = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
};

const EXT_BY_FORMAT = {
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp',
  avif: '.avif',
  gif: '.gif',
};

/** 输入缓冲区 -> 输出 { buffer, format, width, height, converted } */
async function compressImage(buffer, quality) {
  const q = clampQuality(quality);

  const meta = await sharp(buffer).metadata();
  const inFormat = MIME_TYPES[meta.format ? `image/${meta.format}` : ''] || (meta.format || '');

  if (!inFormat || !meta.width || !meta.height) {
    throw new Error(`无法识别的图片格式${meta.format ? `（${meta.format}）` : ''}，请上传 JPG / PNG / WebP 等常见格式`);
  }

  // 动图 GIF：不静默丢帧，直接给出明确错误
  if (inFormat === 'gif' && (meta.pages || 1) > 1) {
    throw new Error('暂不支持压缩多帧 GIF 动图，请先转换为静态图片');
  }

  const pipeline = sharp(buffer).rotate(); // 按 EXIF 自动摆正 + 后续输出剥离元数据

  let outFormat = inFormat;
  let converted = false;

  switch (inFormat) {
    case 'jpeg':
      pipeline.jpeg({ quality: q, mozjpeg: true, chromaSubsampling: '4:2:0' });
      break;
    case 'webp':
      pipeline.webp({ quality: q, effort: 4 });
      break;
    case 'avif':
      pipeline.avif({ quality: q, effort: 6 });
      break;
    case 'png':
      applyPngSettings(pipeline, q);
      break;
    case 'gif':
      // 单帧 GIF 视为静态图，转 PNG 更省空间
      outFormat = 'png';
      converted = true;
      applyPngSettings(pipeline, q);
      break;
    case 'bmp':
    case 'tiff':
    default:
      // BMP（本身无压缩）/ TIFF（无损为主）-> PNG
      outFormat = 'png';
      converted = true;
      applyPngSettings(pipeline, q);
      break;
  }

  const out = await pipeline.toBuffer();
  return {
    buffer: out,
    format: outFormat,
    ext: EXT_BY_FORMAT[outFormat] || '.' + outFormat,
    width: meta.width,
    height: meta.height,
    converted,
  };
}

/** 把 1-100 的质量换算为 PNG 的压缩策略 */
function applyPngSettings(pipeline, q) {
  if (q >= 100) {
    // 无损：最高压缩级别 + 最高 effort
    pipeline.png({ compressionLevel: 9, palette: false, effort: 10, adaptiveFiltering: true });
  } else if (q >= 60) {
    // 调色板量化（≤256 色）保留透明度，图片类内容画质损失很小、体积大幅下降
    pipeline.png({
      compressionLevel: 9,
      palette: true,
      colours: 256,
      dither: q >= 80 ? 0.9 : 0.55,
      effort: 10,
    });
  } else {
    // 激进压缩：更少的颜色数，适合截图等对画质不敏感的场景
    pipeline.png({
      compressionLevel: 9,
      palette: true,
      colours: 128,
      dither: 0.4,
      effort: 10,
    });
  }
}

function clampQuality(q) {
  const n = Number(q);
  if (!Number.isFinite(n)) return 70;
  return Math.min(100, Math.max(1, Math.round(n)));
}

/** 格式化文件大小，用于日志与调试 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

module.exports = { compressImage, clampQuality, formatBytes, MIME_TYPES };
