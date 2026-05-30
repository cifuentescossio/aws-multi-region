package com.example.legacyapi.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

@Service
public class AwsRegionService {

    private static final Logger log = LoggerFactory.getLogger(AwsRegionService.class);

    private static final String IMDS_TOKEN_URL = "http://169.254.169.254/latest/api/token";
    private static final String IMDS_REGION_URL = "http://169.254.169.254/latest/meta-data/placement/region";
    private static final Duration IMDS_TIMEOUT = Duration.ofMillis(500);

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(IMDS_TIMEOUT)
            .build();

    public String getRegion() {
        // 1. Check AWS_REGION environment variable
        String region = System.getenv("AWS_REGION");
        if (region != null && !region.isBlank()) {
            log.debug("Resolved region from AWS_REGION env var: {}", region);
            return region;
        }

        // 2. Check AWS_DEFAULT_REGION environment variable
        region = System.getenv("AWS_DEFAULT_REGION");
        if (region != null && !region.isBlank()) {
            log.debug("Resolved region from AWS_DEFAULT_REGION env var: {}", region);
            return region;
        }

        // 3. Try EC2 Instance Metadata Service (IMDSv2)
        try {
            String token = fetchImdsToken();
            region = fetchRegionFromImds(token);
            if (region != null && !region.isBlank()) {
                log.debug("Resolved region from IMDS: {}", region);
                return region;
            }
        } catch (Exception e) {
            log.debug("IMDS not available, falling back to unknown: {}", e.getMessage());
        }

        // 4. Fallback
        log.warn("Could not resolve AWS region; returning 'unknown'");
        return "unknown";
    }

    private String fetchImdsToken() throws IOException, InterruptedException {
        HttpRequest tokenRequest = HttpRequest.newBuilder()
                .uri(URI.create(IMDS_TOKEN_URL))
                .timeout(IMDS_TIMEOUT)
                .PUT(HttpRequest.BodyPublishers.noBody())
                .header("X-aws-ec2-metadata-token-ttl-seconds", "21600")
                .build();

        HttpResponse<String> tokenResponse = httpClient.send(tokenRequest, HttpResponse.BodyHandlers.ofString());
        return tokenResponse.body();
    }

    private String fetchRegionFromImds(String token) throws IOException, InterruptedException {
        HttpRequest regionRequest = HttpRequest.newBuilder()
                .uri(URI.create(IMDS_REGION_URL))
                .timeout(IMDS_TIMEOUT)
                .GET()
                .header("X-aws-ec2-metadata-token", token)
                .build();

        HttpResponse<String> regionResponse = httpClient.send(regionRequest, HttpResponse.BodyHandlers.ofString());
        return regionResponse.body();
    }
}
