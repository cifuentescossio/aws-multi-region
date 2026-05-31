# aws-multi-region-infra-ts (Pulumi, TypeScript)

Multi-region active-passive (pilot light DR) infrastructure for the aws-multi-region workspace.

## Stacks

| Stack          | Kind     | Region    | Purpose                                  |
| -------------- | -------- | --------- | ---------------------------------------- |
| `prod-virginia`| regional | us-east-1 | VPC, private ALB, API Gateway, WAF, ECS, Aurora primary (PRIMARY)  |
| `prod-oregon`  | regional | us-west-2 | VPC, private ALB, API Gateway, WAF, ECS, Aurora secondary (SECONDARY) |
| `prod-global`  | global   | us-east-1 | Route 53 failover records + health check for API Gateway |

The two regional stacks deploy identical components from `src/components` driven by
per-stack config (`region_key`, `aws:region`). The global stack consumes both
regionals via `StackReference` and creates failover-based ALIAS records in the
existing hosted zone `cifuentescossio.com`: Virginia is the PRIMARY (health-checked)
target and Oregon is the SECONDARY DR standby.

## Iteration 1 scope

- Networking: VPC (2 AZs, public + private subnets), IGW, NAT Gateway per AZ, route tables, optional flow logs.
- Security groups for the private ALB, ECS Fargate tasks, and Aurora PostgreSQL.
- ACM cert (DNS-validated) per region for `api.cifuentescossio.com`.
- Private ALB with **path-based routing** on the backend listener: `/api/v1/*` -> v1 target group (port 8080, legacy Java) and `/api/v2/*` -> v2 target group (port 3000, modern TS). Unmatched paths return 404; matched-but-empty target groups return 503 until ECS services attach. The HTTPS (443) listener returns 503 by default.
- Regional API Gateway REST API with API key + usage plan throttling (burst/rate/quota). Authentication is **API-key only** in this iteration — no JWT authorizer yet (planned, see design doc section 8.1). The public `/health` endpoint is exempt from the API key.
- Regional WAFv2 attached to API Gateway stage (AWS managed common rules + rate-based rule).
- VPC Link and private NLB bridge from API Gateway to private ALB.
- ECR repositories per backend (`<project>-v1`, `<project>-v2`), created **per region** (ECR is regional) so each region pulls images from its local registry. Immutable tags, scan-on-push, and a lifecycle policy keeping the last N images. Created **unconditionally** (independent of `ecs.service_enabled`) — the repo must exist before an image can be pushed.
- ECS Fargate cluster with capacity providers, log group, task execution + task IAM roles.
- ECS Fargate **service + App Auto Scaling** scaffolding per backend (target-tracking on CPU), wired to the v1/v2 ALB target groups. **Disabled by default** (`ecs.service_enabled: false`): it only deploys when enabled and an `image_tag` (or full `image` override) is set per backend. The container URI is derived from the in-region ECR repo (`<repoUrl>:<image_tag>`). Pilot light: PRIMARY runs warm at `min_capacity`, SECONDARY at `passive_min_capacity`.
- Aurora PostgreSQL Global Database with a primary writer in Virginia and a replicated secondary in Oregon.
- Public, unauthenticated `/health` endpoint on each API Gateway (proxied to the backend) for the Route 53 health check.
- Route 53 failover records pointing `api.cifuentescossio.com` to each regional API Gateway custom domain, with a health check on the Virginia (PRIMARY) endpoint driving automatic failover to Oregon (SECONDARY).

Out of scope (future iterations): container images / backend code (the ECS service scaffolding stays disabled until images exist), automated Aurora failover promotion, JWT authorizer (Cognito or Lambda), inter-region VPC peering, CloudFront.

## First deploy

```bash
cd infrastructure
npm install
npm run build

# Regional stacks
pulumi stack init prod-virginia && pulumi up --stack prod-virginia
pulumi stack init prod-oregon   && pulumi up --stack prod-oregon

infrastructure/
pulumi stack init prod-global   && pulumi up --stack prod-global
```

## Smoke tests

```bash
# Replace with the actual API key value from API Gateway.
API_KEY=<actual-api-key-value>

# Path-based routing: /api/v1/* -> legacy (Java) TG, /api/v2/* -> modern (TS) TG.
# (Custom domain maps the stage to root, so the stage name is NOT in the URL.)
curl -i -H "x-api-key: ${API_KEY}" https://api.cifuentescossio.com/api/v1/
curl -i -H "x-api-key: ${API_KEY}" https://api.cifuentescossio.com/api/v2/
# Without the API key the business paths are rejected (403):
curl -i https://api.cifuentescossio.com/api/v1/

# Public failover health endpoint (no API key) — what the Route 53 health check
# probes. Note: via the execute-api endpoint the path includes the stage
# (/v1/health), but via the custom domain it is /health.
curl -i https://api.cifuentescossio.com/health
dig +short api.cifuentescossio.com
```

Note: the API key output is the key identifier. Use the API Gateway console or CLI to retrieve and rotate key values in operational workflows.

## Layout

```
infrastructure/
  Pulumi.yaml
  Pulumi.prod-virginia.yaml
  Pulumi.prod-oregon.yaml
  Pulumi.prod-global.yaml
  shared.config.yaml        # single source of truth for shared defaults (backends, ecs, api_gateway, ...)
  package.json
  tsconfig.json
  src/
    index.ts                # thin entry point: load() -> dispatch -> flat stack outputs
    config.ts               # typed config loader (shared.config.yaml + per-stack Pulumi config)
    stacks/
      types.ts              # ProgramOutputs (shared output shape)
      regional.ts           # builds a regional stack (VPC, ALB, API GW, ECS, Aurora)
      global.ts             # builds the global stack (Route 53 failover)
    components/
      index.ts              # barrel re-exporting every component
      networking/
        network.ts          # awsx.ec2.Vpc (subnets, NAT per AZ, route tables) + flow logs
        security.ts
      edge/
        alb.ts
        apigw.ts
        dns.ts
      compute/
        ecr.ts              # per-backend ECR repositories (regional)
        ecs.ts
        ecs-service.ts
      data/
        database.ts
```
