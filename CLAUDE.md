# CLAUDE.md — aws-multi-region monorepo

Monorepo for a **multi-region active-passive (pilot light DR)** backend architecture on AWS.
The same feature (return the AWS region the service runs in) is exposed by two versioned
backends behind an ALB with path-based routing, plus the infrastructure code that deploys them.

`README.md` (root) is the full **architecture design document** (in Spanish) and the source of
truth for decisions, trade-offs, and current state. Consult it before proposing architecture
changes.

## Projects

| Folder            | Stack                          | Public path  | Port            | Role                       |
| ----------------- | ------------------------------ | ------------ | --------------- | -------------------------- |
| `legacy-api/`     | Java 21 / Spring Boot 3.3      | `/api/v1/*`  | 8080            | Legacy backend (v1)        |
| `new-api/`        | TypeScript / Node 20 / Express | `/api/v2/*`  | 3000 (`PORT`)   | Modern backend (v2)        |
| `infrastructure/` | TypeScript / Pulumi            | —            | —               | IaC (VPC, ALB, API GW, ECS, Aurora, Route 53) |

Each project has its own `CLAUDE.md` with project-specific details and conventions.

## Cross-cutting rules

- **v1/v2 functional parity:** both backends expose the same observable contract —
  `GET /region` → `{ "region": "<aws-region>" }`, a health endpoint, an info endpoint under
  `actuator`, and `GET /metrics/ping` → `{ "metric": "custom_endpoint_hits_total", "status":
  "recorded" }` (increments a custom OTEL counter). If you change the contract in one, assess the
  impact on the other and on the infrastructure (target groups, health checks, ALB routes).
- **Observability:** both backends ship telemetry (traces, metrics, logs) to Grafana Cloud over
  OTLP through an OpenTelemetry (ADOT) **collector sidecar** added to each ECS task. Apps export to
  `http://localhost:4318`; the Grafana auth header lives in Secrets Manager (never in the repo).
  Keep instrumentation in parity: v1 uses the OTEL Java agent, v2 uses `@opentelemetry/sdk-node`.
- **Region resolution:** the logic is identical across both services and must stay that way:
  `AWS_REGION` → `AWS_DEFAULT_REGION` → IMDSv2 (PUT token + GET against `169.254.169.254`,
  500 ms timeout) → `"unknown"`. Never throw to the caller: degrade to `"unknown"`.
- **Language:** the design doc and business-level comments are in Spanish; code (identifiers,
  logs) is in English, matching what already exists.
- **Do not introduce new dependencies or services** (Redis, Kafka, JWT, EKS…) unless explicitly
  asked: `README.md` lists those as *future evolution paths*, not current work. (OpenTelemetry +
  Grafana Cloud was explicitly requested and is now part of the baseline.)
- **Path-filtered CI/CD:** pipelines trigger on path filters; a change should stay contained
  within its project's folder so it doesn't trigger unrelated builds.

## Current state (do not assume otherwise)

- The ECS service with autoscaling is **implemented but disabled** by default
  (`ecs.service_enabled: false`) until container images exist.
- API Gateway auth = **API Key + Usage Plan**. There is **no JWT** yet.
- Promotion of the secondary Aurora cluster is a **manual operational action** (not automatic).
