# CLAUDE.md — legacy-api (backend v1)

API service in **Java 21 / Spring Boot 3.3** that exposes the AWS region. This is the **v1**
(legacy) backend; behind the ALB it serves `/v1/*` and listens on port `8080`. The modern
equivalent is `../new-api` (TypeScript) — keep functional parity with it.

## Commands

```bash
./mvnw spring-boot:run        # run locally (port 8080)
./mvnw clean package          # build the executable jar
./mvnw test                   # tests (JUnit + spring-boot-starter-test)
docker build -t legacy-api .  # container image
```

## Layout

```
src/main/java/com/example/legacyapi/
  LegacyApiApplication.java          # @SpringBootApplication
  controller/RegionController.java   # @RestController, @RequestMapping("/v1")
  service/AwsRegionService.java      # getRegion() — region resolution via env/IMDSv2
  exception/GlobalExceptionHandler.java  # @ControllerAdvice, errors as JSON
src/main/resources/application.properties
src/test/java/...                    # RegionControllerTest, GlobalExceptionHandlerTest
```

## Conventions

- **All endpoints live under `/v1`** (`@RequestMapping("/v1")`). Actuator is relocated to
  `/v1/actuator` (`management.endpoints.web.base-path`) and only exposes `health` and `info`.
  Do not change these paths without aligning the ALB and the health check.
- **`GET /region` returns `Map.of("region", region)`** as a JSON `ResponseEntity` — same contract
  as v2.
- **`GET /v1/metrics/ping`** (`MetricsController`) increments the OTEL `LongCounter`
  `custom_endpoint_hits_total` and returns `Map.of("metric", ..., "status", "recorded")` — same
  contract as v2's `/v2/metrics/ping`. The counter comes from `GlobalOpenTelemetry.getMeter(...)`
  (no-op when the agent is absent, so tests are unaffected).
- **Observability:** the OTEL Java agent is added in the `Dockerfile` (`-javaagent`) for zero-code
  auto-instrumentation; `opentelemetry-api` (via the OTEL BOM) is the only new dependency, used just
  for the custom counter. Export is driven by `OTEL_*` env vars set on the ECS task — do not
  hardcode endpoints.
- **Constructor injection** (no field `@Autowired`), final fields. Follow the `RegionController`
  pattern.
- **Centralized error handling** in `GlobalExceptionHandler` (`@ControllerAdvice`); the error JSON
  must stay consistent with v2 (`timestamp, status, error, message, path`).
  `spring.mvc.throw-exception-if-no-handler-found=true` and `add-mappings=false` are enabled so
  unknown routes reach the handler (404) instead of static resources.
- **`AwsRegionService.getRegion()` never propagates an exception**: it catches, logs via SLF4J at
  `debug`/`warn`, and falls back to `"unknown"`. Order: `AWS_REGION` → `AWS_DEFAULT_REGION` →
  IMDSv2 (PUT token + GET, 500 ms `Duration`) → `"unknown"`.
- **Log with SLF4J** (`LoggerFactory.getLogger`), never `System.out`.
- Do not bump the Spring Boot or Java version unless asked; it inherits from
  `spring-boot-starter-parent`.
