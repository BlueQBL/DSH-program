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

因此，**当前仓库中的 JWT 认证项目只是其中一个示例，后续还会持续增加其他项目。**

# 2. 当前项目

目前仓库包含一个基于 **Spring Boot + Vue 3** 的 JWT 认证演示项目：

### JWT Authentication Demo

主要用于验证 DSH 在一个完整前后端项目中的代码生成和工程落地能力。

当前包含：

- 用户注册
- 用户登录
- JWT 身份认证
- JWT 认证拦截器
- 用户信息查询
- BCrypt 密码加密
- Spring Data JPA
- H2 数据库
- Vue 3 前端
- Vue Router 路由管理
- Pinia 状态管理
- Axios 请求拦截
- 前后端接口联调
- 登录状态管理
- 未登录访问拦截
- 401 自动退出登录

当前项目技术栈：

| 模块     | 技术            |
| -------- | --------------- |
| 后端     | Spring Boot 3   |
| 持久层   | Spring Data JPA |
| 数据库   | H2              |
| 认证     | JWT             |
| 密码     | BCrypt          |
| 前端     | Vue 3           |
| 构建工具 | Vite            |
| UI       | Element Plus    |
| 状态管理 | Pinia           |
| 路由     | Vue Router      |
| HTTP     | Axios           |

# 3. 项目目录

当前仓库采用前后端分离结构：

```
DSH-program/
│
├── backend/                  # 后端项目
│   ├── src/
│   └── pom.xml
│
├── frontend/                 # 前端项目
│   ├── src/
│   ├── package.json
│   └── vite.config.js
│
├── README.md                 # 项目说明
└── .gitignore                # Git 忽略配置
```

随着后续项目增加，仓库会继续进行合理的目录划分。

例如：

```
DSH-program/
├── project-01/
├── project-02/
├── project-03/
├── backend/
├── frontend/
└── README.md
```

具体目录结构会根据后续项目实际情况进行调整。

# 4. 如何运行

如果你是第一次使用这个仓库，可以按照下面的步骤进行。

## 4.1 环境要求

运行当前项目需要准备：

- **JDK 17+**
- **Maven 3.8+**
- **Node.js 18+**
- **npm**

可以先检查本机环境：

```shell
java -version
mvn -version
node -version
npm -version
```

如果这些命令能够正常返回版本信息，说明基础环境已经准备完成。

# 5. 启动后端

进入后端目录：

```shell
cd backend
```

启动 Spring Boot：

```bash
mvn spring-boot:run
```

正常启动后，可以看到类似：

```bash
Tomcat started on port 8080
```

说明后端启动成功。

后端默认地址：

```bash
http://localhost:8080
```

# 6. 启动前端

**重新打开一个终端窗口**，进入前端目录：

```bash
cd frontend
```

第一次运行需要安装前端依赖：

```bash
npm install
```

安装完成后启动：

```bash
npm run dev
```

正常情况下会看到：

```
Local: http://localhost:5173/
```

打开浏览器访问：

```
http://localhost:5173
```

即可进入系统。

# 7. 第一次使用

启动前后端之后，可以按照下面的流程进行验证：

### 第一步：注册用户

进入注册页面，输入：

```
用户名：alice
密码：secret123
```

完成注册。

注册成功后会自动获得 JWT Token。

### 第二步：登录

退出当前会话后，可以使用刚才注册的账号重新登录。

### 第三步：进入工作台

登录成功后进入受保护的工作台页面。

前端会自动携带 JWT Token 访问后端接口。

### 第四步：验证认证机制

如果没有登录，直接访问受保护页面，前端路由守卫会阻止访问。

如果 Token 无效或者已经过期，后端会返回：

```
401 Unauthorized
```

# 8. 后端接口

当前 JWT 示例主要提供以下接口：

| 接口                 | 方法 | 是否需要登录 | 说明                 |
| -------------------- | ---- | ------------ | -------------------- |
| `/api/auth/register` | POST | 否           | 用户注册             |
| `/api/auth/login`    | POST | 否           | 用户登录             |
| `/api/auth/me`       | GET  | 是           | 获取当前用户信息     |
| `/api/**`            | —    | 是           | 其他接口默认需要认证 |

统一响应格式：

```json
{
  "code": 200,
  "message": "success",
  "data": {}
}
```

# 9. 数据库

当前项目默认使用 **H2 内存数据库**，主要用于快速运行和验证。

数据库特点：

- 不需要额外安装 MySQL
- 项目启动即可使用
- 适合学习、演示和快速验证
- 项目重启后数据会重新创建

H2 控制台：

```
http://localhost:8080/h2-console
```

连接信息：

```
JDBC URL: jdbc:h2:mem:authdb
用户名：sa
密码：留空
```

如果后续需要接入 MySQL，可以根据实际项目需求进行调整。

# 10. JWT 认证流程

当前项目采用：

```
用户
 ↓
Vue 登录页面
 ↓
POST /api/auth/login
 ↓
Spring Boot
 ↓
校验用户名 + BCrypt 密码
 ↓
生成 JWT
 ↓
返回 Token
 ↓
前端保存 Token
 ↓
后续请求携带 Authorization: Bearer <token>
 ↓
JwtAuthInterceptor
 ↓
JWT 验证
 ↓
获取用户身份
 ↓
访问受保护接口
```

当前项目**没有引入 Spring Security**，而是通过：

```
HandlerInterceptor
        +
JWT
        +
前端 Axios 拦截器
        +
Vue Router 路由守卫
```

实现完整的认证流程。

# 11. AI 研发实践

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

# 12. 后续项目

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

# 15. 项目定位

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

# 16. 其他项目

仓库持续沉淀新项目，各自独立、便于单独运行：

| 项目 | 目录 | 技术栈 | 快速开始 |
| --- | --- | --- | --- |
| JWT 认证示例 | `backend/` + `frontend/` | Spring Boot 3 + Vue 3 | 见上文 |
| **图片压缩工具** | `image-compressor/` | Node.js + Express + Sharp（前端原生） | `cd image-compressor && npm install && npm start` → http://localhost:3210 |

图片压缩工具实现了图片上传压缩、质量调节、前后对比、批量打包下载的完整前后端闭环，
并内置端到端冒烟测试（`npm run smoke`），详见 [image-compressor/README.md](image-compressor/README.md)。

后续新增项目会继续追加到本表。









