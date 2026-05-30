# new-api (backend v2, TypeScript / Node 20 / Express 4)

Modern backend for the aws-multi-region workspace. Exposes the AWS region the service
runs in. Behind the ALB it serves `/api/v2/*` and listens on `PORT` (8080 locally by
default, 3000 in the infra). The legacy equivalent is [`../legacy-api`](../legacy-api)
(Java) — both keep **functional parity**: same observable contract, same region-resolution
logic.

## Overview

| Item            | Value                                                       |
| --------------- | ----------------------------------------------------------- |
| Stack           | TypeScript 5.7, Node 20, Express 4 (ESM, strict)            |
| Public path     | `/api/v2/*` (ALB path-based routing)                        |
| Listen port     | `PORT` env var, default `8080` (set to `3000` in the infra) |
| Internal prefix | `/v2` (all routes, including actuator)                      |
| Role            | v2 / modern backend                                         |
| Dependencies    | `express`, `@godaddy/terminus` (health checks) only         |
| Packaging       | Docker (multi-stage, non-root, `node:20-alpine`)            |

## API contract

Shared with v1 — if you change it here, assess the impact on `legacy-api` and on the
infrastructure (target groups, health checks, ALB routes).

| Method & path        | Response                                              |
| -------------------- | ----------------------------------------------------- |
| `GET /v2/region`     | `{ "region": "<aws-region>" }`                        |
| `GET /v2/actuator/health` | `{ "status": "UP" }` via terminus (probed downstream) |
| `GET /v2/actuator/info`   | App info (`name`, `description`, `version`)      |

Errors are returned as structured JSON with the shape
`{ timestamp, status, error, message, path }` — identical to v1. Unknown routes return a
`404` in that same shape; the centralized 500 handler responds to async errors forwarded
via `next(error)`.

### Region resolution

`getAwsRegion()` never throws — it degrades to `"unknown"`. Resolution order (identical
across both backends):

1. `AWS_REGION` environment variable
2. `AWS_DEFAULT_REGION` environment variable
3. IMDSv2 — PUT token + GET `169.254.169.254/latest/meta-data/placement/region`, 500 ms timeout (`AbortController`)
4. `"unknown"`

## Commands

```bash
npm install
npm run dev      # tsx src/index.ts (hot run)
npm run build    # tsc -> dist/
npm start        # node dist/index.js
npm test         # jest --runInBand
docker build -t new-api .   # container image (multi-stage, non-root)
```

## Smoke tests

```bash
# Region endpoint
curl -i http://localhost:8080/v2/region          # -> {"region":"unknown"} locally

# Health + info (under /v2)
curl -i http://localhost:8080/v2/actuator/health
curl -i http://localhost:8080/v2/actuator/info

# Unknown route -> centralized 404 JSON
curl -i http://localhost:8080/v2/does-not-exist
```

## Layout

```
new-api/
  package.json
  tsconfig.json
  jest.config.cjs
  Dockerfile                  # multi-stage build, runs as non-root, EXPOSE 8080
  src/
    index.ts                  # entrypoint: reads PORT, starts the server
    server.ts                 # createHttpServer(): http.Server + terminus health
    app.ts                    # Express instance, mounts /v2, 404 and 500 handlers
    routes/v2.ts              # router: GET /region, GET /actuator/info
    services/awsRegionService.ts  # getAwsRegion() — region resolution via env/IMDSv2
    __tests__/app.test.ts     # integration tests with supertest
```

## Conventions

See [`CLAUDE.md`](CLAUDE.md) for the full list. Highlights: all routes under `/v2`,
errors as structured JSON, async errors via `next(error)` (never respond from a route's
`catch`), strict TypeScript + ESM, supertest against `createHttpServer()` (no real port),
and minimal dependencies.
