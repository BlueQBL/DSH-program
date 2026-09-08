# 图片压缩工具（Image Compressor）

一个可直接运行的**前后端完整**图片压缩网站：拖入 / 粘贴 / 批量上传图片，拖动滑杆调节压缩质量，
逐张**按住拖动对比原图与压缩效果**，单张下载或一键**打包下载全部**。

本机处理、文件 1 小时后自动清除 —— 适合个人与团队日常给图片瘦身。

---

## ✨ 功能

| 功能 | 说明 |
| --- | --- |
| 📤 多格式上传 | JPG / PNG / WebP / AVIF / BMP / TIFF / 单帧 GIF，单张 ≤ 60MB，单批 ≤ 20 张 |
| 🎚️ 质量调节 | 高画质(85%) / 均衡(70%) / 小体积(40%) 快捷档 + **1–100% 自定义滑杆** |
| 🔍 前后对比 | 每张结果卡支持**按住左右拖动**查看原图 vs 压缩后；尺寸 / 体积一目了然 |
| 📉 体积可视化 | 节省百分比、字节数、进度条式节省条，批量汇总“共节省多少” |
| 📦 批量处理 | 可反复拖入追加，随时“按此质量重压全部”，无需重新上传 |
| ⬇️ 下载 | 单张下载 + 全部打包为 **zip** 一键下载；命名统一为 `原文件名_压缩.扩展名` |
| 🔄 重新压缩 | 原图保留在服务端会话中，改质量后一键重压对比 |
| 🛡️ 隐私 | 图片只在本机处理，临时会话 1 小时后自动清除（可配置） |
| 📱 响应式 | 手机 / 平板 / 桌面自适应，触屏也能拖动对比 |
| ⌨️ 细节 | 支持 Ctrl/⌘+V 粘贴图片、键盘操作（Tab 后方向键调对比、空格开上传） |

## 🧱 技术栈

| 端 | 技术 |
| --- | --- |
| 后端 | Node.js + Express + Multer（上传）+ **Sharp**（压缩）+ Archiver（zip） |
| 前端 | 原生 HTML / CSS / JS（无框架、无 CDN 依赖，离线可用） |
| 样式 | CSS 自定义属性设计系统 · 现代简约绿色主题 · 响应式 + 深色对比滑块 |

## 📁 目录结构

```
image-compressor/
├── package.json            # 依赖与脚本
├── server.js               # Express 服务：API + 静态前端 + 会话清理
├── lib/
│   └── processor.js        # Sharp 压缩策略（按格式 & 质量换算）
├── public/                 # 前端
│   ├── index.html
│   ├── css/style.css
│   ├── js/app.js
│   └── favicon.svg
├── scripts/
│   └── smoke-test.js       # 端到端冒烟测试（自动起服务、造图、断言）
├── data/                   # 运行时生成（上传原图/产物），已 git 忽略
└── README.md
```

## 🚀 运行

环境要求：**Node.js ≥ 18**

```bash
cd image-compressor
npm install
npm start          # 等价于 node server.js
```

打开浏览器访问：

```
http://localhost:3210
```

> 局域网其他设备访问：`http://<本机IP>:3210`
> 端口可用环境变量覆盖：`PORT=8080 npm start`；会话保留时长：`CLEANUP_TTL_MIN=30 npm start`（默认 60 分钟）

### 开发模式（改代码自动重启）

```bash
npm run dev
```

### 自检（端到端冒烟测试）

```bash
npm run smoke
```

## 🖱️ 使用流程

1. **拖放 / 点击 / 粘贴**图片到上传区（可多选、可反复追加）
2. 点快捷档位或**拖动滑杆**选择压缩质量（越靠右画质越高、体积越大）
3. 自动开始上传并压缩，结果以卡片呈现
4. 每张卡片**按住左右拖动**，对比“原图 ↔ 压缩后”
5. 单张点卡片内 **下载**；全部完成点上方 **打包下载全部**（zip）
6. 想换一档质量？直接调滑杆 → **按此质量重压全部**，无需重新上传
7. 开始新一轮请点 **清空重来**

## 🔌 后端接口

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/compress` | POST | multipart：`files[]` + `quality` + 可选 `token`（追加）；返回逐文件结果 |
| `/api/recompress` | POST | JSON：`{ token, quality }` 对会话内全部原图按新质量重压 |
| `/api/files/:token/outputs/:name` | GET | 下载单个压缩产物 |
| `/api/files/:token/zip` | GET | 整批产物打包 zip 下载 |
| `/api/health` | GET | 健康检查 |

统一返回：`{ ok, token?, quality?, results: [...] }`；每个 result：

```jsonc
{
  "index": 0, "originalName": "photo.jpg", "fileName": "0000-photo.jpg",
  "format": "jpeg", "converted": false,
  "originalWidth": 1600, "originalHeight": 1100, "width": 1600, "height": 1100,
  "originalSize": 56237, "compressedSize": 33112,
  "savedBytes": 23125, "savedPercent": 41.1, "quality": 70,
  "url": "/api/files/xxxx/outputs/0000-photo.jpg"
  // 或 { "error": "原因" }  —— 单文件失败不影响整批
}
```

## 🎛️ 压缩策略

“质量百分比”对不同格式的换算（`lib/processor.js`）：

| 输入格式 | 输出格式 | 策略 |
| --- | --- | --- |
| JPG / JPEG | JPG | mozjpeg 编码，质量 = 百分比 |
| WebP | WebP | 质量 = 百分比 |
| AVIF | AVIF | 质量 = 百分比 |
| PNG | PNG | 100% 无损高压缩；≥60% 调色板量化（≤256 色 + 抖动）；<60% 更激进量化 |
| BMP / TIFF | PNG | 原格式无法有损压缩，自动转 PNG（卡片标注“转 PNG”） |
| GIF（单帧） | PNG | 静图转 PNG |
| GIF（多帧动图） | — | 明确报错，不静默丢帧 |

所有输出自动按 EXIF 摆正方向并剥离元数据，进一步瘦身。

## ❓ 常见问题

- **PNG 压不动？** PNG 本身已无损压缩；低于 90% 会启用调色板量化，色块类（截图/UI）收益明显，照片类建议转 JPG。
- **某张反而变大？** 卡片会提示“变大 +x%”，多见于本已高度优化的图片，可调低质量或换格式。
- **重压后对比图要不要重新上传？** 不需要，原图保留在会话目录，直到会话过期（默认 1 小时）。
- **多帧 GIF / 超大图？** 动图请先转静图；单文件超过 60MB 会被拒绝。

## 🔒 隐私与清理

- 文件保存在本地 `data/` 目录，不发送到任何第三方。
- 服务每 15 分钟清扫一次超过保留时长的会话目录（默认 60 分钟，`CLEANUP_TTL_MIN` 可调）。
- 重启服务后历史会话同样由清扫逻辑回收。
