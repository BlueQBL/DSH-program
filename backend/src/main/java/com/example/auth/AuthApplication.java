package com.example.auth;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * 认证示例后端入口。
 *
 * <p>认证架构（无 Spring Security 全家桶）：</p>
 * <ul>
 *   <li>POST /api/auth/register —— 注册（BCrypt 加密落库）并直接签发 JWT</li>
 *   <li>POST /api/auth/login    —— 登录，校验密码后签发 JWT</li>
 *   <li>GET  /api/auth/me       —— 当前用户信息（受认证中间件保护）</li>
 *   <li>{@code /api/**} 其余请求均由 JwtAuthInterceptor 认证中间件校验 Bearer Token</li>
 * </ul>
 */
@SpringBootApplication
public class AuthApplication {

    public static void main(String[] args) {
        SpringApplication.run(AuthApplication.class, args);
    }
}
