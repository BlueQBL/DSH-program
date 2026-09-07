import request from './request'

// 登录 / 注册成功都返回 { token, tokenType, expiresIn, user }
export function loginApi(data) {
  return request.post('/auth/login', data)
}

export function registerApi(data) {
  return request.post('/auth/register', data)
}

// 需要登录：用于刷新用户资料 & 验证令牌仍然有效
export function fetchMe() {
  return request.get('/auth/me')
}
