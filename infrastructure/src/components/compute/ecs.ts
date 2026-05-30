import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface EcsClusterArgs {
  clusterName: string;
  logGroupName: string;
  logRetentionDays?: number;
  /**
   * When set, a Secrets Manager secret is created to hold the Grafana Cloud OTLP
   * auth header and the task execution role is granted read access to it (so the
   * collector sidecar can resolve it via container `secrets`). When omitted, no
   * observability secret or policy is created.
   */
  observability?: {
    /**
     * Optional initial value (base64 of `instanceID:token`). When provided, it is
     * written as a SecretVersion; when undefined the Secret is created empty for
     * you to populate out-of-band.
     */
    grafanaAuth?: pulumi.Input<string>;
  };
  tags?: Record<string, string>;
}

export class EcsClusterComponent extends pulumi.ComponentResource {
  public readonly cluster: aws.ecs.Cluster;
  public readonly capacityProviders: aws.ecs.ClusterCapacityProviders;
  public readonly logGroup: aws.cloudwatch.LogGroup;
  public readonly taskExecutionRole: aws.iam.Role;
  public readonly taskRole: aws.iam.Role;
  /** Secrets Manager secret holding the Grafana OTLP auth header (when enabled). */
  public readonly grafanaSecret?: aws.secretsmanager.Secret;

  constructor(name: string, args: EcsClusterArgs, opts?: pulumi.ComponentResourceOptions) {
    super("aws-multi-region:ecs:Cluster", name, {}, opts);

    const childOpts = { parent: this };
    const baseTags = args.tags ?? {};
    const retention = args.logRetentionDays ?? 30;

    this.logGroup = new aws.cloudwatch.LogGroup(
      `${name}-logs`,
      {
        name: args.logGroupName,
        retentionInDays: retention,
        tags: baseTags,
      },
      childOpts,
    );

    this.cluster = new aws.ecs.Cluster(
      `${name}-cluster`,
      {
        name: args.clusterName,
        settings: [{ name: "containerInsights", value: "enabled" }],
        tags: { ...baseTags, Name: args.clusterName },
      },
      childOpts,
    );

    this.capacityProviders = new aws.ecs.ClusterCapacityProviders(
      `${name}-capacity`,
      {
        clusterName: this.cluster.name,
        capacityProviders: ["FARGATE", "FARGATE_SPOT"],
        defaultCapacityProviderStrategies: [{
          capacityProvider: "FARGATE",
          weight: 1,
          base: 1,
        }],
      },
      childOpts,
    );

    const assumeRolePolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "ecs-tasks.amazonaws.com" },
          Action: "sts:AssumeRole",
        },
      ],
    });

    this.taskExecutionRole = new aws.iam.Role(
      `${name}-task-exec-role`,
      {
        assumeRolePolicy,
        tags: baseTags,
      },
      childOpts,
    );

    new aws.iam.RolePolicyAttachment(
      `${name}-task-exec-attach`,
      {
        role: this.taskExecutionRole.name,
        policyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
      },
      childOpts,
    );

    this.taskRole = new aws.iam.Role(
      `${name}-task-role`,
      {
        assumeRolePolicy,
        tags: baseTags,
      },
      childOpts,
    );

    // Observability: hold the Grafana Cloud OTLP auth header in Secrets Manager
    // so it is never baked into the task definition or the image. The execution
    // role (not the task role) resolves container `secrets` at launch time, so it
    // gets read access on this one ARN.
    if (args.observability) {
      this.grafanaSecret = new aws.secretsmanager.Secret(
        `${name}-grafana-otlp`,
        {
          name: `${args.clusterName}-grafana-otlp-auth`,
          description: "Grafana Cloud OTLP auth header (base64 of instanceID:token)",
          tags: baseTags,
        },
        childOpts,
      );

      if (args.observability.grafanaAuth !== undefined) {
        new aws.secretsmanager.SecretVersion(
          `${name}-grafana-otlp-version`,
          {
            secretId: this.grafanaSecret.id,
            secretString: args.observability.grafanaAuth,
          },
          childOpts,
        );
      }

      new aws.iam.RolePolicy(
        `${name}-task-exec-grafana-secret`,
        {
          role: this.taskExecutionRole.id,
          policy: this.grafanaSecret.arn.apply((arn) =>
            JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["secretsmanager:GetSecretValue"],
                  Resource: arn,
                },
              ],
            }),
          ),
        },
        childOpts,
      );
    }

    this.registerOutputs({
      cluster_arn: this.cluster.arn,
      cluster_name: this.cluster.name,
      task_execution_role_arn: this.taskExecutionRole.arn,
      task_role_arn: this.taskRole.arn,
      log_group_name: this.logGroup.name,
      grafana_secret_arn: this.grafanaSecret?.arn,
    });
  }
}
