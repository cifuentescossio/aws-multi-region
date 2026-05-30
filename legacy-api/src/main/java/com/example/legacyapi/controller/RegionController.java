package com.example.legacyapi.controller;

import com.example.legacyapi.service.AwsRegionService;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/v1")
public class RegionController {

    private final AwsRegionService awsRegionService;

    public RegionController(AwsRegionService awsRegionService) {
        this.awsRegionService = awsRegionService;
    }

    @GetMapping(value = "/region", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, String>> getRegion() {
        String region = awsRegionService.getRegion();
        return ResponseEntity.ok(Map.of("region", region));
    }
}
