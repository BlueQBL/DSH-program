package com.example.auth.dto;

import com.example.auth.entity.User;

import java.time.LocalDateTime;

/**
 * 对外暴露的用户信息（绝不携带 passwordHash）。
 */
public record UserInfo(Long id, String username, LocalDateTime createdAt) {

    public static UserInfo from(User user) {
        return new UserInfo(user.getId(), user.getUsername(), user.getCreatedAt());
    }
}
