// 图片附件：选择 / 粘贴 / 拖拽 → 压缩 → 变成可发送的 dataURL
//
// 为什么一定要压缩：图片是以 base64 塞进请求体的，手机拍一张就 3–8MB，
// base64 后还要涨三分之一。不压的话单条消息就能把上下文撑到几十 MB，
// 上游会直接拒绝，浏览器也会卡。这里统一缩到长边 1568px（主流多模态接口的
// 推荐上限附近）并按画质递减压，直到体积达标。

/** 长边上限：再大对识别精度没帮助，只是白费 token */
export const MAX_EDGE = 1568;
/** 压缩目标：单张 dataURL 的字符数上限 */
export const TARGET_CHARS = 1.2 * 1024 * 1024;
/** 单条消息的图片数上限 */
export const MAX_IMAGES = 4;
export const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('这不是一张能解析的图片'));
    img.src = dataUrl;
  });
}

/** 按长边上限算出缩放后的尺寸；本来就小就原样返回 */
export function fitSize(width, height, maxEdge = MAX_EDGE) {
  if (!width || !height) return { width: maxEdge, height: maxEdge, scaled: false };
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height, scaled: false };
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  };
}

/**
 * 压缩一张图。
 * GIF 直接原样返回 —— canvas 重绘会丢掉动画，而用户发动图通常就是要看动的那部分。
 */
export async function compressImage(file, { maxEdge = MAX_EDGE, targetChars = TARGET_CHARS } = {}) {
  if (!file || !/^image\//.test(file.type || '')) throw new Error('只支持图片文件');
  const original = await readFileAsDataUrl(file);
  const img = await loadImage(original);

  const { width, height, scaled } = fitSize(img.naturalWidth, img.naturalHeight, maxEdge);
  let dataUrl = original;
  let mime = file.type || 'image/png';

  if (scaled || dataUrl.length > targetChars) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    // 白底：PNG 透明区转 JPEG 会变黑，先铺白比事后解释容易
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    // 画质递减，直到体积达标或已经很低
    let quality = 0.9;
    let out = canvas.toDataURL('image/jpeg', quality);
    while (out.length > targetChars && quality > 0.45) {
      quality -= 0.15;
      out = canvas.toDataURL('image/jpeg', quality);
    }
    dataUrl = out;
    mime = 'image/jpeg';
  }

  return {
    dataUrl,
    mime,
    name: file.name || '图片',
    width,
    height,
    originalChars: original.length,
    finalChars: dataUrl.length,
    compressed: dataUrl.length < original.length,
  };
}

/** 从剪贴板事件里取出图片文件 */
export function imageFilesFromClipboard(event) {
  const items = event?.clipboardData?.items;
  if (!items) return [];
  const files = [];
  for (const item of items) {
    if (item.kind === 'file' && /^image\//.test(item.type || '')) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

/** 从拖拽事件里取出图片文件 */
export function imageFilesFromDrop(event) {
  const files = event?.dataTransfer?.files;
  if (!files) return [];
  return [...files].filter((f) => /^image\//.test(f.type || ''));
}

/** 生成附件对象（id / 缩略图尺寸都要带上，界面直接用） */
export function toAttachment(compressed) {
  return {
    id: `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: compressed.name,
    mime: compressed.mime,
    dataUrl: compressed.dataUrl,
    width: compressed.width,
    height: compressed.height,
  };
}
