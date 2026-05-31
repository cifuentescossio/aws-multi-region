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
  /** AWS region this stack deploys to — the home region of the master secret. */
  awsRegion: string;
  isPrimary: boolean;
  /**
   * Regions to replicate the master secret into (e.g. ["us-west-2"]). Only honoured
   * on the PRIMARY: this stack owns the credentials, and Secrets Manager replicates a
   * read-only copy to each region here so the passive region's ECS tasks can read DB
   * credentials locally on failover. Empty/omitted disables replication.
   */
  secretReplicaRegions?: string[];
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
  /** ARN of the master secret in this stack's region (primary only). */
  public readonly masterSecretArn: pulumi.Output<string | undefined>;
  /** Map of replica region -> replicated secret ARN (primary only; empty otherwise). */
  public readonly masterSecretReplicaArns: pulumi.Output<Record<string, string>>;

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

    // A cross-region encrypted Aurora replica MUST be given an explicit KMS key in
    // its OWN region: the primary's key (in the primary region) is not usable here,
    // and AWS will not fall back to the regional default for a replica. We mint a
    // region-local CMK for the SECONDARY (with rotation) instead of relying on the
    // AWS-managed `aws/rds` key, which is created lazily and may not exist yet in a
    // brand-new passive region. The PRIMARY keeps using the region default.
    let secondaryKmsKeyArn: pulumi.Input<string> | undefined;
    if (!args.isPrimary) {
      const dbKmsKey = new aws.kms.Key(
        `${name}-kms`,
        {
          description: `Aurora cross-region replica encryption (${args.regionKey})`,
          deletionWindowInDays: 7,
          enableKeyRotation: true,
          tags: { ...baseTags, Name: `${name}-kms` },
        },
        childOpts,
      );
      new aws.kms.Alias(
        `${name}-kms-alias`,
        {
          name: `alias/${args.project}-${args.environment}-aurora-${args.regionKey}`,
          targetKeyId: dbKmsKey.keyId,
        },
        childOpts,
      );
      secondaryKmsKeyArn = dbKmsKey.arn;
    }

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
    }

    // Aurora Global databases do NOT support RDS-managed master passwords
    // (`manageMasterUserPassword`). Only the PRIMARY owns credentials, so we
    // generate the password ourselves and store it in a Secrets Manager secret we
    // control, replicated cross-region natively (see below) for failover. The
    // secondary is a read replica created without master credentials.
    const replicaRegions = args.isPrimary ? args.secretReplicaRegions ?? [] : [];
    let masterPassword: pulumi.Output<string> | undefined;
    let masterSecret: aws.secretsmanager.Secret | undefined;

    if (args.isPrimary) {
      // RDS rejects '/', '@', '"' and spaces in the master password, so restrict the
      // special-character set to a safe subset.
      const password = new random.RandomPassword(
        `${name}-master-pw`,
        {
          length: 32,
          special: true,
          overrideSpecial: "!#$%^&*()-_=+[]{}<>:?",
        },
        childOpts,
      );
      masterPassword = password.result;

      // Self-managed secret with native cross-region replication. Each replica keeps
      // the primary's name + random suffix, so the replica ARN is the primary ARN
      // with the region swapped (derived in masterSecretReplicaArns below).
      masterSecret = new aws.secretsmanager.Secret(
        `${name}-master-secret`,
        {
          namePrefix: `${args.project}-${args.environment}-aurora-master-`,
          description: "Aurora Global master credentials (self-managed)",
          replicas: replicaRegions.map((region) => ({ region })),
          tags: { ...baseTags, Name: `${name}-master-secret` },
        },
        childOpts,
      );

      new aws.secretsmanager.SecretVersion(
        `${name}-master-secret-version`,
        {
          secretId: masterSecret.id,
          secretString: pulumi.jsonStringify({
            username: masterUsername,
            password: masterPassword,
          }),
        },
        childOpts,
      );
    }

    this.cluster = new aws.rds.Cluster(
      `${name}-cluster`,
      {
        clusterIdentifier: `${name}-cluster`,
        engine: "aurora-postgresql",
        engineVersion,
        databaseName: args.isPrimary ? databaseName : undefined,
        masterUsername: args.isPrimary ? masterUsername : undefined,
        masterPassword: args.isPrimary ? masterPassword : undefined,
        dbSubnetGroupName: this.subnetGroup.name,
        vpcSecurityGroupIds: [args.databaseSecurityGroupId],
        storageEncrypted: true,
        // Secondary only: region-local CMK is required for the encrypted replica.
        // Primary leaves this undefined and uses the region's default RDS key.
        kmsKeyId: secondaryKmsKeyArn,
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

    this.masterSecretArn = pulumi.output(masterSecret?.arn);

    // Derive each replica ARN from the primary ARN by swapping the region: a
    // replicated secret keeps the primary's name + random suffix.
    if (masterSecret && replicaRegions.length > 0) {
      this.masterSecretReplicaArns = masterSecret.arn.apply((arn) =>
        Object.fromEntries(
          replicaRegions.map((region) => [
            region,
            arn.replace(`:${args.awsRegion}:`, `:${region}:`),
          ]),
        ),
      );
    } else {
      this.masterSecretReplicaArns = pulumi.output<Record<string, string>>({});
    }

    this.registerOutputs({
      db_subnet_group_name: this.subnetGroup.name,
      db_global_cluster_identifier: this.globalClusterIdentifier,
      db_global_cluster_arn: this.globalCluster?.arn,
      db_cluster_arn: this.cluster.arn,
      db_cluster_endpoint: this.cluster.endpoint,
      db_cluster_reader_endpoint: this.cluster.readerEndpoint,
      db_writer_instance_endpoint: this.writerInstance.endpoint,
      db_master_secret_arn: this.masterSecretArn,
      db_master_secret_replica_arns: this.masterSecretReplicaArns,
    });
  }
}
