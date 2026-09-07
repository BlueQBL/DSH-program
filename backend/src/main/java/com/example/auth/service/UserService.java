package com.example.auth.service;

import com.example.auth.dto.AuthResponse;
import com.example.auth.dto.LoginRequest;
import com.example.auth.dto.RegisterRequest;
import com.example.auth.dto.UserInfo;
import com.example.auth.entity.User;
import com.example.auth.exception.BizException;
import com.example.auth.repository.UserRepository;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 认证业务：注册、登录、查询当前用户。
 */
@Service
public class UserService {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;

    public UserService(UserRepository userRepository,
                       PasswordEncoder passwordEncoder,
                       JwtService jwtService) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
    }

    /**
     * 注册：校验唯一性 → BCrypt 散列密码 → 落库 → 直接签发 JWT（注册即登录）。
     */
    @Transactional
    public AuthResponse register(RegisterRequest request) {
        String username = request.username().trim();
        if (userRepository.existsByUsername(username)) {
            throw new BizException(HttpStatus.CONFLICT, "用户名已被占用，请换一个");
        }

        User user = new User();
        user.setUsername(username);
        user.setPasswordHash(passwordEncoder.encode(request.password()));
        userRepository.save(user);

        return issueToken(user);
    }

    /**
     * 登录：校验用户名与密码，通过后签发 JWT。
     * 为防时序侧信道，用户不存在与密码错误返回同一句提示。
     */
    @Transactional(readOnly = true)
    public AuthResponse login(LoginRequest request) {
        User user = userRepository.findByUsername(request.username().trim())
                .filter(u -> passwordEncoder.matches(request.password(), u.getPasswordHash()))
                .orElseThrow(() -> new BizException(HttpStatus.UNAUTHORIZED, "用户名或密码错误"));

        return issueToken(user);
    }

    /** 按 ID 取当前用户（认证中间件已保证 ID 合法，此处防御性校验存在性） */
    @Transactional(readOnly = true)
    public UserInfo me(Long userId) {
        return userRepository.findById(userId)
                .map(UserInfo::from)
                .orElseThrow(() -> new BizException(HttpStatus.UNAUTHORIZED, "用户不存在，请重新登录"));
    }

    private AuthResponse issueToken(User user) {
        return new AuthResponse(
                jwtService.generateToken(user),
                "Bearer",
                jwtService.getExpirationMs() / 1000,
                UserInfo.from(user)
        );
    }
}
