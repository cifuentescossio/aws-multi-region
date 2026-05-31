import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface EcsServiceArgs {
  /** ECS cluster ARN the service runs on. */
  clusterArn: pulumi.Input<string>;
  /** ECS cluster name (used to build the App Auto Scaling resourceId). */
  clusterName: pulumi.Input<string>;
  taskExecutionRoleArn: pulumi.Input<string>;
  taskRoleArn: pulumi.Input<string>;
  logGroupName: pulumi.Input<string>;
  region: pulumi.Input<string>;
  privateSubnetIds: pulumi.Input<string>[];
  securityGroupId: pulumi.Input<string>;
  /** ALB target group this service registers into (the v1 or v2 group). */
  targetGroupArn: pulumi.Input<string>;
  containerName: string;
  image: pulumi.Input<string>;
  containerPort: number;
  cpu: number;
  memory: number;
  /**
   * Desired/min running tasks. PRIMARY runs warm (e.g. 2); SECONDARY sits at
   * the pilot-light minimum (e.g. 1) and scales out on failover.
   */
  minCapacity: number;
  maxCapacity: number;
  cpuTargetUtilization: number;
  /**
   * When set, an OpenTelemetry (ADOT) Collector is added as a sidecar and the app
   * container gets the `OTEL_*` env vars pointing at it (http://localhost:4318).
   * The collector forwards OTLP traces/metrics/logs to Grafana Cloud.
   */
  observability?: {
    collectorImage: string;
    /** Grafana Cloud OTLP gateway base URL. */
    otlpEndpoint: pulumi.Input<string>;
    /** Secrets Manager ARN holding the base64 `instanceID:token` auth value. */
    authSecretArn: pulumi.Input<string>;
    collectorCpu: number;
    collectorMemoryReservation: number;
    /** Value for OTEL_SERVICE_NAME on the app container. */
    serviceName: string;
    /** Value for OTEL_RESOURCE_ATTRIBUTES on the app container. */
    resourceAttributes: pulumi.Input<string>;
  };
  tags?: Record<string, string>;
}

/**
 * A Fargate service for one backend (v1 or v2), wired to its ALB target group,
 * with App Auto Scaling target-tracking on CPU. This is the active-passive
 * compute layer: scaling out is automatic when traffic (and CPU) arrives.
 */
export class EcsServiceComponent extends pulumi.ComponentResource {
  public readonly taskDefinition: aws.ecs.TaskDefinition;
  public readonly service: aws.ecs.Service;
  public readonly scalableTarget: aws.appautoscaling.Target;
  public readonly cpuScalingPolicy: aws.appautoscaling.Policy;

