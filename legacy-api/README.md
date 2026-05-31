# legacy-api (backend v1, Java 21 / Spring Boot 3.3)

Legacy backend for the aws-multi-region workspace. Exposes the AWS region the service
runs in. Behind the ALB it serves `/v1/*` and listens on port `8080`. The modern
equivalent is [`../new-api`](../new-api) (TypeScript) — both keep **functional parity**:
same observable contract, same region-resolution logic.

## Overview

| Item            | Value                                                        |
| --------------- | ------------------------------------------------------------ |
| Stack           | Java 21, Spring Boot 3.3 (`spring-boot-starter-parent` 3.3.0)|
| Public path     | `/v1/*` (ALB path-based routing)                             |
| Listen port     | `8080`                                                       |
| Internal prefix | `/v1` (all endpoints, including actuator)                    |
| Role            | v1 / legacy backend                                          |
| Packaging       | Executable JAR / Docker (non-root, `eclipse-temurin:21-jre`) |

## API contract

Shared with v2 — if you change it here, assess the impact on `new-api` and on the
infrastructure (target groups, health checks, ALB routes).

| Method & path        | Response                                              |
| -------------------- | ----------------------------------------------------- |
| `GET /v1/region`     | `{ "region": "<aws-region>" }`                        |
| `GET /v1/actuator/health` | Spring Boot Actuator health (probed downstream)  |
| `GET /v1/actuator/info`   | App info (`name`, `description`, `version`)      |

Errors are returned as JSON by a centralized `@ControllerAdvice` with the shape
`{ timestamp, status, error, message, path }` — identical to v2. Unknown routes reach
the handler as a `404` (`throw-exception-if-no-handler-found=true`, `add-mappings=false`).

### Region resolution

`AwsRegionService.getRegion()` never throws — it degrades to `"unknown"`. Resolution
order (identical across both backends):

1. `AWS_REGION` environment variable
2. `AWS_DEFAULT_REGION` environment variable
3. IMDSv2 — PUT token + GET `169.254.169.254/latest/meta-data/placement/region`, 500 ms timeout
4. `"unknown"`

## Commands

```bash
./mvnw spring-boot:run        # run locally (port 8080)
./mvnw clean package          # build the executable jar
./mvnw test                   # tests (JUnit + spring-boot-starter-test)
docker build -t legacy-api .  # container image (multi-stage, non-root)
```

## Smoke tests

```bash
# Region endpoint
curl -i http://localhost:8080/v1/region          # -> {"region":"unknown"} locally

# Health + info (actuator relocated under /v1)
curl -i http://localhost:8080/v1/actuator/health
curl -i http://localhost:8080/v1/actuator/info

# Unknown route -> centralized 404 JSON
curl -i http://localhost:8080/v1/does-not-exist
```

## Layout

```
legacy-api/
  pom.xml
  Dockerfile                  # multi-stage build, runs as non-root, EXPOSE 8080
  src/main/java/com/example/legacyapi/
    LegacyApiApplication.java          # @SpringBootApplication
    controller/RegionController.java   # @RestController, @RequestMapping("/v1")
    service/AwsRegionService.java      # getRegion() — region resolution via env/IMDSv2
    exception/GlobalExceptionHandler.java  # @ControllerAdvice, errors as JSON
  src/main/resources/application.properties  # port, actuator base-path, error handling
  src/test/java/...                    # RegionControllerTest, GlobalExceptionHandlerTest
```

## Conventions

See [`CLAUDE.md`](CLAUDE.md) for the full list. Highlights: all endpoints under `/v1`,
constructor injection with final fields, centralized error handling, SLF4J logging (never
`System.out`), and no Spring Boot - Java version bumps unless asked.
