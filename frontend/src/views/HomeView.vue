<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { EditPen, Refresh, SwitchButton } from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import { getToken } from '@/utils/storage'

const router = useRouter()
const auth = useAuthStore()
const refreshing = ref(false)
const lastSync = ref('')

/** 解析 localStorage 里的 JWT payload（base64url → UTF-8 JSON） */
function parseTokenPayload() {
  const token = getToken()
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

const payload = parseTokenPayload()

const registeredAt = computed(() =>
  auth.user?.createdAt ? new Date(auth.user.createdAt).toLocaleString('zh-CN') : '—'
)

const issuedAt = computed(() => (payload?.iat ? new Date(payload.iat * 1000).toLocaleString('zh-CN') : '—'))
const expiresAt = computed(() => (payload?.exp ? new Date(payload.exp * 1000).toLocaleString('zh-CN') : '—'))

const tokenValid = computed(() => {
  if (!payload?.exp) return false
  return payload.exp * 1000 > Date.now()
})

const remainingText = computed(() => {
  if (!payload?.exp) return '—'
  const ms = payload.exp * 1000 - Date.now()
  if (ms <= 0) return '已过期'
  const hours = Math.floor(ms / 3600000)
  const minutes = Math.floor((ms % 3600000) / 60000)
  return `${hours} 小时 ${minutes} 分`
})

async function handleRefresh() {
  refreshing.value = true
  try {
    await auth.refreshProfile() // 401 时响应拦截器会自动登出并回登录页
    lastSync.value = new Date().toLocaleTimeString('zh-CN')
    ElMessage.success('令牌校验通过，资料已刷新')
  } catch {
    // 401 场景：会话已被清理，无需额外提示（拦截器已提示）
  } finally {
    refreshing.value = false
  }
}

function handleLogout() {
  auth.logout()
  ElMessage.success('已安全退出')
  router.push('/login')
}

onMounted(async () => {
  if (auth.isLoggedIn) {
    await handleRefresh()
  }
})
</script>

<template>
  <div class="app-page">
    <!-- 顶部导航 -->
    <header class="app-topbar">
      <div class="brand">
        <span class="brand-caret">›</span>
        <span>dsh/gate</span>
        <span class="brand-tag">WORKSPACE</span>
      </div>

      <div class="app-user">
        <span class="avatar">{{ (auth.username || '?').slice(0, 1).toUpperCase() }}</span>
        <span class="app-username">{{ auth.username || '—' }}</span>
        <el-button link :icon="SwitchButton" @click="handleLogout">退出登录</el-button>
      </div>
    </header>

    <main class="app-main">
      <!-- 欢迎横幅 -->
      <section class="hero">
        <p class="hero-eyebrow">SESSION ACTIVE · 会话有效</p>
        <h1 class="hero-title">你好，{{ auth.username }}</h1>
        <p class="hero-desc">
          你正通过 <span class="mono">JWT</span> 访问受保护区域 —— 本页数据由
          <span class="mono">GET /api/auth/me</span> 实时拉取，请求头携带
          <span class="mono">Authorization: Bearer &lt;token&gt;</span>，由后端认证中间件验签放行。
        </p>
        <div class="hero-actions">
          <el-button type="primary" :icon="Refresh" :loading="refreshing" @click="handleRefresh">
            校验令牌并刷新
          </el-button>
          <el-button :icon="EditPen" @click="router.push('/blackboard')">打开电子黑板</el-button>
          <span v-if="lastSync" class="sync-note">最近同步 {{ lastSync }}</span>
        </div>
      </section>

      <div class="grid">
        <!-- 会话信息 -->
        <section class="panel">
          <div class="panel-head">
            <h2>会话信息</h2>
            <span class="pill" :class="tokenValid ? 'ok' : 'bad'">
              {{ tokenValid ? 'TOKEN 有效' : 'TOKEN 失效' }}
            </span>
          </div>
          <dl class="kv">
            <div><dt>用户 ID</dt><dd class="mono">#{{ auth.user?.id ?? '—' }}</dd></div>
            <div><dt>用户名</dt><dd>{{ auth.username || '—' }}</dd></div>
            <div><dt>注册时间</dt><dd>{{ registeredAt }}</dd></div>
            <div><dt>令牌类型</dt><dd class="mono">Bearer</dd></div>
            <div><dt>签发时间</dt><dd>{{ issuedAt }}</dd></div>
            <div><dt>到期时间</dt><dd>{{ expiresAt }}</dd></div>
            <div><dt>剩余有效期</dt><dd>{{ remainingText }}</dd></div>
          </dl>
        </section>

        <!-- 认证链路说明 -->
        <section class="panel">
          <div class="panel-head">
            <h2>本次认证链路</h2>
            <span class="pill">AUTH FLOW</span>
          </div>
          <ol class="steps">
            <li>
              <span class="step-no">01</span>
              <div>
                <strong>签发</strong>
                <p>登录接口校验 BCrypt 密码后，用 HMAC-SHA256 签发带过期时间的 JWT。</p>
              </div>
            </li>
            <li>
              <span class="step-no">02</span>
              <div>
                <strong>携带</strong>
                <p>axios 请求拦截器自动附加 <span class="mono">Authorization</span> 头。</p>
              </div>
            </li>
            <li>
              <span class="step-no">03</span>
              <div>
                <strong>校验</strong>
                <p><span class="mono">JwtAuthInterceptor</span> 中间件验签、检查过期并把用户 ID 注入请求。</p>
              </div>
            </li>
            <li>
              <span class="step-no">04</span>
              <div>
                <strong>失效兜底</strong>
                <p>无令牌 / 过期 / 篡改 → 后端返回 401，前端拦截器清空会话并回到登录页。</p>
              </div>
            </li>
          </ol>
        </section>
      </div>
    </main>
  </div>
</template>

<style scoped>
.app-page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.app-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px clamp(20px, 4vw, 48px);
  border-bottom: 1px solid var(--gate-line);
  background: rgba(10, 15, 30, 0.6);
  backdrop-filter: blur(6px);
  position: sticky;
  top: 0;
  z-index: 10;
}

