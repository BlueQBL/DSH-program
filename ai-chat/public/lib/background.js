// 页面背景：把「用哪张图 + 多不透明」变成 CSS 的**唯一**一处。
//
// 存的是一个**描述**，不是 CSS：`{ kind, id?, dataUrl?, opacity }`。
//   · 内置背景 = 一张 svg 的路径（id 进白名单）；
//   · 用户上传的 = 一段 dataURL（压过、验过类型和大小）。
// 两种都要能「不透明度随便调、随时换回默认」，所以描述里只记这两件事；
// 怎么变成 `background-image` / `background-size` / `opacity` 全交给 backgroundCss()。
// 收在一个纯函数里，是因为它同时被三处用到（页面那一层、面板里的预览、缩略图），
// 而「三处各拼一次字符串」正是最容易慢慢长歪的地方。
//
// 纯函数 + 一层薄薄的存取，没有 DOM —— 这样它能被单测和变异盯住。

export const BACKGROUND_KEY = 'duitanlu.background.v1';
export const BG_OPACITY_DEFAULT = 40;
export const BG_OPACITY_MIN = 0;
export const BG_OPACITY_MAX = 100;
/** 上传的背景下限：dataURL 字符数（约 900KB 二进制）。localStorage 一共才 5MB 左右 */
export const BG_IMAGE_MAX = 1.2 * 1024 * 1024;
/** 压缩参数：长边 2400px、目标 700KB —— 比聊天图片大（它要铺满整屏），但也得有边 */
export const BG_MAX_EDGE = 2400;
export const BG_TARGET_CHARS = 700 * 1024;

/** 纸的大致亮度（#f5f2ec 的相对亮度）。用来算「图透上来之后，字底下到底有多亮」 */
export const PAPER_LUMINANCE = 0.9;

/**
 * 「字该用深色还是浅色」的分界线（相对亮度）。
 *
 * 这个数是**算出来的**，不是拍的：深墨（--ink #16161a，相对亮度 ≈ 0.008）要达到
 * WCAG AA 的 4.5:1，底色亮度得 ≥ 0.211；反过来纸色的字（≈ 0.87）要达标，底色得 ≤ 0.15。
 * 中间那条 0.15–0.21 的缝**两边都够不着** —— 分界线就放在缝里，
 * 于是永远选当时更清楚的那一种，而不是在某一侧硬撑。
 */
export const TONE_THRESHOLD = 0.18;

/** 字的深浅：auto = 按图判断；另外两种是用户钉死的 */
export const TONE_MODES = ['auto', 'dark', 'light'];

/**
 * 内置背景（白名单）。
 * `tile: true` 的按原尺寸平铺，`false` 的铺满（cover）—— 见 backgroundCss：
 * 把 32px 的点阵拉满一屏，点会变成巨大的圆斑；把远山平铺，又会出现明显的接缝。
 * `tone` 是这张图有多亮：内置这五张都是浅色纸纹，所以配深色字（也就是现在这个样子）。
 */
export const BACKGROUND_PRESETS = [
  { id: 'paper', label: '纸纹', url: 'backgrounds/paper.svg', tile: true, tone: 'light' },
  { id: 'grid', label: '方格', url: 'backgrounds/grid.svg', tile: true, tone: 'light' },
  { id: 'dots', label: '点阵', url: 'backgrounds/dots.svg', tile: true, tone: 'light' },
  { id: 'waves', label: '水波', url: 'backgrounds/waves.svg', tile: false, tone: 'light' },
  { id: 'hills', label: '远山', url: 'backgrounds/hills.svg', tile: false, tone: 'light' },
];

/** 「不设背景」——不透明度和字的深浅都留着，下次选图不用重新调 */
export const NO_BACKGROUND = {
  kind: 'none',
  id: '',
  dataUrl: '',
  opacity: BG_OPACITY_DEFAULT,
  tone: 'auto',
  detected: 'light',
};

/**
 * sRGB → 相对亮度（WCAG 那条公式）。
 *
 * 为什么不能拿 (r+g+b)/3 糊弄：人眼对绿最敏感、对蓝最不敏感 ——
 * 纯蓝 #0000ff 按平均值算有 33%，按相对亮度只有 7%，而它**看起来确实很暗**，
 * 该配浅色字。「深蓝到底算不算深色」这种分歧，正好就卡在这条公式上。
 */
