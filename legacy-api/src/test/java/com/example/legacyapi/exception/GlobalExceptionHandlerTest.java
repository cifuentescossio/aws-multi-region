package com.example.legacyapi.exception;

import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.servlet.NoHandlerFoundException;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

class GlobalExceptionHandlerTest {

    private GlobalExceptionHandler handler;

    @BeforeEach
    void setUp() {
        handler = new GlobalExceptionHandler();
    }

    @Test
    void handleNoHandlerFound_returnsStructured404Json() {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/v1/unknown");
        NoHandlerFoundException exception = new NoHandlerFoundException("GET", "/v1/unknown", new HttpHeaders());

        ResponseEntity<Map<String, Object>> response = handler.handleNoHandlerFound(exception, request);

        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
        assertNotNull(response.getBody());
        assertEquals(404, response.getBody().get("status"));
        assertEquals("Not Found", response.getBody().get("error"));
        assertEquals("/v1/unknown", response.getBody().get("path"));
        assertNotNull(response.getBody().get("timestamp"));
    }

    @Test
    void handleMethodNotSupported_returnsStructured405Json() {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/v1/region");
        HttpRequestMethodNotSupportedException exception =
                new HttpRequestMethodNotSupportedException("POST", List.of("GET"));

        ResponseEntity<Map<String, Object>> response = handler.handleMethodNotSupported(exception, request);

        assertEquals(HttpStatus.METHOD_NOT_ALLOWED, response.getStatusCode());
        assertNotNull(response.getBody());
        assertEquals(405, response.getBody().get("status"));
        assertEquals("Method Not Allowed", response.getBody().get("error"));
        assertEquals("/v1/region", response.getBody().get("path"));
        assertEquals("Method not allowed for this endpoint", response.getBody().get("message"));
    }

    @Test
    void handleGenericException_returnsStructured500Json() {
        HttpServletRequest request = new MockHttpServletRequest("GET", "/v1/region");

        ResponseEntity<Map<String, Object>> response =
                handler.handleGenericException(new RuntimeException("boom"), request);

        assertEquals(HttpStatus.INTERNAL_SERVER_ERROR, response.getStatusCode());
        assertNotNull(response.getBody());
        assertEquals(500, response.getBody().get("status"));
        assertEquals("Internal Server Error", response.getBody().get("error"));
        assertEquals("Unexpected internal error", response.getBody().get("message"));
        assertEquals("/v1/region", response.getBody().get("path"));
    }
}
