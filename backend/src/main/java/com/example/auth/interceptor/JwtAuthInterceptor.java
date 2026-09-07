package com.example.auth.interceptor;

import com.example.auth.dto.ApiResponse;
import com.example.auth.service.JwtService;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.ExpiredJwtException;
import io.jsonwebtoken.JwtException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * 认证中间件（核心交付物之一）。
 *
 * <p>作为 Spring MVC HandlerInterceptor 挂在 {@code /api/**} 上，
 * 在 Controller 执行前完成以下工作：</p>
 * <ol>
 *   <li>读取请求头 {@code Authorization: Bearer <token>}；</li>
 *   <li>解析并验签 JWT（过期 / 伪造 / 缺失都返回 401 统一 JSON）；</li>
 *   <li>把当前用户 ID、用户名放入 request attribute，供 Controller 通过
 *       {@code @RequestAttribute} 取用。</li>
 * </ol>
 *
 * <p>等价地：Spring Boot 生态里这个角色常被称为“认证过滤器/中间件”。</p>
 */
@Component
public class JwtAuthInterceptor implements HandlerInterceptor {

    /** request attribute：当前用户 ID */
    public static final String ATTR_USER_ID = "currentUserId";
    /** request attribute：当前用户名 */
    public static final String ATTR_USERNAME = "currentUsername";

    /** Bearer 前缀长度（"Bearer ".length()） */
    private static final int BEARER_PREFIX_LEN = 7;

    private final JwtService jwtService;
    private final ObjectMapper objectMapper;

    public JwtAuthInterceptor(JwtService jwtService, ObjectMapper objectMapper) {
        this.jwtService = jwtService;
        this.objectMapper = objectMapper;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler)
            throws Exception {

        // 放行预检请求（本工程用 Vite 代理同源访问，通常无跨域；保留以兼容直连场景）
        if ("OPTIONS".equalsIgnoreCase(request.getMethod())) {
            return true;
        }

        String authorization = request.getHeader(HttpHeaders.AUTHORIZATION);
        if (authorization == null || !authorization.startsWith("Bearer ")) {
            return writeUnauthorized(response, "未登录：请求缺少 Authorization: Bearer <token>");
        }

        String token = authorization.substring(BEARER_PREFIX_LEN).trim();
        try {
            Claims claims = jwtService.parseToken(token);
            // 把认证结果写进 request，下游 Controller / Service 通过 request attribute 读取
            request.setAttribute(ATTR_USER_ID, Long.valueOf(claims.getSubject()));
            request.setAttribute(ATTR_USERNAME, claims.get("username", String.class));
            return true;
        } catch (ExpiredJwtException e) {
            return writeUnauthorized(response, "登录已过期，请重新登录");
        } catch (JwtException | IllegalArgumentException e) {
            return writeUnauthorized(response, "登录凭证无效，请重新登录");
        }
    }

    /** 统一输出 401 JSON（与正常响应同一结构 {code, message, data}） */
    private boolean writeUnauthorized(HttpServletResponse response, String message) throws Exception {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding("UTF-8");
        objectMapper.writeValue(response.getOutputStream(), ApiResponse.error(401, message));
        return false;
    }
}