.brand {
  font-family: var(--gate-mono);
  font-size: 15px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--gate-text);
}

.brand-tag {
  font-size: 10px;
  letter-spacing: 0.28em;
  color: var(--gate-faint);
  border: 1px solid var(--gate-line);
  border-radius: 4px;
  padding: 3px 7px;
}

.app-user {
  display: flex;
  align-items: center;
  gap: 12px;
}

.avatar {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, rgba(229, 171, 78, 0.9), rgba(229, 171, 78, 0.55));
  color: var(--gate-accent-ink);
  font-weight: 800;
  font-size: 16px;
}

.app-username {
  font-weight: 600;
}

.app-main {
  width: min(1080px, 100% - clamp(0px, 8vw, 96px));
  margin: 0 auto;
  padding: 40px 0 60px;
  display: flex;
  flex-direction: column;
  gap: 28px;
}

/* 欢迎横幅 */
.hero {
  position: relative;
  border: 1px solid var(--gate-line);
  border-radius: 20px;
  padding: 42px clamp(24px, 5vw, 48px);
  background:
    radial-gradient(700px 260px at 92% 0%, rgba(229, 171, 78, 0.14), transparent 70%),
    linear-gradient(180deg, rgba(24, 37, 63, 0.85), rgba(13, 21, 40, 0.9));
  overflow: hidden;
  animation: gate-rise 0.5s cubic-bezier(0.2, 0.7, 0.2, 1) both;
}

.hero::before {
  content: '';
  position: absolute;
  top: 0;
  left: 32px;
  right: 32px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--gate-accent), transparent);
}

.hero-eyebrow {
  margin: 0 0 16px;
  font-family: var(--gate-mono);
  font-size: 12px;
  letter-spacing: 0.26em;
  color: var(--gate-ok);
}

.hero-title {
  margin: 0 0 14px;
  font-size: clamp(30px, 4vw, 42px);
  font-weight: 800;
  letter-spacing: -0.02em;
}

.hero-desc {
  margin: 0;
  max-width: 720px;
  line-height: 1.9;
  color: var(--gate-muted);
  font-size: 15px;
}

.mono {
  font-family: var(--gate-mono);
  font-size: 0.92em;
  color: var(--gate-text);
  background: rgba(148, 163, 184, 0.1);
  padding: 1px 6px;
  border-radius: 6px;
}

.hero-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 26px;
}

.sync-note {
  font-size: 12px;
  color: var(--gate-faint);
}

/* 双栏面板 */
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 28px;
}

.panel {
  background: rgba(13, 21, 40, 0.72);
  border: 1px solid var(--gate-line);
  border-radius: 18px;
  padding: 26px 28px;
  animation: gate-rise 0.5s cubic-bezier(0.2, 0.7, 0.2, 1) 0.06s both;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;
}

.panel-head h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
}

.pill {
  font-family: var(--gate-mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  border: 1px solid var(--gate-line);
  border-radius: 999px;
  padding: 4px 12px;
  color: var(--gate-muted);
}

.pill.ok {
  color: var(--gate-ok);
  border-color: color-mix(in srgb, var(--gate-ok) 35%, transparent);
}

.pill.bad {
  color: var(--gate-danger);
  border-color: color-mix(in srgb, var(--gate-danger) 35%, transparent);
}

/* 键值表 */
.kv {
  margin: 0;
}

.kv > div {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 11px 2px;
  border-bottom: 1px dashed var(--gate-line);
}

.kv > div:last-child {
  border-bottom: none;
}

.kv dt {
  color: var(--gate-muted);
  font-size: 13.5px;
}

.kv dd {
  margin: 0;
  font-size: 14px;
  text-align: right;
}

/* 链路步骤（认证时序，编号有真实含义） */
.steps {
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: step;
}

.steps li {
  display: flex;
  gap: 16px;
  padding: 13px 2px;
  border-bottom: 1px dashed var(--gate-line);
}

.steps li:last-child {
  border-bottom: none;
}

.step-no {
  font-family: var(--gate-mono);
  font-size: 13px;
  color: var(--gate-accent);
  font-weight: 700;
  padding-top: 2px;
}

.steps strong {
  font-size: 14.5px;
}

.steps p {
  margin: 5px 0 0;
  font-size: 13px;
  line-height: 1.75;
  color: var(--gate-muted);
}

@media (max-width: 860px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
