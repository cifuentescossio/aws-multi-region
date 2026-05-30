import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as random from "@pulumi/random";

export interface DatabaseArgs {
  vpcId: pulumi.Input<string>;
  privateSubnetIds: pulumi.Input<string>[];
  databaseSecurityGroupId: pulumi.Input<string>;
  project: string;
  environment: string;
  regionKey: string;
  isPrimary: boolean;
  databaseName?: string;
  masterUsername?: string;
  instanceClass?: string;
  engineVersion?: string;
  backupRetentionPeriod?: number;
  tags?: Record<string, string>;
}

export class DatabaseComponent extends pulumi.ComponentResource {
  public readonly subnetGroup: aws.rds.SubnetGroup;
  public readonly globalClusterIdentifier: string;
  public readonly globalCluster?: aws.rds.GlobalCluster;
  public readonly cluster: aws.rds.Cluster;
  public readonly writerInstance: aws.rds.ClusterInstance;
  public readonly masterPassword?: pulumi.Output<string>;

  constructor(name: string, args: DatabaseArgs, opts?: pulumi.ComponentResourceOptions) {
    super("aws-multi-region:database:Database", name, {}, opts);

    const childOpts = { parent: this };
    const baseTags = args.tags ?? {};
    const databaseName = args.databaseName ?? "awsmultiregionapp";
    const masterUsername = args.masterUsername ?? "dbadmin";
    const instanceClass = args.instanceClass ?? "db.r5.large";
    const engineVersion = args.engineVersion ?? "16.4"; 
    const backupRetentionPeriod = args.backupRetentionPeriod ?? 35;

    this.globalClusterIdentifier = `${args.project}-${args.environment}-aurora-pg-global`;

    this.subnetGroup = new aws.rds.SubnetGroup(
      `${name}-subnets`,
      {
        subnetIds: args.privateSubnetIds,
        tags: { ...baseTags, Name: `${name}-subnets` },
      },
      childOpts,
    );

    if (args.isPrimary) {
      this.globalCluster = new aws.rds.GlobalCluster(
        `${name}-global`,
        {
          globalClusterIdentifier: this.globalClusterIdentifier,
          engine: "aurora-postgresql",
          engineVersion,
          databaseName,
          deletionProtection: false,
          storageEncrypted: true,
          tags: { ...baseTags, Name: `${name}-global` },
        },
        childOpts,
      );

      const password = new random.RandomPassword(
        `${name}-master-password`,
        {
          length: 32,
          special: true,
          overrideSpecial: "!#$%&*()-_=+[]{}<>:?", 
        },
        childOpts,
      );

      this.masterPassword = password.result;
    }

    this.cluster = new aws.rds.Cluster(
      `${name}-cluster`,
      {
        clusterIdentifier: `${name}-cluster`,
        engine: "aurora-postgresql",
        engineVersion,
        databaseName: args.isPrimary ? databaseName : undefined,
        masterUsername: args.isPrimary ? masterUsername : undefined,
        masterPassword: args.isPrimary ? this.masterPassword : undefined,
        dbSubnetGroupName: this.subnetGroup.name,
        vpcSecurityGroupIds: [args.databaseSecurityGroupId],
        storageEncrypted: true,
        backupRetentionPeriod,
        copyTagsToSnapshot: true,
        deletionProtection: true,
        globalClusterIdentifier: args.isPrimary ? this.globalCluster?.id : this.globalClusterIdentifier,
        skipFinalSnapshot: true,
        applyImmediately: true,
        enabledCloudwatchLogsExports: ["postgresql"],
        tags: { ...baseTags, Name: `${name}-cluster` },
      },
      childOpts,
    );

    this.writerInstance = new aws.rds.ClusterInstance(
      `${name}-writer`,
      {
        identifier: `${name}-writer`,
        clusterIdentifier: this.cluster.id,
        instanceClass,
        engine: "aurora-postgresql",
        engineVersion: this.cluster.engineVersion,
        dbSubnetGroupName: this.subnetGroup.name,
        publiclyAccessible: false,
        autoMinorVersionUpgrade: true,
        applyImmediately: true,
        promotionTier: args.isPrimary ? 0 : 1,
        tags: { ...baseTags, Name: `${name}-writer` },
      },
      childOpts,
    );

    this.registerOutputs({
      db_subnet_group_name: this.subnetGroup.name,
      db_global_cluster_identifier: this.globalClusterIdentifier,
      db_global_cluster_arn: this.globalCluster?.arn,
      db_cluster_arn: this.cluster.arn,
      db_cluster_endpoint: this.cluster.endpoint,
      db_cluster_reader_endpoint: this.cluster.readerEndpoint,
      db_writer_instance_endpoint: this.writerInstance.endpoint,
      db_master_secret_arn: this.cluster.masterUserSecrets.apply((secrets) => secrets?.[0]?.secretArn),
    });
  }
}