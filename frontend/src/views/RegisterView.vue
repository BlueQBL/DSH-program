<script setup>
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { User, Lock, Key } from '@element-plus/icons-vue'
import AuthShell from '@/components/AuthShell.vue'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const formRef = ref(null)
const loading = ref(false)

const form = reactive({
  username: '',
  password: '',
  confirmPassword: ''
})

/** 左侧终端里展示的接口示意（含引号的文本放在脚本中，避免与模板属性解析冲突） */
const terminalLines = [
  'curl -X POST /api/auth/register \\',
  '-H "Content-Type: application/json" \\',
  "-d '{\"username\": \"newbie01\", \"password\": \"******\"}'",
  '> 200 OK · 账号已创建',
  '> JWT 已签发（注册即登录）'
]

/** 用户名：3-20 位字母 / 数字 / 下划线，与后端校验保持一致 */
function validateUsername(_rule, value, callback) {
  if (!/^[A-Za-z0-9_]{3,20}$/.test(value || '')) {
    callback(new Error('3-20 位，仅限字母、数字和下划线'))
  } else {
    callback()
  }
}

function validateConfirm(_rule, value, callback) {
  if (value !== form.password) {
    callback(new Error('两次输入的密码不一致'))
  } else {
    callback()
  }
}

const rules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { validator: validateUsername, trigger: 'blur' }
  ],
  password: [
    { required: true, message: '请设置密码', trigger: 'blur' },
    { min: 6, max: 64, message: '密码长度需为 6-64 个字符', trigger: 'blur' }
  ],
  confirmPassword: [
    { required: true, message: '请再次输入密码', trigger: 'blur' },
    { validator: validateConfirm, trigger: ['blur', 'change'] }
  ]
}

async function onSubmit() {
  if (loading.value) return
  try {
    await formRef.value.validate()
  } catch {
    return
  }

  loading.value = true
  try {
    // 注册成功后端直接签发 token → 自动登录进入首页
    await auth.register({ username: form.username, password: form.password })
    ElMessage.success('账号创建成功，已自动登录')
    router.push('/')
  } catch {
    // 错误提示由 axios 响应拦截器统一弹出
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <AuthShell
    eyebrow="创建账号 · SIGN UP"
    title="加入工作台"
    tagline="填写资料后系统自动创建账号并为你登录 —— 不必再折返登录页。密码仅以 BCrypt 散列存储。"
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
          placeholder="3-20 位字母 / 数字 / 下划线"
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
          placeholder="至少 6 位字符"
          name="password"
          autocomplete="new-password"
        />
      </el-form-item>

      <el-form-item label="确认密码" prop="confirmPassword">
        <el-input
          v-model="form.confirmPassword"
          :prefix-icon="Key"
          type="password"
          show-password
          placeholder="再次输入密码"
          name="confirmPassword"
          autocomplete="new-password"
          @keyup.enter="onSubmit"
        />
      </el-form-item>

      <el-button
        class="gate-submit"
        type="primary"
        native-type="submit"
        :loading="loading"
      >
        创建账号
      </el-button>

      <p class="gate-enter-hint">
        <span class="kbd">Enter</span>
        提交注册
      </p>
    </el-form>

    <template #panel-footer>
      已有账号？
      <router-link to="/login">直接登录</router-link>
    </template>
  </AuthShell>
</template>
