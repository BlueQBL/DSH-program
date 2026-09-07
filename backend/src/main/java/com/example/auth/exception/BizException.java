package com.example.auth.exception;

import org.springframework.http.HttpStatus;

/**
 * 业务异常：携带 HTTP 状态码与面向用户的提示语，由全局异常处理器统一转 JSON。
 */
public class BizException extends RuntimeException {

    private final HttpStatus status;

    public BizException(HttpStatus status, String message) {
        super(message);
        this.status = status;
    }

    public HttpStatus getStatus() {
        return status;
    }
}
