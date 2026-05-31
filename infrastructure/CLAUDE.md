# CLAUDE.md — infrastructure (Pulumi / TypeScript)

Infrastructure as code in **Pulumi + TypeScript** for the multi-region **active-passive (pilot
light DR)** pattern. Deploys VPC, private ALB, API Gateway REST + WAF, ECS Fargate, and Aurora
PostgreSQL Global. Read `README.md` (in this folder) and the root one before touching architecture.

## Commands

```bash
npm install
npm run build        # tsc
npm run check        # tsc --noEmit (fast typecheck)

pulumi preview --stack <stack>   # plan; posted as a PR comment in CI
pulumi up --stack <stack>
```

## Stacks

| Stack           | Kind     | Region      | Role                                         |
| --------------- | -------- | ----------- | -------------------------------------------- |
| `prod-virginia` | regional | us-east-1   | PRIMARY (Aurora writer, health-checked)      |
| `prod-oregon`   | regional | us-west-2   | SECONDARY (Aurora replica, pilot light)      |
| `prod-global`   | global   | us-east-1   | Route 53 failover + health check             |

The two regionals are **identical**, driven by config (`region_key`, `aws:region`). The global
stack consumes both via `StackReference.getOutput`.

## Layout

```
src/
  index.ts              # thin entrypoint: load() -> dispatch regional/global -> FLAT outputs
  config.ts             # typed loader (shared.config.yaml + per-stack Pulumi config)
  stacks/
    types.ts            # ProgramOutputs (shared output shape)
    regional.ts         # builds a regional stack
    global.ts           # builds the global stack (Route 53)
  components/
    index.ts            # barrel re-exporting every component
    networking/ {network.ts, security.ts}
    edge/       {alb.ts, apigw.ts, dns.ts}
    compute/    {ecs.ts, ecs-service.ts}
    data/       {database.ts}
shared.config.yaml      # single source of truth for shared defaults
Pulumi.<stack>.yaml     # per-stack config
```

## Conventions

- **FLAT stack outputs** (`export const vpc_id = ...` in `index.ts`), not nested under one object:
  the global stack reads them by name via `StackReference.getOutput`. If you add an output, export
  it flat and, if the global stack consumes it, also add it to `ProgramOutputs` in `types.ts`.
- **Parameterized components, never hardcode region/account**: anything region-specific comes in
  through `config.ts` from `shared.config.yaml` or the stack config. Keep both regionals
  deployable from the same code.
- **All new config goes through the typed loader** in `config.ts`; do not read `process.env` or the
  YAML directly from components.
- **Name resources with `region_key`** to avoid collisions between stacks.
- **Fixed ingress chain:** `API Gateway REST → VPC Link → internal NLB → private ALB`. The L7
  v1/v2 split is done by the ALB (`/api/v1/*`→8080, `/api/v2/*`→3000). The NLB is just the L4
  bridge required by the REST API VPC Link — do not remove it (see README §8.2).
- **ECR is regional, created unconditionally:** `EcrComponent` makes one repo per backend, named
  after the backend's `app_name` (`legacy-api`, `new-api`), in **every** regional stack — same name
  across regions on purpose (separate regional namespaces, no collision), so the image is pushed to
  both and each region pulls locally. The backend `key` (v1/v2) stays the routing/contract identity
  (paths, target groups); `app_name` is the image/container identity. Created regardless of
  `ecs.service_enabled` (the repo must exist before an image can be pushed).
- **ECS service disabled by default** (`ecs.service_enabled: false`): it only deploys with the flag
  on and an `image_tag` (or full `image` override) set per backend. The container URI is **derived**
  from the in-region ECR repo (`<repoUrl>:<image_tag>`), so don't hardcode a region in the URI.
  `desiredCount` is governed by autoscaling — Pulumi **ignores changes** to that field, do not force it.
- **Auth = API Key + Usage Plan**, WAFv2 on the stage. `/health` is public (probed by Route 53).
  Do **not** implement a JWT authorizer unless explicitly asked (it's a future path, README §8.1).
- **Observability (`observability.*`):** when enabled, `EcsClusterComponent` creates a Secrets
  Manager secret for the Grafana OTLP auth header and grants the **task execution role**
  `secretsmanager:GetSecretValue` on it; `EcsServiceComponent` adds an ADOT **collector sidecar**
  (non-essential) to the task and injects `OTEL_*` env vars into the app container. Sidecars only
  appear when `ecs.service_enabled` is on (same gate as the services). The OTLP endpoint is plain
  config; the auth header is seeded as a Pulumi **secret**
  (`pulumi config set --secret aws-multi-region:grafana_otlp_auth <base64>`) and written to Secrets
  Manager — never put the token in YAML or code.
- Run `npm run check` before considering a type change done.
