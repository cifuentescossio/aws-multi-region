import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface SecurityGroupsArgs {
  vpcId: pulumi.Input<string>;
  /** Port the ALB backend listener accepts ingress on (from the NLB bridge). */
  appPort: number;
  /** Backend task ports the ALB forwards to (e.g. [8080, 3000] for v1/v2). */
  taskPorts?: number[];
  albIngressCidrs?: string[];
  dbPort?: number;
  tags?: Record<string, string>;
}

export class SecurityGroupsComponent extends pulumi.ComponentResource {
  public readonly alb: aws.ec2.SecurityGroup;
  public readonly ecsTasks: aws.ec2.SecurityGroup;
  public readonly database: aws.ec2.SecurityGroup;

  constructor(name: string, args: SecurityGroupsArgs, opts?: pulumi.ComponentResourceOptions) {
    super("aws-multi-region:security:SecurityGroups", name, {}, opts);

    const childOpts = { parent: this };
    const baseTags = args.tags ?? {};
    const albIngressCidrs = args.albIngressCidrs ?? ["10.0.0.0/8"];
    const dbPort = args.dbPort ?? 5432;
    // Dedupe so we don't create duplicate rules when v1/v2 share a port.
    const taskPorts = Array.from(new Set(args.taskPorts ?? [args.appPort]));

    this.alb = new aws.ec2.SecurityGroup(
      `${name}-alb-sg`,
      {
        vpcId: args.vpcId,
        description: "Private ALB ingress from trusted CIDRs",
        ingress: [
          {
            protocol: "tcp",
            fromPort: 80,
            toPort: 80,
            cidrBlocks: albIngressCidrs,
            description: "HTTP from trusted network",
          },
          {
            protocol: "tcp",
            fromPort: 443,
            toPort: 443,
            cidrBlocks: albIngressCidrs,
            description: "HTTPS from trusted network",
          },
          {
            protocol: "tcp",
            fromPort: args.appPort,
            toPort: args.appPort,
            cidrBlocks: albIngressCidrs,
            description: `Backend listener from trusted network on ${args.appPort}`,
          },
        ],
        egress: [
          {
            protocol: "-1",
            fromPort: 0,
            toPort: 0,
            cidrBlocks: ["0.0.0.0/0"],
            description: "Allow all egress",
          },
        ],
        tags: { ...baseTags, Name: `${name}-alb-sg` },
      },
      childOpts,
    );

    this.ecsTasks = new aws.ec2.SecurityGroup(
      `${name}-ecs-tasks-sg`,
      {
        vpcId: args.vpcId,
        description: "ECS Fargate tasks (ingress from private ALB only)",
        egress: [
          {
            protocol: "-1",
            fromPort: 0,
            toPort: 0,
            cidrBlocks: ["0.0.0.0/0"],
            description: "Allow all egress (image pulls, AWS APIs)",
          },
        ],
        tags: { ...baseTags, Name: `${name}-ecs-tasks-sg` },
      },
      childOpts,
    );

    for (const port of taskPorts) {
      new aws.ec2.SecurityGroupRule(
        `${name}-ecs-tasks-from-alb-${port}`,
        {
          type: "ingress",
          securityGroupId: this.ecsTasks.id,
          sourceSecurityGroupId: this.alb.id,
          protocol: "tcp",
          fromPort: port,
          toPort: port,
          description: `ALB - tasks on port ${port}`,
        },
        childOpts,
      );
    }

    this.database = new aws.ec2.SecurityGroup(
      `${name}-database-sg`,
      {
        vpcId: args.vpcId,
        description: "Aurora PostgreSQL ingress from ECS tasks only",
        egress: [
          {
            protocol: "-1",
            fromPort: 0,
            toPort: 0,
            cidrBlocks: ["0.0.0.0/0"],
            description: "Allow all egress",
          },
        ],
        tags: { ...baseTags, Name: `${name}-database-sg` },
      },
      childOpts,
    );

    new aws.ec2.SecurityGroupRule(
      `${name}-db-from-ecs`,
      {
        type: "ingress",
        securityGroupId: this.database.id,
        sourceSecurityGroupId: this.ecsTasks.id,
        protocol: "tcp",
        fromPort: dbPort,
        toPort: dbPort,
        description: `ECS tasks - database on port ${dbPort}`,
      },
      childOpts,
    );

    this.registerOutputs({
      alb_sg_id: this.alb.id,
      ecs_tasks_sg_id: this.ecsTasks.id,
      database_sg_id: this.database.id,
    });
  }
}
