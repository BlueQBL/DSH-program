import axios from 'axios'
import { ElMessage } from 'element-plus'
import { getToken, clearAuth } from '@/utils/storage'

/**
 * axios 实例。
 *
 * 双向“中间件”：
 *  1. 请求拦截器 —— 自动附加 Authorization: Bearer <token>
 *  2. 响应拦截器 —— 解包统一响应 {code, message, data}；
 *     遇 401（未登录 / 令牌过期 / 令牌无效）清空会话并回到登录页。
 */
const request = axios.create({
  baseURL: '/api',
  timeout: 10000
})

request.interceptors.request.use((config) => {
  const token = getToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// 未携带 token 访问受保护接口：后端认证中间件返回 401，拦截后回登录页
async function handleUnauthorized() {
  clearAuth()
  const { default: router } = await import('@/router')
  const current = router.currentRoute.value
  if (current.path !== '/login') {
    router.push({ path: '/login', query: { redirect: current.fullPath } })
  }
}

request.interceptors.response.use(
  (response) => {
    const body = response.data
    // 统一响应结构：成功直接吐业务数据
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code === 200) return body.data
      ElMessage.error(body.message || '请求失败')
      return Promise.reject(new Error(body.message || '请求失败'))
    }
    return body
  },
  async (error) => {
    const status = error.response?.status
    const message = error.response?.data?.message || error.message || '网络异常，请稍后再试'

    if (status === 401) {
      await handleUnauthorized()
    }
    // 未到登录页时已提示；在登录/注册页的 401（如密码错误）也提示一次
    ElMessage.error(message)
    return Promise.reject(error)
  }
)

export default request
