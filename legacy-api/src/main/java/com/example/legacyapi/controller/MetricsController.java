package com.example.legacyapi.controller;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.metrics.LongCounter;
import io.opentelemetry.api.metrics.Meter;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Custom metrics: GET /v1/metrics/ping increments an OTEL counter. Mirrors
 * /v2/metrics/ping. No-op when the OTEL agent is absent (tests/local).
 */
@RestController
@RequestMapping("/v1")
public class MetricsController {

    private static final AttributeKey<String> ENDPOINT = AttributeKey.stringKey("endpoint");
    private static final AttributeKey<String> SERVICE = AttributeKey.stringKey("service");

    private final LongCounter customEndpointHits;

    public MetricsController() {
        Meter meter = GlobalOpenTelemetry.getMeter("legacy-api");
        this.customEndpointHits = meter
                .counterBuilder("custom_endpoint_hits_total")
                .setDescription("Number of hits on the custom metrics endpoint")
                .build();
    }

    @GetMapping(value = "/metrics/ping", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, String>> ping() {
        customEndpointHits.add(1, Attributes.of(ENDPOINT, "ping", SERVICE, "legacy-api"));
        return ResponseEntity.ok(Map.of(
                "metric", "custom_endpoint_hits_total",
                "status", "recorded"));
    }
}
