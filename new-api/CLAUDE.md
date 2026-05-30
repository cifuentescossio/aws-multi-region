# CLAUDE.md — new-api (backend v2)

API service in **TypeScript / Node 20 / Express 4** that exposes the AWS region. This is the
**v2** backend; behind the ALB it serves `/api/v2/*` and listens on `PORT` (8080 locally, 3000 in
the infra). The legacy equivalent is `../legacy-api` (Java) — keep functional parity with it.

## Commands

```bash
npm install
npm run dev      # tsx src/index.ts (hot run)
npm run build    # tsc -> dist/
npm start        # node dist/index.js
npm test         # jest --runInBand
```

## Layout

```
src/
  index.ts                  # entrypoint: reads PORT, starts the server
  server.ts                 # createHttpServer(): http.Server + terminus (health at /v2/actuator/health)
  app.ts                    # Express instance, mounts /v2, 404 and 500 handlers
  routes/v2.ts              # router: GET /region, GET /actuator/info
  services/awsRegionService.ts  # getAwsRegion() — region resolution via env/IMDSv2
  __tests__/app.test.ts     # integration tests with supertest
```

## Conventions

- **All routes live under `/v2`** (mounted in `app.ts`). The terminus health check is
  `/v2/actuator/health`; info is `/v2/actuator/info`. Do not move these paths without aligning
  the ALB.
- **Errors as structured JSON** with the exact shape `{ timestamp, status, error, message, path }`
  (see `app.ts`). Reuse that format for any new error; the tests assert those fields.
- **Async errors → `next(error)`**, never respond via `res` directly inside a route's `catch`; the
  centralized 500 handler responds. Use `routes/v2.ts` as the pattern.
- **`getAwsRegion()` never throws**: it falls back to `"unknown"`. Order: `AWS_REGION` →
  `AWS_DEFAULT_REGION` → IMDSv2 (500 ms timeout via `AbortController`) → `"unknown"`.
- **`GET /v2/metrics/ping`** (`routes/v2.ts`) increments the OTEL counter
  `custom_endpoint_hits_total` (from `src/metrics.ts`) and returns
  `{ metric, status: 'recorded' }` — same contract as v1's `/v1/metrics/ping`.
- **Observability:** `src/telemetry.ts` boots `@opentelemetry/sdk-node` (traces + metrics + logs
  via OTLP). It is imported **first** in `index.ts` so auto-instrumentation patches `http`/`express`
  before they load, and is a **no-op** when `OTEL_SDK_DISABLED=true` or no
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set (so Jest and local runs don't start exporters). Export
  targets the collector sidecar via `OTEL_*` env vars — do not hardcode endpoints.
- **Strict TypeScript**, ESM, `import`/`export`. Type the Express handlers (`Request`, `Response`,
  `NextFunction`) as already done.
- **Tests use supertest against `createHttpServer()`**, not a real listening port; always restore
  env vars in `afterEach` (see `app.test.ts`).
- Minimal dependencies: only `express` and `@godaddy/terminus`. Do not add libraries without reason.
