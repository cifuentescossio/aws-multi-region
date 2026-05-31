import * as fs from "fs";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as yaml from "js-yaml";

export type StackKind = "regional" | "global";

export interface RegionSpec {
  key: string;
  aws_region: string;
  cidr: string;
}

export interface BackendSpec {
  key: string;
  path_pattern: string;
  port: number;
  /**
   * Full image URI override. Normally left unset: the image is derived from the
   * in-region ECR repo this stack creates (`<repoUrl>:<image_tag>`) so each region
   * pulls from its local registry. Set this only to pin an image from elsewhere.
   */
  image?: string;
  /** Tag to pull from the in-region ECR repo (e.g. "latest" or a git sha). */
  image_tag?: string;
}

export interface EcrConfig {
  /** IMMUTABLE blocks overwriting an existing tag (recommended). */
  image_tag_mutability: "MUTABLE" | "IMMUTABLE";
  /** Run a basic vulnerability scan on every push. */
  scan_on_push: boolean;
  /** Keep only the most recent N images (lifecycle policy). */
  max_image_count: number;
}

export interface EcsConfig {
  service_enabled: boolean;
  cpu: number;
  memory: number;
  cpu_target_utilization: number;
  /** Warm capacity in the PRIMARY (active) region. */
  min_capacity: number;
  /** Pilot-light capacity in the SECONDARY (passive) region. */
  passive_min_capacity: number;
  max_capacity: number;
}

export interface ObservabilityConfig {
  /** Master switch: when false, no collector sidecar and no OTEL env vars. */
  enabled: boolean;
  /** ADOT Collector image run as a sidecar in every backend task. */
  collector_image: string;
  /**
   * Grafana Cloud OTLP gateway base URL (no /v1/... suffix). The collector's
   * otlphttp exporter appends /v1/{traces,metrics,logs}. Not a secret.
   */
  otlp_endpoint: string;
  /** Soft CPU units reserved for the collector container (task total is unchanged). */
  collector_cpu: number;
  /** Soft memory (MiB) reserved for the collector container. */
  collector_memory_reservation: number;
}

export interface ApiGatewayConfig {
  enabled: boolean;
  stage_name: string;
  throttle_burst_limit: number;
  throttle_rate_limit: number;
  quota_limit: number;
  quota_period: "DAY" | "WEEK" | "MONTH";
  waf_rate_limit: number;
  waf_managed_common_enabled: boolean;
}

export interface SharedConfig {
  project: string;
  environment: string;
  domain: string;
  record_name: string;
  app_port: number;
  health_check_path: string;
  regions: Record<string, RegionSpec>;
  backends: BackendSpec[];
  ecr: EcrConfig;
  ecs: EcsConfig;
  api_gateway: ApiGatewayConfig;
  observability: ObservabilityConfig;
  tags: Record<string, string>;
}

export interface RegionalStackConfig {
  kind: "regional";
  shared: SharedConfig;
  region: RegionSpec;
  cert_sans: string[];
  enable_flow_logs: boolean;
  api_gateway: ApiGatewayConfig;
  /**
   * Grafana Cloud OTLP auth: the base64 of `instanceID:token` that goes into the
   * collector's `Authorization: Basic <...>` header. Seeded as a Pulumi secret
   * (`pulumi config set --secret aws-multi-region:grafana_otlp_auth <base64>`);
   * Pulumi writes it to Secrets Manager. Undefined when not set (Secret is then
   * created empty for you to populate out-of-band).
   */
  grafana_otlp_auth?: pulumi.Output<string>;
}

export interface GlobalStackConfig {
  kind: "global";
  shared: SharedConfig;
  virginia_stack: string;
  oregon_stack: string;
}

let sharedCache: SharedConfig | undefined;