  constructor(name: string, args: EcsServiceArgs, opts?: pulumi.ComponentResourceOptions) {
    super("aws-multi-region:ecs:Service", name, {}, opts);

    const childOpts = { parent: this };
    const baseTags = args.tags ?? {};

    const appContainer: Record<string, unknown> = {
      name: args.containerName,
      image: args.image,
      essential: true,
      portMappings: [{ containerPort: args.containerPort, protocol: "tcp" }],
      logConfiguration: {
        logDriver: "awslogs",
        options: {
          "awslogs-group": args.logGroupName,
          "awslogs-region": args.region,
          "awslogs-stream-prefix": args.containerName,
        },
      },
    };

    const containers: Record<string, unknown>[] = [appContainer];

    if (args.observability) {
      const obs = args.observability;

      // The app exports OTLP to the sidecar over the shared awsvpc loopback.
      appContainer.environment = [
        { name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "http://localhost:4318" },
        { name: "OTEL_EXPORTER_OTLP_PROTOCOL", value: "http/protobuf" },
        { name: "OTEL_SERVICE_NAME", value: obs.serviceName },
        { name: "OTEL_RESOURCE_ATTRIBUTES", value: obs.resourceAttributes },
        { name: "OTEL_TRACES_EXPORTER", value: "otlp" },
        { name: "OTEL_METRICS_EXPORTER", value: "otlp" },
        { name: "OTEL_LOGS_EXPORTER", value: "otlp" },
      ];
      // Start the collector before the app so early telemetry isn't dropped.
      appContainer.dependsOn = [{ containerName: "otel-collector", condition: "START" }];

      // ADOT reads its full pipeline config from AOT_CONFIG_CONTENT. Receives OTLP
      // on localhost and forwards to Grafana Cloud with Basic auth. The `\${env:..}`
      // placeholders are resolved by the collector at runtime, not by JS here.
      const collectorConfig = [
        "extensions:",
        "  health_check:",
        "    endpoint: 0.0.0.0:13133",
        "receivers:",
        "  otlp:",
        "    protocols:",
        "      grpc:",
        "        endpoint: 0.0.0.0:4317",
        "      http:",
        "        endpoint: 0.0.0.0:4318",
        "processors:",
        "  batch:",
        "    timeout: 5s",
        "exporters:",
        "  otlphttp/grafana:",
        "    endpoint: ${env:GRAFANA_OTLP_ENDPOINT}",
        "    headers:",
        "      Authorization: Basic ${env:GRAFANA_OTLP_AUTH}",
        "service:",
        "  extensions: [health_check]",
        "  pipelines:",
        "    traces:",
        "      receivers: [otlp]",
        "      processors: [batch]",
        "      exporters: [otlphttp/grafana]",
        "    metrics:",
        "      receivers: [otlp]",
        "      processors: [batch]",
        "      exporters: [otlphttp/grafana]",
        "    logs:",
        "      receivers: [otlp]",
        "      processors: [batch]",
        "      exporters: [otlphttp/grafana]",
      ].join("\n");

      containers.push({
        name: "otel-collector",
        image: obs.collectorImage,
        // Non-essential: a collector crash must not take the backend down.
        essential: false,
        cpu: obs.collectorCpu,
        memoryReservation: obs.collectorMemoryReservation,
        environment: [
          { name: "GRAFANA_OTLP_ENDPOINT", value: obs.otlpEndpoint },
          { name: "AOT_CONFIG_CONTENT", value: collectorConfig },
        ],
        secrets: [{ name: "GRAFANA_OTLP_AUTH", valueFrom: obs.authSecretArn }],
        portMappings: [
          { containerPort: 4317, protocol: "tcp" },
          { containerPort: 4318, protocol: "tcp" },
        ],
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": args.logGroupName,
            "awslogs-region": args.region,
            "awslogs-stream-prefix": "otel-collector",
          },
        },
      });
    }

    this.taskDefinition = new aws.ecs.TaskDefinition(
      `${name}-task`,
      {
        family: name,
        cpu: String(args.cpu),
        memory: String(args.memory),
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        executionRoleArn: args.taskExecutionRoleArn,
        taskRoleArn: args.taskRoleArn,
        containerDefinitions: pulumi.jsonStringify(containers),
        tags: { ...baseTags, Name: `${name}-task` },
      },
      childOpts,
    );

    this.service = new aws.ecs.Service(
      `${name}-svc`,
      {
        name,
        cluster: args.clusterArn,
        taskDefinition: this.taskDefinition.arn,
        desiredCount: args.minCapacity,
        launchType: "FARGATE",
        networkConfiguration: {
          subnets: args.privateSubnetIds,
          securityGroups: [args.securityGroupId],
          assignPublicIp: false,
        },
        loadBalancers: [
          {
            targetGroupArn: args.targetGroupArn,
            containerName: args.containerName,
            containerPort: args.containerPort,
          },
        ],
        // Generous grace period: Spring Boot (v1) cold-starts with the OTEL Java
        // agent attached, which can exceed 60s on Fargate before /actuator/health
        // returns 200. Avoids the task being killed by the ALB check mid-boot.
        healthCheckGracePeriodSeconds: 120,
        tags: { ...baseTags, Name: `${name}-svc` },
      },
      // Auto Scaling owns desiredCount after creation; don't let Pulumi fight it.
      { ...childOpts, ignoreChanges: ["desiredCount"] },
    );

    this.scalableTarget = new aws.appautoscaling.Target(
      `${name}-ast`,
      {
        serviceNamespace: "ecs",
        resourceId: pulumi.interpolate`service/${args.clusterName}/${this.service.name}`,
        scalableDimension: "ecs:service:DesiredCount",
        minCapacity: args.minCapacity,
        maxCapacity: args.maxCapacity,
      },
      childOpts,
    );

    this.cpuScalingPolicy = new aws.appautoscaling.Policy(
      `${name}-cpu-policy`,
      {
        policyType: "TargetTrackingScaling",
        serviceNamespace: this.scalableTarget.serviceNamespace,
        resourceId: this.scalableTarget.resourceId,
        scalableDimension: this.scalableTarget.scalableDimension,
        targetTrackingScalingPolicyConfiguration: {
          predefinedMetricSpecification: {
            predefinedMetricType: "ECSServiceAverageCPUUtilization",
          },
          targetValue: args.cpuTargetUtilization,
          scaleInCooldown: 60,
          scaleOutCooldown: 60,
        },
      },
      childOpts,
    );

    this.registerOutputs({
      task_definition_arn: this.taskDefinition.arn,
      service_name: this.service.name,
      scalable_target_resource_id: this.scalableTarget.resourceId,
    });
  }
}
