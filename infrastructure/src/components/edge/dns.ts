import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface FailoverTarget {
  setIdentifier: string;
  /** PRIMARY receives 100% of traffic while healthy; SECONDARY is the DR standby. */
  failoverRole: "PRIMARY" | "SECONDARY";
  dnsName: pulumi.Input<string>;
  zoneId: pulumi.Input<string>;
  /**
   * Public FQDN that Route 53 health-checks (the regional API Gateway
   * execute-api endpoint). When set, a Route 53 health check is created and
   * attached to this record so failover is driven by the region's health.
   */
  healthCheckFqdn?: pulumi.Input<string>;
  /** Resource path (including stage) probed by the health check, e.g. /v1/health. */
  healthCheckPath?: pulumi.Input<string>;
}

export interface FailoverRecordsArgs {
  hostedZoneId: pulumi.Input<string>;
  recordName: string;
  targets: FailoverTarget[];
  tags?: Record<string, string>;
}

/**
 * Active-passive (failover) routing for the global API endpoint.
 *
 * Route 53 sends 100% of traffic to the PRIMARY region (Virginia) while its
 * health check passes. If the primary becomes unhealthy, Route 53 fails the
 * record over to the SECONDARY region (Oregon).
 */
export class FailoverRecordsComponent extends pulumi.ComponentResource {
  public readonly records: aws.route53.Record[] = [];
  public readonly healthChecks: aws.route53.HealthCheck[] = [];

  constructor(name: string, args: FailoverRecordsArgs, opts?: pulumi.ComponentResourceOptions) {
    super("aws-multi-region:dns:FailoverRecords", name, {}, opts);

    const childOpts = { parent: this };
    const baseTags = args.tags ?? {};

    for (const target of args.targets) {
      let healthCheckId: pulumi.Input<string> | undefined;

      if (target.healthCheckFqdn) {
        const healthCheck = new aws.route53.HealthCheck(
          `${name}-${target.setIdentifier}-hc`,
          {
            type: "HTTPS",
            fqdn: target.healthCheckFqdn,
            port: 443,
            resourcePath: target.healthCheckPath ?? "/",
            requestInterval: 30,
            failureThreshold: 3,
            tags: { ...baseTags, Name: `${name}-${target.setIdentifier}-hc` },
          },
          childOpts,
        );
        this.healthChecks.push(healthCheck);
        healthCheckId = healthCheck.id;
      }

      const record = new aws.route53.Record(
        `${name}-${target.setIdentifier}`,
        {
          zoneId: args.hostedZoneId,
          name: args.recordName,
          type: "A",
          setIdentifier: target.setIdentifier,
          failoverRoutingPolicies: [{ type: target.failoverRole }],
          healthCheckId,
          aliases: [
            {
              name: target.dnsName,
              zoneId: target.zoneId,
              evaluateTargetHealth: false,
            },
          ],
        },
        childOpts,
      );

      this.records.push(record);
    }

    this.registerOutputs({
      record_fqdns: this.records.map((r) => r.fqdn),
      health_check_ids: this.healthChecks.map((h) => h.id),
    });
  }
}