function loadShared(): SharedConfig {
  if (sharedCache) {
    return sharedCache;
  }

  const sharedPath = path.join(__dirname, "..", "shared.config.yaml");
  const raw = yaml.load(fs.readFileSync(sharedPath, "utf8")) as {
    project: string;
    environment: string;
    domain: string;
    record_name: string;
    app_port: number;
    health_check_path: string;
    regions: Record<string, { aws_region: string; cidr: string }>;
    backends?: Record<string, { path_pattern: string; port: number; image?: string; image_tag?: string }>;
    ecr?: Partial<EcrConfig>;
    ecs?: Partial<EcsConfig>;
    api_gateway?: Partial<ApiGatewayConfig>;
    observability?: Partial<ObservabilityConfig>;
    tags?: Record<string, string>;
  };

  const regions: Record<string, RegionSpec> = {};
  for (const [key, spec] of Object.entries(raw.regions)) {
    regions[key] = {
      key,
      aws_region: spec.aws_region,
      cidr: spec.cidr,
    };
  }

  const backends: BackendSpec[] = [];
  for (const [key, spec] of Object.entries(raw.backends ?? {})) {
    backends.push({
      key,
      path_pattern: spec.path_pattern,
      port: Number(spec.port),
      image: spec.image,
      image_tag: spec.image_tag,
    });
  }

  const ecrRaw = raw.ecr ?? {};
  const ecr: EcrConfig = {
    image_tag_mutability:
      (ecrRaw.image_tag_mutability as "MUTABLE" | "IMMUTABLE" | undefined) ?? "IMMUTABLE",
    scan_on_push: ecrRaw.scan_on_push ?? true,
    max_image_count: Number(ecrRaw.max_image_count ?? 20),
  };

  const ecsRaw = raw.ecs ?? {};
  const ecs: EcsConfig = {
    service_enabled: ecsRaw.service_enabled ?? false,
    cpu: Number(ecsRaw.cpu ?? 512),
    memory: Number(ecsRaw.memory ?? 1024),
    cpu_target_utilization: Number(ecsRaw.cpu_target_utilization ?? 60),
    min_capacity: Number(ecsRaw.min_capacity ?? 2),
    passive_min_capacity: Number(ecsRaw.passive_min_capacity ?? 1),
    max_capacity: Number(ecsRaw.max_capacity ?? 10),
  };

  const obsRaw = raw.observability ?? {};
  const observability: ObservabilityConfig = {
    enabled: obsRaw.enabled ?? false,
    collector_image:
      obsRaw.collector_image ?? "public.ecr.aws/aws-observability/aws-otel-collector:v0.41.1",
    otlp_endpoint: obsRaw.otlp_endpoint ?? "",
    collector_cpu: Number(obsRaw.collector_cpu ?? 128),
    collector_memory_reservation: Number(obsRaw.collector_memory_reservation ?? 256),
  };

  const apiRaw = raw.api_gateway ?? {};
  const api_gateway: ApiGatewayConfig = {
    enabled: apiRaw.enabled ?? true,
    stage_name: apiRaw.stage_name ?? "v1",
    throttle_burst_limit: Number(apiRaw.throttle_burst_limit ?? 20),
    throttle_rate_limit: Number(apiRaw.throttle_rate_limit ?? 50),
    quota_limit: Number(apiRaw.quota_limit ?? 250000),
    quota_period: (apiRaw.quota_period as "DAY" | "WEEK" | "MONTH" | undefined) ?? "MONTH",
    waf_rate_limit: Number(apiRaw.waf_rate_limit ?? 2000),
    waf_managed_common_enabled: apiRaw.waf_managed_common_enabled ?? true,
  };

  sharedCache = {
    project: raw.project,
    environment: raw.environment,
    domain: raw.domain,
    record_name: raw.record_name,
    app_port: Number(raw.app_port),
    health_check_path: raw.health_check_path,
    regions,
    backends,
    ecr,
    ecs,
    api_gateway,
    observability,
    tags: raw.tags ?? {},
  };

  return sharedCache;
}

export function load(): RegionalStackConfig | GlobalStackConfig {
  const shared = loadShared();
  const cfg = new pulumi.Config();
  const kind = cfg.require("stack_kind") as StackKind;

  if (kind === "regional") {
    const regionKey = cfg.require("region_key");
    const region = shared.regions[regionKey];

    if (!region) {
      throw new pulumi.RunError(
        `region_key '${regionKey}' not present in shared.config.yaml regions.`,
      );
    }

    // Shared values are the source of truth; a per-stack Pulumi config key
    // overrides its shared default only when explicitly set.
    const sharedApi = shared.api_gateway;
    const quotaPeriod = cfg.get("api_gateway_quota_period");

    return {
      kind: "regional",
      shared,
      region,
      cert_sans: cfg.getObject<string[]>("cert_sans") ?? [shared.record_name],
      enable_flow_logs: cfg.getBoolean("enable_flow_logs") ?? true,
      grafana_otlp_auth: cfg.getSecret("grafana_otlp_auth"),
      api_gateway: {
        enabled: cfg.getBoolean("api_gateway_enabled") ?? sharedApi.enabled,
        stage_name: cfg.get("api_gateway_stage_name") ?? sharedApi.stage_name,
        throttle_burst_limit:
          cfg.getNumber("api_gateway_throttle_burst_limit") ?? sharedApi.throttle_burst_limit,
        throttle_rate_limit:
          cfg.getNumber("api_gateway_throttle_rate_limit") ?? sharedApi.throttle_rate_limit,
        quota_limit: cfg.getNumber("api_gateway_quota_limit") ?? sharedApi.quota_limit,
        quota_period: (quotaPeriod as "DAY" | "WEEK" | "MONTH" | undefined) ?? sharedApi.quota_period,
        waf_rate_limit: cfg.getNumber("api_gateway_waf_rate_limit") ?? sharedApi.waf_rate_limit,
        waf_managed_common_enabled:
          cfg.getBoolean("api_gateway_waf_managed_common_enabled") ?? sharedApi.waf_managed_common_enabled,
      },
    };
  }

  if (kind === "global") {
    return {
      kind: "global",
      shared,
      virginia_stack: cfg.require("virginia_stack"),
      oregon_stack: cfg.require("oregon_stack"),
    };
  }

  throw new pulumi.RunError(
    `Unknown stack_kind '${kind}' (expected 'regional' or 'global').`,
  );
}
