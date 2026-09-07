package com.example.auth.controller;

import com.example.auth.dto.ApiResponse;
import com.example.auth.dto.AuthResponse;
import com.example.auth.dto.LoginRequest;
import com.example.auth.dto.RegisterRequest;
import com.example.auth.dto.UserInfo;
import com.example.auth.interceptor.JwtAuthInterceptor;
import com.example.auth.service.UserService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 认证接口。
 *
 * <p>register / login 已在 WebConfig 中从认证中间件白名单放行；
 * me 被中间件保护 —— 能调通它，说明携带的 JWT 通过了验签与过期校验。</p>
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final UserService userService;

    public AuthController(UserService userService) {
        this.userService = userService;
    }

    /** 注册（成功即签发 JWT，前端直接进入已登录状态） */
    @PostMapping("/register")
    public ApiResponse<AuthResponse> register(@Valid @RequestBody RegisterRequest request) {
        return ApiResponse.ok(userService.register(request));
    }

    /** 登录 */
    @PostMapping("/login")
    public ApiResponse<AuthResponse> login(@Valid @RequestBody LoginRequest request) {
        return ApiResponse.ok(userService.login(request));
    }

    /** 当前用户信息（需登录；用户 ID 由认证中间件解析 Token 后注入） */
    @GetMapping("/me")
    public ApiResponse<UserInfo> me(
            @RequestAttribute(JwtAuthInterceptor.ATTR_USER_ID) Long userId) {
        return ApiResponse.ok(userService.me(userId));
    }
}
