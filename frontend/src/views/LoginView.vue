<script setup>
import { reactive, ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { User, Lock } from '@element-plus/icons-vue'
import AuthShell from '@/components/AuthShell.vue'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const formRef = ref(null)
const loading = ref(false)

const form = reactive({
  username: '',
  password: ''
})

/** 左侧终端里展示的接口示意（含引号的文本放在脚本中，避免与模板属性解析冲突） */
const terminalLines = [
  'curl -X POST /api/auth/login \\',
  '-H "Content-Type: application/json" \\',
  "-d '{\"username\": \"alice\", \"password\": \"******\"}'",
  '> 200 OK · JWT 已签发',
  '> expires_in: 86400s'
]

const rules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
}

// 登录成功后的去向：优先回到被拦截前的页面，其次首页；防外部跳转
function safeRedirect() {
  const target = route.query.redirect
  if (typeof target === 'string' && target.startsWith('/') && !target.startsWith('//')) {
    return target
  }
  return '/'
}

async function onSubmit() {
  if (loading.value) return
  try {
    await formRef.value.validate()
  } catch {
    return // 校验失败，element-plus 已在字段下提示
  }

  loading.value = true
  try {
    await auth.login({ username: form.username, password: form.password })
    ElMessage.success(`登录成功，欢迎回来，${form.username}`)
    router.push(safeRedirect())
  } catch {
    // 错误提示由 axios 响应拦截器统一弹出
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  // 注册页跳转回来时预填用户名
  if (typeof route.query.username === 'string' && !form.username) {
    form.username = route.query.username
  }
})
</script>

<template>
  <AuthShell
    eyebrow="身份门禁 · AUTH GATE"
    title="欢迎回来"
    tagline="输入你的凭据，通过门禁进入受保护的工作台。令牌由后端签发，随每次请求携带。"
    :lines="terminalLines"
  >
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-position="top"
      size="large"
      @submit.prevent="onSubmit"
    >
      <el-form-item label="用户名" prop="username">
        <el-input
          v-model="form.username"
          :prefix-icon="User"
          placeholder="请输入用户名"
          name="username"
          autocomplete="username"
          clearable
        />
      </el-form-item>

      <el-form-item label="密码" prop="password">
        <el-input
          v-model="form.password"
          :prefix-icon="Lock"
          type="password"
          show-password
          placeholder="请输入密码"
          name="password"
          autocomplete="current-password"
          @keyup.enter="onSubmit"
        />
      </el-form-item>

      <el-button
        class="gate-submit"
        type="primary"
        native-type="submit"
        :loading="loading"
      >
        登录
      </el-button>

      <p class="gate-enter-hint">
        <span class="kbd">Enter</span>
        提交登录
      </p>
    </el-form>

    <template #panel-footer>
      还没有账号？
      <router-link to="/register">注册一个</router-link>
    </template>
  </AuthShell>
</template>
