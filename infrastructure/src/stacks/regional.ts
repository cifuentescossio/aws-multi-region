import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { RegionalStackConfig } from "../config";
import {
  AlbComponent,
  ApiGatewayComponent,
  DatabaseComponent,
  EcrComponent,
  EcsClusterComponent,
  EcsServiceComponent,
  NetworkComponent,
  SecurityGroupsComponent,
} from "../components";
import { ProgramOutputs } from "./types";

/**
 * Builds one regional stack: VPC, security groups, private ALB, API Gateway,
 * ECS cluster (+ optional Fargate services), and the Aurora regional cluster.
 */
export function buildRegional(cfg: RegionalStackConfig): ProgramOutputs {
  const project = cfg.shared.project;
  const env = cfg.shared.environment;
  const regionKey = cfg.region.key;
  const namePrefix = `${project}-${env}-${regionKey}`;
  const baseTags = { ...cfg.shared.tags, Region: regionKey };

  const zone = aws.route53.getZoneOutput({ name: cfg.shared.domain });

  const network = new NetworkComponent(`${namePrefix}-net`, {
    cidrBlock: cfg.region.cidr,
    azCount: 2,
    enableFlowLogs: cfg.enable_flow_logs,
    tags: baseTags,
  });

  const sgs = new SecurityGroupsComponent(`${namePrefix}-sg`, {
    vpcId: network.vpcId,
    appPort: cfg.shared.app_port,
    taskPorts: cfg.shared.backends.map((b) => b.port),
    albIngressCidrs: [cfg.region.cidr],
    dbPort: 5432,
    tags: baseTags,
  });

  const alb = new AlbComponent(`${namePrefix}-alb`, {
    vpcId: network.vpcId,
    subnetIds: network.privateSubnetIds,
    albSecurityGroupId: sgs.alb.id,
    hostedZoneId: zone.zoneId,
    certificateDomain: cfg.shared.record_name,
    certificateSans: cfg.cert_sans,
    appPort: cfg.shared.app_port,
    healthCheckPath: cfg.shared.health_check_path,
    backends: cfg.shared.backends.map((b) => ({
      key: b.key,
      pathPattern: b.path_pattern,
      port: b.port,
      healthCheckPath: b.health_check_path,
    })),
    tags: baseTags,
  });

  const api = cfg.api_gateway.enabled
    ? new ApiGatewayComponent(`${namePrefix}-api`, {
        vpcId: network.vpcId,
        privateSubnetIds: network.privateSubnetIds,
        backendAlbArn: alb.loadBalancer.arn,
        backendPort: cfg.shared.app_port,
        apiDomainName: cfg.shared.record_name,
        certificateArn: alb.certificateValidation.certificateArn,
        stageName: cfg.api_gateway.stage_name,
        healthCheckPath: cfg.shared.health_check_path,
        throttleBurstLimit: cfg.api_gateway.throttle_burst_limit,
        throttleRateLimit: cfg.api_gateway.throttle_rate_limit,
        quotaLimit: cfg.api_gateway.quota_limit,
        quotaPeriod: cfg.api_gateway.quota_period,
        wafRateLimit: cfg.api_gateway.waf_rate_limit,
        enableManagedCommonRuleSet: cfg.api_gateway.waf_managed_common_enabled,
        tags: baseTags,
      }, { dependsOn: [alb.certificateValidation, alb.backendListener] })
    : undefined;

  // Per-backend ECR repositories. Regional (one copy per region) and created
  // unconditionally: the repo must exist before CI can push an image, and an
  // image must exist before the ECS service can be enabled. Names are identical
  // across regions on purpose (separate regional namespaces, no collision).
  const ecr = new EcrComponent(`${namePrefix}-ecr`, {
    backends: cfg.shared.backends.map((b) => ({
      key: b.key,
      name: b.app_name,
    })),
    imageTagMutability: cfg.shared.ecr.image_tag_mutability,
    scanOnPush: cfg.shared.ecr.scan_on_push,
    maxImageCount: cfg.shared.ecr.max_image_count,
    tags: baseTags,
  });

  const obs = cfg.shared.observability;
  const ecs = new EcsClusterComponent(`${namePrefix}-ecs`, {
    clusterName: `${namePrefix}-cluster`,
    logGroupName: `/ecs/${namePrefix}`,
    observability: obs.enabled
      ? { grafanaAuth: cfg.grafana_otlp_auth }
      : undefined,
    tags: baseTags,
  });

  // Active-passive compute layer (pilot light). Disabled unless service_enabled
  // is set and the backend has a container image. PRIMARY (Virginia) runs warm
  // at min_capacity; SECONDARY (Oregon) sits at passive_min_capacity and scales
  // out on failover via CPU target-tracking.
  const isPrimary = regionKey === "virginia";
  if (cfg.shared.ecs.service_enabled) {
    for (const backend of cfg.shared.backends) {
      // Effective image: an explicit full-URI override wins; otherwise derive the
      // in-region ECR URI from the repo this stack created plus the configured
      // tag, so each region pulls from its local registry. Skip the backend when
      // neither is set (nothing to run yet).
      const repo = ecr.repositories.find((r) => r.key === backend.key);
      const image: pulumi.Input<string> | undefined = backend.image
        ? backend.image
        : backend.image_tag && repo
          ? pulumi.interpolate`${repo.repository.repositoryUrl}:${backend.image_tag}`
          : undefined;
      if (!image) {
        continue;
      }
      const tg = alb.targetGroups.find((t) => t.key === backend.key);
      if (!tg) {
        continue;
      }
      new EcsServiceComponent(`${namePrefix}-${backend.key}-svc`, {
        clusterArn: ecs.cluster.arn,
        clusterName: ecs.cluster.name,
        taskExecutionRoleArn: ecs.taskExecutionRole.arn,
        taskRoleArn: ecs.taskRole.arn,
        logGroupName: ecs.logGroup.name,
        region: cfg.region.aws_region,
        privateSubnetIds: network.privateSubnetIds,
        securityGroupId: sgs.ecsTasks.id,
        targetGroupArn: tg.targetGroup.arn,
        containerName: backend.app_name,
        image,
        containerPort: backend.port,
        cpu: cfg.shared.ecs.cpu,
        memory: cfg.shared.ecs.memory,
        minCapacity: isPrimary
          ? cfg.shared.ecs.min_capacity
          : cfg.shared.ecs.passive_min_capacity,
        maxCapacity: cfg.shared.ecs.max_capacity,
        cpuTargetUtilization: cfg.shared.ecs.cpu_target_utilization,
        observability: obs.enabled && ecs.grafanaSecret
          ? {
              collectorImage: obs.collector_image,
              otlpEndpoint: obs.otlp_endpoint,
              authSecretArn: ecs.grafanaSecret.arn,
              collectorCpu: obs.collector_cpu,
              collectorMemoryReservation: obs.collector_memory_reservation,
              serviceName: `${project}-${backend.key}`,
              resourceAttributes:
                `service.namespace=${project},` +
                `deployment.environment=${env},` +
                `cloud.region=${cfg.region.aws_region},` +
                `region.key=${regionKey}`,
            }
          : undefined,
        tags: baseTags,
      });
    }
  }

  // On the PRIMARY, replicate the RDS-managed master secret into every OTHER region
  // (the passive region) so its ECS tasks can read DB credentials locally on failover.
  const secretReplicaRegions = isPrimary
    ? Object.values(cfg.shared.regions)
        .map((r) => r.aws_region)
        .filter((region) => region !== cfg.region.aws_region)
    : [];

  const database = new DatabaseComponent(`${namePrefix}-db`, {
    vpcId: network.vpcId,
    privateSubnetIds: network.privateSubnetIds,
    databaseSecurityGroupId: sgs.database.id,
    project: cfg.shared.project,
    environment: cfg.shared.environment,
    regionKey,
    awsRegion: cfg.region.aws_region,
    isPrimary,
    secretReplicaRegions,
    tags: baseTags,
  });

  return {
    vpc_id: network.vpcId,
    vpc_cidr: network.vpcCidrBlock,
    public_subnet_ids: network.publicSubnetIds,
    private_subnet_ids: network.privateSubnetIds,
    alb_sg_id: sgs.alb.id,
    ecs_tasks_sg_id: sgs.ecsTasks.id,
    database_sg_id: sgs.database.id,
    alb_arn: alb.loadBalancer.arn,
    alb_dns_name: alb.loadBalancer.dnsName,
    alb_zone_id: alb.loadBalancer.zoneId,
    https_listener_arn: alb.httpsListener.arn,
    target_group_arns: alb.targetGroupArns,
    certificate_arn: alb.certificate.arn,
    api_gateway_id: api?.restApi.id,
    api_gateway_stage: api?.stage.stageName,
    api_gateway_url: api ? pulumi.interpolate`https://${cfg.shared.record_name}/${api.stage.stageName}` : undefined,
    api_gateway_domain_name: api?.domainName.regionalDomainName,
    api_gateway_zone_id: api?.domainName.regionalZoneId,
    api_gateway_health_fqdn: api?.executeApiFqdn,
    api_gateway_health_path: api?.healthCheckResourcePath,
    api_gateway_api_key_id: api?.apiKey.id,
    api_gateway_usage_plan_id: api?.usagePlan.id,
    api_gateway_waf_arn: api?.webAcl.arn,
    api_gateway_vpclink_id: api?.vpcLink.id,
    backend_nlb_arn: api?.nlb.arn,
    ecr_repository_urls: ecr.repositoryUrls,
    ecs_cluster_arn: ecs.cluster.arn,
    ecs_cluster_name: ecs.cluster.name,
    ecs_task_execution_role_arn: ecs.taskExecutionRole.arn,
    ecs_task_role_arn: ecs.taskRole.arn,
    ecs_log_group_name: ecs.logGroup.name,
    grafana_secret_arn: ecs.grafanaSecret?.arn,
    db_subnet_group_name: database.subnetGroup.name,
    db_global_cluster_identifier: pulumi.output(database.globalClusterIdentifier),
    db_global_cluster_arn: database.globalCluster?.arn,
    db_cluster_arn: database.cluster.arn,
    db_cluster_endpoint: database.cluster.endpoint,
    db_cluster_reader_endpoint: database.cluster.readerEndpoint,
    db_writer_instance_endpoint: database.writerInstance.endpoint,
    db_master_secret_arn: database.masterSecretArn,
    db_master_secret_replica_arns: database.masterSecretReplicaArns,
    aws_region: pulumi.output(cfg.region.aws_region),
    region_key: pulumi.output(regionKey),
  };
}
