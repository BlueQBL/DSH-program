# JWT 认证示例：Spring Boot 3 + Vue 3

一个完整的「登录 / 注册 / 认证中间件 / 用户模型」演示工程。

| 层 | 技术 | 位置 |
| --- | --- | --- |
| 后端 | Spring Boot 3.2 · Spring Data JPA · H2 · jjwt · BCrypt | `backend/` |
| 前端 | Vue 3 · Vite · Element Plus · Pinia · Vue Router · axios | `frontend/` |

认证方案：**JWT（无状态） + 自定义拦截器中间件**，不引入 Spring Security 全家桶。

---

## 四个交付物一览

| 交付物 | 后端实现 | 前端实现 |
| --- | --- | --- |
| **登录页面** | `POST /api/auth/login`（`AuthController` / `UserService#login`） | `frontend/src/views/LoginView.vue` |
| **注册页面** | `POST /api/auth/register`（`UserService#register`，注册即登录） | `frontend/src/views/RegisterView.vue` |
| **认证中间件** | `JwtAuthInterceptor`（HandlerInterceptor，挂在 `/api/**`）+ `WebConfig` 注册与白名单 | 路由守卫 `router/index.js` + axios 拦截器 `api/request.js` |
| **用户数据库模型** | `entity/User.java`（表 `users`，密码只存 BCrypt 散列）+ `repository/UserRepository.java` | Pinia `stores/auth.js` 里的会话状态 |

> 前后端都有“中间件”：后端拦截器校验每个受保护请求的 JWT；前端的路由守卫拦截未登录跳转、axios 拦截器统一附加/清理令牌并在 401 时登出。

## 目录结构

```
DSH-program/
├── backend/                      # Spring Boot
│   └── src/main/java/com/example/auth/
│       ├── AuthApplication.java      # 入口
│       ├── config/WebConfig.java     # 注册认证中间件、放行 login/register
│       ├── interceptor/JwtAuthInterceptor.java   # ★ 认证中间件
│       ├── entity/User.java          # ★ 用户数据库模型
│       ├── repository/UserRepository.java
│       ├── service/  UserService / JwtService
│       ├── controller/AuthController.java   # register / login / me
│       ├── dto/      # ApiResponse、AuthResponse、UserInfo、请求体 record
│       └── exception/ # BizException + 全局异常处理
├── frontend/                     # Vue 3 + Vite
│   └── src/
│       ├── router/index.js       # 路由 + 守卫（前端认证中间件）
│       ├── stores/auth.js        # Pinia 会话（token/user，localStorage 持久化）
│       ├── api/ request.js(axios 拦截器) / auth.js
│       ├── components/AuthShell.vue
│       ├── views/  LoginView / RegisterView / HomeView(受保护)
│       └── styles/main.css       # 设计令牌（暗色门禁主题）
└── maven-settings.xml            # 仅沙箱构建用，可删
```

## 快速启动

要求：JDK 17+、Maven、Node 18+。

```bash
# 1) 后端（默认 8080）
cd backend
mvn spring-boot:run

# 2) 前端（默认 5173，/api 已代理到 8080，无跨域问题）
cd frontend
npm install
npm run dev
```

打开 http://localhost:5173 → 注册 / 登录 → 进入受保护的工作台首页。

### 用 curl 直连后端验证

```bash
# 注册（成功即返回 JWT）
curl -X POST http://localhost:8080/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}'

# 登录
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}'

# 携带 token 访问受保护接口（把 <token> 换成上面返回的 token）
curl http://localhost:8080/api/auth/me -H "Authorization: Bearer <token>"

# 不带 token → 401 {"code":401,"message":"未登录：请求缺少 Authorization: Bearer <token>"}
curl http://localhost:8080/api/auth/me
```

H2 控制台（表结构查看）：http://localhost:8080/h2-console
JDBC URL `jdbc:h2:mem:authdb`，用户名 `sa`，密码留空。

## 认证流程

```
浏览器                     后端
  │  POST /api/auth/login    │  校验 BCrypt 密码
  │ ───────────────────────► │  签发 JWT(HMAC-SHA256, 含过期时间)
  │  ◄──────── token ──────  │
  │  GET /api/auth/me        │
  │  + Authorization: Bearer │  JwtAuthInterceptor 验签 + 查过期
  │ ───────────────────────► │  → 注入 userId → Controller
  │  ◄─── 200 用户信息 ─────  │
  │  （无 token / 过期/篡改） │  ← 401 {code,message} → 前端清会话回登录页
```

## 接口约定

统一响应 `{ code, message, data }`，`code` 与 HTTP 状态一致：

| 接口 | 方法 | 需登录 | 说明 |
| --- | --- | --- | --- |
| `/api/auth/register` | POST | 否 | 注册，用户名重复返回 409 |
| `/api/auth/login` | POST | 否 | 登录，失败返回 401 |
| `/api/auth/me` | GET | 是 | 当前用户信息（拦截器注入 userId） |
| `/api/**`（其余） | — | 是 | 未带有效 token 一律 401 |

## 常见调整

- **换 MySQL**：`backend/src/main/resources/application.yml` 改 datasource 为 MySQL，
  依赖加 `com.mysql:mysql-connector-j`（runtime），`ddl-auto` 改 `update`，并执行：

  ```sql
  CREATE DATABASE auth_demo DEFAULT CHARACTER SET utf8mb4;
  ```

- **改密钥/有效期**：`application.yml` 的 `jwt.secret`（≥32 字节）与 `jwt.expiration`（毫秒）。
  生产环境请用环境变量注入：`JWT_SECRET` 等，并开启 HTTPS。
- **令牌过期登录态**：前端守卫只判断 token 是否存在；真正过期在请求 `/me` 时由后端 401 触发自动登出（见 `HomeView` 的“校验令牌并刷新”）。

## 备注

- `maven-settings.xml` 与 `.m2-repo/`、`.npm-cache/` 是本机沙箱环境构建产生的，可删除。
- 演示工程刻意未含：找回密码、邮箱验证、验证码、Remember-Me 刷新令牌 —— 属于进阶话题。
