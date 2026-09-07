import { defineStore } from 'pinia'
import { loginApi, registerApi, fetchMe } from '@/api/auth'
import { getToken, setToken, getUser, setUser, clearAuth } from '@/utils/storage'

/**
 * 认证状态：token + 当前用户。
 * 初始化时从 localStorage 恢复，因此刷新页面不掉登录态。
 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: getToken(),
    user: getUser()
  }),

  getters: {
    isLoggedIn: (state) => Boolean(state.token),
    username: (state) => state.user?.username || ''
  },

  actions: {
    async login(payload) {
      const data = await loginApi(payload)
      this._applySession(data)
      return data
    },

    async register(payload) {
      // 注册成功即自动登录（后端直接签发 token）
      const data = await registerApi(payload)
      this._applySession(data)
      return data
    },

    /** 拉取最新用户信息；令牌已失效时后端 401 → 响应拦截器统一登出 */
    async refreshProfile() {
      if (!this.token) return null
      const user = await fetchMe()
      this.user = user
      setUser(user)
      return user
    },

    logout() {
      this.token = ''
      this.user = null
      clearAuth()
    },

    _applySession(data) {
      this.token = data.token
      this.user = data.user
      setToken(data.token)
      setUser(data.user)
    }
  }
})
