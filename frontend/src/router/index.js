import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

/**
 * 前端路由 + 全局前置守卫（前端认证“中间件”）。
 *
 * 规则：
 *  - 标记 meta.public 的页面（登录/注册）允许匿名访问；
 *  - 其余页面未登录一律重定向到 /login 并记住来路 redirect；
 *  - 已登录用户访问登录/注册页则送回首页。
 */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('@/views/HomeView.vue'),
      meta: { title: '工作台' }
    },
    {
      path: '/blackboard',
      name: 'blackboard',
      component: () => import('@/views/BlackboardView.vue'),
      meta: { title: '电子黑板' }
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true, title: '登录' }
    },
    {
      path: '/register',
      name: 'register',
      component: () => import('@/views/RegisterView.vue'),
      meta: { public: true, title: '注册' }
    },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})

router.beforeEach((to) => {
  const auth = useAuthStore()

  // 需要登录但当前无 token → 去登录页
  if (!to.meta.public && !auth.isLoggedIn) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }

  // 已登录再访问登录/注册页 → 送回首页
  if (to.meta.public && auth.isLoggedIn) {
    return { path: '/' }
  }

  document.title = to.meta.title ? `${to.meta.title} · GATE` : 'GATE · 认证中心'
  return true
})

export default router
