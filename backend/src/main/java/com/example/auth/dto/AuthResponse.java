package com.example.auth.dto;

/**
 * 登录/注册成功后的响应：JWT + 有效期 + 用户信息。
 *
 * @param token      JWT 访问令牌
 * @param tokenType  令牌类型（Bearer）
 * @param expiresIn  有效期（秒）
 * @param user       当前登录用户信息
 */
public record AuthResponse(String token, String tokenType, long expiresIn, UserInfo user) {
}
