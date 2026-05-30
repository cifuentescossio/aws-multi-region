import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { GlobalStackConfig } from "../config";
import { FailoverRecordsComponent } from "../components";
import { ProgramOutputs } from "./types";

/**
 * Builds the global stack: Route 53 failover ALIAS records for the shared API
 * endpoint, consuming both regional stacks via StackReference.
 *
 * Active-passive: Virginia is PRIMARY (health-checked), Oregon is the SECONDARY
 * DR standby. Route 53 fails over to Oregon only when the Virginia health check
 * fails.
 */
export function buildGlobal(cfg: GlobalStackConfig): ProgramOutputs {
  const project = cfg.shared.project;
  const env = cfg.shared.environment;
  const namePrefix = `${project}-${env}-global`;

  const zone = aws.route53.getZoneOutput({ name: cfg.shared.domain });

  const virginia = new pulumi.StackReference(cfg.virginia_stack);
  const oregon = new pulumi.StackReference(cfg.oregon_stack);

  const records = new FailoverRecordsComponent(`${namePrefix}-failover`, {
    hostedZoneId: zone.zoneId,
    recordName: cfg.shared.record_name,
    targets: [
      {
        setIdentifier: "virginia",
        failoverRole: "PRIMARY",
        dnsName: virginia.getOutput("api_gateway_domain_name"),
        zoneId: virginia.getOutput("api_gateway_zone_id"),
        healthCheckFqdn: virginia.getOutput("api_gateway_health_fqdn"),
        healthCheckPath: virginia.getOutput("api_gateway_health_path"),
      },
      {
        setIdentifier: "oregon",
        failoverRole: "SECONDARY",
        dnsName: oregon.getOutput("api_gateway_domain_name"),
        zoneId: oregon.getOutput("api_gateway_zone_id"),
      },
    ],
  });

  return {
    hosted_zone_id: zone.zoneId,
    record_name: pulumi.output(cfg.shared.record_name),
    record_fqdns: records.records.map((r) => r.fqdn),
  };
}
