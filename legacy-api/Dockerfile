# ── Build stage ────────────────────────────────────────────────────────────────
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app
# Cache dependencies first
COPY pom.xml .
RUN mvn dependency:go-offline -B
COPY src ./src
RUN mvn package -B -DskipTests

# ── Runtime stage ───────────────────────────────────────────────────────────────
FROM eclipse-temurin:21-jre-alpine
# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
# OpenTelemetry Java agent: zero-code auto-instrumentation (HTTP, JVM, Logback
# logs, traces). Pinned to align with opentelemetry-api 1.45.0 in pom.xml. It
# exports to the OTEL collector sidecar via the OTEL_* env vars set on the ECS
# task; with no endpoint configured it stays quiet. Disable with OTEL_SDK_DISABLED=true.
ADD https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/download/v2.11.0/opentelemetry-javaagent.jar /app/opentelemetry-javaagent.jar
RUN chown appuser:appgroup app.jar /app/opentelemetry-javaagent.jar
USER appuser
EXPOSE 8080
ENTRYPOINT ["java", "-javaagent:/app/opentelemetry-javaagent.jar", "-jar", "app.jar"]