export function relativeLuminance(r, g, b) {
  const channel = (value) => {
    const v = Math.min(255, Math.max(0, Number(value) || 0)) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * 字底下**实际**有多亮：图按不透明度压在纸上混出来的那个值。
 * 这一步非有不可 —— 纯黑图放到 20% 时底色其实是浅的（纸占八成），字仍然该是深色。
 */
export function effectiveLuminance(imageLuminance, opacity = BG_OPACITY_DEFAULT, paperLuminance = PAPER_LUMINANCE) {
  const image = Number.isFinite(Number(imageLuminance)) ? Math.min(1, Math.max(0, Number(imageLuminance))) : 1;
  const ratio = clampOpacity(opacity) / 100;
  return paperLuminance * (1 - ratio) + image * ratio;
}

/**
 * 定下这一页用深色字还是浅色字。
 * `preference` 是用户的选择，只有 auto 才看检测结果 —— **用户钉死的永远优先**：
 * 自动判断总会遇到它拿不准的图（一半黑一半白、或者正好卡在中间调）。
 *
 * 检测结果是「暗 / 亮」两档而不是一个亮度值：存进 localStorage 的东西越少越好，
 * 而且真正决定用哪种字的本来就是这两档。
 */
export function resolveTone({ detected = 'light', preference = 'auto', opacity = BG_OPACITY_DEFAULT } = {}) {
  if (preference === 'dark' || preference === 'light') return preference;
  const luminance = effectiveLuminance(detected === 'dark' ? 0 : 1, opacity);
  return luminance < TONE_THRESHOLD ? 'dark' : 'light';
}

/** 给界面用的一句话：这一页现在用的是深色字还是浅色字 */
export function toneText(tone) {
  return tone === 'dark' ? '浅色字' : '深色字';
}

/**
 * 不透明度：取整 + 夹在 0–100。
 * 认不出来的一律回落默认值，而不是 0 —— 0 等于「图没了」，用户会以为传丢了。
 *
 * 空值（undefined / null / 空串）算「没给」，也回默认值。
 * 这里不能直接 `Number(value)`：`Number(null)` 和 `Number('')` 都是 **0**，
 * 于是「没填」会被悄悄当成「全透明」—— 这一条是测试抓出来的（我第一版就写错了）。
 */
export function clampOpacity(value) {
  if (value === null || value === undefined || String(value).trim() === '') return BG_OPACITY_DEFAULT;
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return BG_OPACITY_DEFAULT;
  return Math.min(BG_OPACITY_MAX, Math.max(BG_OPACITY_MIN, number));
}

export function presetById(id) {
  return BACKGROUND_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** 能当背景的图：只有这三种类型、而且在大小上限以内（svg 能带脚本，排除） */
export function isBackgroundImage(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > BG_IMAGE_MAX) return false;
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl);
}

/**
 * 规整：认不出来的一律变成「不设背景」，但把不透明度和「字的深浅」保住。
 *
 * `detected`（这张图有多亮）对内置那几张**由预设表说了算**，不看存下来的值 ——
 * 于是「选了一张浅色纸纹」永远不会因为旧数据里留着 dark 而配成浅色字。
 */
export function normalizeBackground(raw) {
  const opacity = clampOpacity(raw?.opacity ?? BG_OPACITY_DEFAULT);
  const tone = TONE_MODES.includes(raw?.tone) ? raw.tone : 'auto';
  const detected = raw?.detected === 'dark' ? 'dark' : 'light';
  if (raw?.kind === 'builtin' && presetById(raw.id)) {
    return { kind: 'builtin', id: raw.id, dataUrl: '', opacity, tone, detected: presetById(raw.id).tone };
  }
  if (raw?.kind === 'image' && isBackgroundImage(raw.dataUrl)) {
    return { kind: 'image', id: '', dataUrl: raw.dataUrl, opacity, tone, detected };
  }
  return { kind: 'none', id: '', dataUrl: '', opacity, tone, detected };
}

/**
 * 描述 → 真 CSS。
 * 返回 { active, image, opacity, size, repeat, tone }：`active: false` 时页面那一层就藏起来，
 * 于是「不设背景」和「设了一张透明的」是两件不同的事（后者仍然是 active）。
 *
 * `tone` 是**这一页该用深色字还是浅色字**（算出来的，不是存下来的那两档原样转发）——
 * 因为「自动」还要看用户把不透明度拖到了哪儿：同一张黑图，20% 时用深色字、100% 时才翻成浅色。
 */
export function backgroundCss(background) {
  const clean = normalizeBackground(background);
  const tone = resolveTone({ detected: clean.detected, preference: clean.tone, opacity: clean.opacity });
  if (clean.kind === 'builtin') {
    const preset = presetById(clean.id);
    return {
      active: true,
      image: `url("${preset.url}")`,
      opacity: String(clean.opacity / 100),
      size: preset.tile ? 'auto' : 'cover',
      repeat: preset.tile ? 'repeat' : 'no-repeat',
      tone,
    };
  }
  if (clean.kind === 'image') {
    return {
      active: true,
      image: `url("${clean.dataUrl}")`,
      opacity: String(clean.opacity / 100),
      size: 'cover',
      repeat: 'no-repeat',
      tone,
    };
  }
  return { active: false, image: 'none', opacity: '0', size: 'cover', repeat: 'no-repeat', tone };
}

/** 读。脏数据（手改过的、旧版本留下的）当成「不设背景」，绝不让它把页面搞崩 */
export function readBackground(storage = globalThis.localStorage) {
  try {
    return normalizeBackground(JSON.parse(storage?.getItem(BACKGROUND_KEY) ?? 'null'));
  } catch {
    return { ...NO_BACKGROUND };
  }
}

export function writeBackground(background, storage = globalThis.localStorage) {
  const clean = normalizeBackground(background);
  try {
    storage?.setItem(BACKGROUND_KEY, JSON.stringify(clean));
    return { ok: true, background: clean };
  } catch {
    // 配额满 / 隐私模式：图太大存不下。**照样返回描述**让这一次用得上，
    // 但明确告诉调用方没落盘 —— 免得用户以为「设置好了」，刷新之后却没了。
    return { ok: false, background: clean };
  }
}

/**
 * 上传压过的图 → 背景描述（类型/大小不合格返回 null）。
 * `detected` 是**采样**出来的「这张图有多亮」（在浏览器里用 canvas 量，见 app.js）；
 * 量不出来时传 'light'（回落到纸面那套配色，最坏也就是维持现在的样子，不会翻成看不清）。
 */
export function backgroundFromUpload(compressed, opacity = BG_OPACITY_DEFAULT, { detected = 'light', tone = 'auto' } = {}) {
  const dataUrl = compressed?.dataUrl;
  const mime = String(compressed?.mime ?? '');
  if (!dataUrl || !/^image\/(png|jpeg|webp)$/.test(mime)) return null;
  if (!isBackgroundImage(dataUrl)) return null;
  return {
    kind: 'image',
    id: '',
    dataUrl,
    opacity: clampOpacity(opacity),
    tone: TONE_MODES.includes(tone) ? tone : 'auto',
    detected: detected === 'dark' ? 'dark' : 'light',
  };
}

/**
 * 量一下这张图有多亮 → 'dark' | 'light'。
 *
 * 两个做法上的讲究：
 *   · **缩到 24×24 再量**：原图几百万像素全量读一遍会卡住主线程；而缩图本身就是一次重采样
 *     （等于在算平均），比随手抽几个像素更能代表整张图。
 *   · **取平均而不是取中心点**：中心点常常是主体（一张脸、一朵花），不代表整张图。
 *
 * 量不出来时回 'light' —— 也就是维持现在这套纸面配色。**「失败也不变坏」这个方向是刻意的**：
 * 量不到就翻成浅色字，会把字弄到看不见；维持原样最差也只是原来那样。
 *
 * `ImageCtor` / `createCanvas` 可以注入，为的是**这件事本身能被测到** ——
 * 判断方向（暗图该配浅色字）错了正是用户最直接的抱怨，不能只靠"在浏览器里看运气"。
 * （用 canvas 采样这件事本身只有浏览器里才跑得动，替身里塞一个假 canvas 就够验方向了。）
 */
export async function sampleImageTone(dataUrl, {
  ImageCtor = globalThis.Image,
  createCanvas = () => globalThis.document?.createElement?.('canvas'),
  size = 24,
  threshold = 0.5,
} = {}) {
  try {
    const image = new ImageCtor();
    image.src = dataUrl;
    await (typeof image.decode === 'function'
      ? image.decode()
      : new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
      }));
    const canvas = createCanvas();
    if (!canvas?.getContext) return 'light';
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, size, size);
    const { data } = context.getImageData(0, 0, size, size);
    let total = 0;
    let weight = 0;
    for (let i = 0; i < data.length; i += 4) {
      // 半透明的像素按自身透明度加权：一块「透明的黑」其实还是纸的颜色
      const alpha = data[i + 3] / 255;
      if (!alpha) continue;
      total += relativeLuminance(data[i], data[i + 1], data[i + 2]) * alpha;
      weight += alpha;
    }
    if (!weight) return 'light';
    return total / weight < threshold ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** 上传失败时给一句能照着做的话 */
export function backgroundUploadError(err) {
  const message = String(err?.message ?? '');
  if (/只支持图片/.test(message)) return '只能传 png / jpg / webp 的图片';
  if (/太大/.test(message)) return '这张图太大了，换一张小一点的（压完不能超过 900KB）';
  return '这张图没能处理成功，换一张试试（png / jpg / webp）';
}
