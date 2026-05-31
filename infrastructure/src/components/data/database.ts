import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as command from "@pulumi/command";

export interface DatabaseArgs {
  vpcId: pulumi.Input<string>;
  privateSubnetIds: pulumi.Input<string>[];
  databaseSecurityGroupId: pulumi.Input<string>;
  project: string;
  environment: string;
  regionKey: string;
  /** AWS region this stack deploys to — the home region of the RDS-managed secret. */
  awsRegion: string;
  isPrimary: boolean;
  /**
   * Regions to replicate the RDS-managed master secret into (e.g. ["us-west-2"]).
   * Only honoured on the PRIMARY: RDS owns the secret in this stack's region, and
   * Secrets Manager replicates a read-only copy to each region here so the passive
   * region's ECS tasks can read DB credentials locally on failover. Empty/omitted
   * disables replication.
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
  /** ARN of the RDS-managed master secret in this stack's region (primary only). */
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

    this.cluster = new aws.rds.Cluster(
      `${name}-cluster`,
      {
        clusterIdentifier: `${name}-cluster`,
        engine: "aurora-postgresql",
        engineVersion,
        databaseName: args.isPrimary ? databaseName : undefined,
        masterUsername: args.isPrimary ? masterUsername : undefined,
        // RDS generates and rotates the master password in Secrets Manager. Only the
        // PRIMARY owns credentials; the Oregon secondary is a read replica with no master
        // secret of its own, so the secret is replicated cross-region below.
        manageMasterUserPassword: args.isPrimary ? true : undefined,
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

    this.masterSecretArn = this.cluster.masterUserSecrets.apply(
      (secrets) => secrets?.[0]?.secretArn,
    );

    // Replicate the RDS-managed master secret into the passive region(s). The AWS
    // provider has no field to add replicas to a secret RDS owns, so drive it with
    // the Secrets Manager CLI. `--force-overwrite-replica-secret` keeps it idempotent
    // (re-runs are a no-op); the delete hook removes the replica on teardown so the
    // primary secret can be deleted. Each replica keeps the primary's name + random
    // suffix, so the replica ARN is the primary ARN with the region swapped.
    //
    // Kept as a single `aws` invocation with the args baked in (no shell loops, env
    // vars, or `|| true`) so it runs identically under `/bin/sh -c` (CI) and `cmd /C`
    // (a local `pulumi up` on Windows). The delete runs before the cluster is torn
    // down (it depends on the secret ARN), so the replica still exists at that point.
    const replicaRegions = args.isPrimary ? args.secretReplicaRegions ?? [] : [];
    if (replicaRegions.length > 0) {
      const secretArn = this.masterSecretArn.apply((arn) => arn ?? "");
      const addReplicaArgs = replicaRegions.map((r) => `Region=${r}`).join(" ");
      const removeReplicaArgs = replicaRegions.join(" ");
      const replication = new command.local.Command(
        `${name}-secret-replication`,
        {
          create: pulumi.interpolate`aws secretsmanager replicate-secret-to-regions --secret-id "${secretArn}" --region ${args.awsRegion} --add-replica-regions ${addReplicaArgs} --force-overwrite-replica-secret`,
          delete: pulumi.interpolate`aws secretsmanager remove-regions-from-replication --secret-id "${secretArn}" --region ${args.awsRegion} --remove-replica-regions ${removeReplicaArgs}`,
          // Re-run if the secret identity changes.
          triggers: [this.masterSecretArn],
        },
        childOpts,
      );

      // Emit the replica ARNs only after replication is configured (depend on the
      // command), so consumers never wire a secret that doesn't exist yet.
      this.masterSecretReplicaArns = pulumi
        .all([this.masterSecretArn, replication.id])
        .apply(([primaryArn]) =>
          Object.fromEntries(
            replicaRegions.map((region) => [
              region,
              (primaryArn ?? "").replace(`:${args.awsRegion}:`, `:${region}:`),
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