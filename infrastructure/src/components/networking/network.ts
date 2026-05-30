import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

export interface NetworkArgs {
  cidrBlock: string;
  azCount?: number;
  enableFlowLogs?: boolean;
  tags?: Record<string, string>;
}

/**
 * VPC with public + private subnets across `azCount` AZs, an internet gateway,
 * one NAT gateway per AZ, and route tables — all provided by `awsx.ec2.Vpc`
 * (which also handles CIDR splitting). Optional VPC flow logs to CloudWatch.
 *
 * The public surface (`vpcId`, `vpcCidrBlock`, `publicSubnetIds`,
 * `privateSubnetIds`) is kept stable so consumers don't depend on awsx types.
 */
export class NetworkComponent extends pulumi.ComponentResource {
  public readonly vpc: awsx.ec2.Vpc;
  public readonly vpcId: pulumi.Output<string>;
  public readonly vpcCidrBlock: pulumi.Output<string>;

  private readonly _publicSubnetIds: pulumi.Output<string>[];
  private readonly _privateSubnetIds: pulumi.Output<string>[];

  constructor(name: string, args: NetworkArgs, opts?: pulumi.ComponentResourceOptions) {
    super("aws-multi-region:network:Network", name, {}, opts);

    const childOpts = { parent: this };
    const baseTags = args.tags ?? {};
    const azCount = args.azCount ?? 2;
    const enableFlowLogs = args.enableFlowLogs ?? true;

    this.vpc = new awsx.ec2.Vpc(
      `${name}-vpc`,
      {
        cidrBlock: args.cidrBlock,
        numberOfAvailabilityZones: azCount,
        enableDnsHostnames: true,
        enableDnsSupport: true,
        // One NAT gateway per AZ for high availability (matches the prior design).
        natGateways: { strategy: "OnePerAz" },
        subnetStrategy: "Auto",
        subnetSpecs: [
          {
            type: "Public",
            cidrMask: 20,
            tags: { ...baseTags, Tier: "public", "kubernetes.io/role/elb": "1" },
          },
          {
            type: "Private",
            cidrMask: 20,
            tags: { ...baseTags, Tier: "private", "kubernetes.io/role/internal-elb": "1" },
          },
        ],
        tags: { ...baseTags, Name: `${name}-vpc` },
      },
      childOpts,
    );

    this.vpcId = this.vpc.vpcId;
    this.vpcCidrBlock = pulumi.output(args.cidrBlock);

    // awsx exposes subnet IDs as a single Output<string[]>. Re-shape into a
    // fixed-length Output<string>[] so downstream args (Input<string>[]) are
    // unchanged from the hand-rolled version.
    this._publicSubnetIds = Array.from({ length: azCount }, (_, i) =>
      this.vpc.publicSubnetIds.apply((ids) => ids[i]),
    );
    this._privateSubnetIds = Array.from({ length: azCount }, (_, i) =>
      this.vpc.privateSubnetIds.apply((ids) => ids[i]),
    );

    if (enableFlowLogs) {
      const logGroup = new aws.cloudwatch.LogGroup(
        `${name}-flow-logs`,
        {
          retentionInDays: 30,
          tags: baseTags,
        },
        childOpts,
      );

      const flowRole = new aws.iam.Role(
        `${name}-flow-logs-role`,
        {
          assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
            Service: "vpc-flow-logs.amazonaws.com",
          }),
          tags: baseTags,
        },
        childOpts,
      );

      const flowPolicy = logGroup.arn.apply((arn) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: [
                "logs:CreateLogStream",
                "logs:PutLogEvents",
                "logs:DescribeLogStreams",
                "logs:DescribeLogGroups",
              ],
              Resource: [arn, `${arn}:*`],
            },
          ],
        }),
      );

      new aws.iam.RolePolicy(
        `${name}-flow-logs-policy`,
        {
          role: flowRole.id,
          policy: flowPolicy,
        },
        childOpts,
      );

      new aws.ec2.FlowLog(
        `${name}-flow-log`,
        {
          iamRoleArn: flowRole.arn,
          logDestination: logGroup.arn,
          trafficType: "ALL",
          vpcId: this.vpcId,
          tags: baseTags,
        },
        childOpts,
      );
    }

    this.registerOutputs({
      vpc_id: this.vpcId,
      vpc_cidr: this.vpcCidrBlock,
      public_subnet_ids: this._publicSubnetIds,
      private_subnet_ids: this._privateSubnetIds,
    });
  }

  get publicSubnetIds(): pulumi.Output<string>[] {
    return this._publicSubnetIds;
  }

  get privateSubnetIds(): pulumi.Output<string>[] {
    return this._privateSubnetIds;
  }
}
