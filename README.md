# DSH-program

基于 **DeepSeek Harness（DSH）** 生成、实践和持续沉淀的研发项目仓库。

## 1. 仓库简介

`DSH-program` 是一个用于 **AI 辅助软件研发实践、项目代码沉淀和工程能力验证** 的代码仓库。

仓库中的项目主要通过 **DeepSeek Harness（DSH）** 辅助进行需求分析、方案设计、代码生成、代码优化和持续迭代，并结合实际开发过程不断完善。

这里不仅用于存放某一个具体功能，而是作为一个**持续演进的 AI 研发实践仓库**：

- 🧩 沉淀 DSH 生成的实际项目
- 🤖 实践 AI 辅助需求分析与代码生成
- 💻 验证 AI 生成代码的工程可运行性
- 🔧 持续迭代和优化生成的项目代码
- 📚 沉淀不同技术栈、业务场景和开发模式
- 🚀 探索 AI 在软件研发全生命周期中的应用

后续会根据实际研发实践，持续向该仓库增加新的项目和功能。

# 2. AI 研发实践

这个仓库与普通业务代码仓库的一个重要区别是：

> **仓库中的项目主要用于实践 DeepSeek Harness 辅助软件研发的能力。**

项目开发过程中，可以通过 DSH 辅助完成：

```
需求分析
   ↓
项目设计
   ↓
技术方案
   ↓
代码生成
   ↓
项目运行
   ↓
问题排查
   ↓
代码优化
   ↓
测试验证
   ↓
Git 版本管理
   ↓
持续迭代
```

因此，该仓库不仅关注“代码能不能生成”，更关注：

- AI 生成代码能否真正运行
- 生成项目是否具备完整工程结构
- 前后端能否正常联调
- AI 生成代码是否符合工程规范
- 出现问题后能否通过 AI 辅助定位和修复
- 如何通过持续迭代提高 AI 研发效率
- 如何将 AI 研发过程中的经验进一步沉淀

# 3. 后续项目

当前 JWT 认证项目只是仓库的起点。

后续会持续增加不同类型的项目，例如：

- 前后端分离项目
- Spring Boot 后端项目
- Vue 前端项目
- 数据库相关项目
- AI / 大模型相关实践
- Agent 相关项目
- MCP 相关实践
- RAG / 知识库相关实践
- 业务功能原型
- 技术方案验证项目
- AI 代码生成实践
- AI 辅助重构与优化实践

随着实践不断深入，仓库会逐步形成一个：

> **以 DeepSeek Harness 为核心的 AI 辅助研发实践与代码沉淀仓库。**

# 4. 项目定位

`DSH-program` 不只是一个具体业务项目，也不局限于当前的 JWT 认证示例。

它更希望记录一个完整的实践过程：

> **从需求 → AI 分析 → AI 生成 → 工程运行 → 问题修复 → 持续优化 → Git 沉淀。**

随着项目持续增加，这个仓库将逐步成为 **DeepSeek Harness AI 辅助研发实践、项目验证和代码资产沉淀的平台**。

## 快速开始

如果你只是想快速把当前项目跑起来，可以直接执行：

### 后端

```bash
cd backend
mvn spring-boot:run
```

### 前端

```bash
cd frontend
npm install
npm run dev
```

然后打开：

```
http://localhost:5173
```

**开始使用。**

# 5. 其他项目

仓库持续沉淀新项目，各自独立、便于单独运行：

| 项目 | 目录 | 技术栈 | 快速开始 |
| --- | --- | --- | --- |
| JWT 认证示例 | `backend/` + `frontend/` | Spring Boot 3 + Vue 3 | 见上文 |
| **图片压缩工具** | `image-compressor/` | Node.js + Express + Sharp（前端原生） | `cd image-compressor && npm install && npm start` → http://localhost:3210 |
| **React Router 演示** | `react-frontend/` | React 18 + TypeScript + React Router 7 + Vite 7 | `cd react-frontend && npm install && npm run dev` → http://localhost:5174 |
| **水尺 · 喝水提醒** | `water-reminder/` | 零依赖 HTML + CSS + 原生 JS | `cd water-reminder && node server.js` → http://localhost:5180 |
| **流水账 · 个人记账** | `ledger/` | 零依赖 HTML + CSS + 原生 JS + PWA | `cd ledger && node server.js` → http://localhost:5190 |
| **个人作品集网站** | `portfolio/` | 零依赖 HTML + CSS + 原生 JS + Node 服务 | `cd portfolio && node server.js` → http://localhost:5200 |
| **案头待办** | `todo-app/` | 零依赖 HTML + CSS + 原生 JS + Node 服务 | `cd todo-app && node server.js` → http://127.0.0.1:5210 |
| **校样 · Markdown 笔记台** | `markdown-notes/` | 零依赖 HTML + CSS + 原生 JS + Node 服务 | `cd markdown-notes && node server.js` → http://127.0.0.1:5220 |
| **番茄钟 · 专注计时** | `pomodoro/` | 零依赖 HTML + CSS + 原生 JS + Node 服务 | `cd pomodoro && node server.js` → http://127.0.0.1:5230 |
| **云图 · 天气台** | `cloud-atlas/` | 零依赖 HTML + CSS + 原生 JS + Node 服务（含 API 代理） | `cd cloud-atlas && node server.js` → http://127.0.0.1:5240 |
| **对谈录 · AI 聊天助手** | `ai-chat/` | 零依赖 HTML + CSS + 原生 JS + Node 服务（SSE 流式 + 本地持久化） | `cd ai-chat && node server.mjs` → http://127.0.0.1:5250 |

后续新增项目会继续追加到本表。









