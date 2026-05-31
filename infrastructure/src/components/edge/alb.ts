import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface AlbBackend {
  /** Logical key, e.g. "v1" or "v2". */
  key: string;
  /** ALB listener-rule path pattern matching what the service serves, e.g. /v1/*. */
  pathPattern: string;
  /** Port the backend tasks listen on (target group port), e.g. 8080 / 3000. */
  port: number;
  /** Target-group health path; falls back to the ALB-level `healthCheckPath`. */
  healthCheckPath?: string;
}

export interface AlbArgs {
  vpcId: pulumi.Input<string>;
  subnetIds: pulumi.Input<string>[];
  albSecurityGroupId: pulumi.Input<string>;
  hostedZoneId: pulumi.Input<string>;
  certificateDomain: string;
  certificateSans?: string[];
  /** Port the ALB backend listener accepts ingress on (from the NLB bridge). */
  appPort?: number;
  healthCheckPath?: string;
  /** Path-based routing backends (v1, v2, ...). Order sets rule priority. */
  backends: AlbBackend[];
  tags?: Record<string, string>;
}

export class AlbComponent extends pulumi.ComponentResource {
  public readonly certificate: aws.acm.Certificate;
  public readonly certificateValidation: aws.acm.CertificateValidation;
  public readonly loadBalancer: aws.lb.LoadBalancer;
  public readonly targetGroups: { key: string; targetGroup: aws.lb.TargetGroup }[] = [];
  public readonly targetGroupArns: pulumi.Output<Record<string, string>>;
  /** Per-backend listener rules; ECS services must depend on the matching rule. */
  public readonly listenerRules: { key: string; rule: aws.lb.ListenerRule }[] = [];
  public readonly httpsListener: aws.lb.Listener;
  public readonly httpListener: aws.lb.Listener;
  public readonly backendListener: aws.lb.Listener;

  constructor(name: string, args: AlbArgs, opts?: pulumi.ComponentResourceOptions) {
    super("aws-multi-region:alb:Alb", name, {}, opts);

    const childOpts = { parent: this };
    const baseTags = args.tags ?? {};
    const appPort = args.appPort ?? 8080;
    const healthCheckPath = args.healthCheckPath ?? "/health";

    if (args.backends.length === 0) {
      throw new pulumi.RunError(`ALB '${name}' requires at least one backend.`);
    }

    const sans = (args.certificateSans ?? []).filter((s) => s !== args.certificateDomain);
    const allDomains = [args.certificateDomain, ...sans];

    this.certificate = new aws.acm.Certificate(
      `${name}-cert`,
      {
        domainName: args.certificateDomain,
        subjectAlternativeNames: sans,
        validationMethod: "DNS",
        tags: baseTags,
      },
      { parent: this, deleteBeforeReplace: true },
    );

    const validationRecords: aws.route53.Record[] = [];
    for (let i = 0; i < allDomains.length; i++) {
      const record = new aws.route53.Record(
        `${name}-cert-validate-${i}`,
        {
          zoneId: args.hostedZoneId,
          name: this.certificate.domainValidationOptions.apply(
            (opts) => opts[i].resourceRecordName,
          ),
          type: this.certificate.domainValidationOptions.apply(
            (opts) => opts[i].resourceRecordType,
          ),
          records: [
            this.certificate.domainValidationOptions.apply(
              (opts) => opts[i].resourceRecordValue,
            ),
          ],
          ttl: 60,
          allowOverwrite: true,
        },
        childOpts,
      );
      validationRecords.push(record);
    }

    this.certificateValidation = new aws.acm.CertificateValidation(
      `${name}-cert-validation`,
      {
        certificateArn: this.certificate.arn,
        validationRecordFqdns: validationRecords.map((r) => r.fqdn),
      },
      childOpts,
    );

    this.loadBalancer = new aws.lb.LoadBalancer(
      `${name}-alb`,
      {
        name: `${name.substring(0, 28)}-alb`,
        internal: true,
        loadBalancerType: "application",
        securityGroups: [args.albSecurityGroupId],
        subnets: args.subnetIds,
        enableDeletionProtection: false,
        tags: { ...baseTags, Name: `${name}-alb` },
      },
      childOpts,
    );

    // One target group per backend (v1 -> Java/8080, v2 -> TS/3000, ...).
    for (const backend of args.backends) {
      const targetGroup = new aws.lb.TargetGroup(
        `${name}-${backend.key}-tg`,
        {
          name: `${name.substring(0, 24)}-${backend.key}-tg`,
          port: backend.port,
          protocol: "HTTP",
          targetType: "ip",
          vpcId: args.vpcId,
          healthCheck: {
            enabled: true,
            path: backend.healthCheckPath ?? healthCheckPath,
            protocol: "HTTP",
            matcher: "200-399",
            interval: 30,
            timeout: 5,
            healthyThreshold: 2,
            unhealthyThreshold: 3,
          },
          tags: { ...baseTags, Name: `${name}-${backend.key}-tg`, Backend: backend.key },
        },
        childOpts,
      );
      this.targetGroups.push({ key: backend.key, targetGroup });
    }

    this.targetGroupArns = pulumi
      .all(
        this.targetGroups.map((t) =>
          t.targetGroup.arn.apply((arn) => [t.key, arn] as [string, string]),
        ),
      )
      .apply((entries) => Object.fromEntries(entries));

    this.httpListener = new aws.lb.Listener(
      `${name}-http`,
      {
        loadBalancerArn: this.loadBalancer.arn,
        port: 80,
        protocol: "HTTP",
        defaultActions: [
          {
            type: "redirect",
            redirect: {
              port: "443",
              protocol: "HTTPS",
              statusCode: "HTTP_301",
            },
          },
        ],
        tags: baseTags,
      },
      childOpts,
    );

    this.httpsListener = new aws.lb.Listener(
      `${name}-https`,
      {
        loadBalancerArn: this.loadBalancer.arn,
        port: 443,
        protocol: "HTTPS",
        sslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
        certificateArn: this.certificateValidation.certificateArn,
        defaultActions: [
          {
            type: "fixed-response",
            fixedResponse: {
              contentType: "text/plain",
              messageBody: "No service registered",
              statusCode: "503",
            },
          },
        ],
        tags: baseTags,
      },
      childOpts,
    );

    // Backend listener reached via the NLB bridge; rules split v1/v2 traffic.
    this.backendListener = new aws.lb.Listener(
      `${name}-backend`,
      {
        loadBalancerArn: this.loadBalancer.arn,
        port: appPort,
        protocol: "HTTP",
        defaultActions: [
          {
            type: "fixed-response",
            fixedResponse: {
              contentType: "text/plain",
              messageBody: "No matching route",
              statusCode: "404",
            },
          },
        ],
        tags: baseTags,
      },
      childOpts,
    );

    args.backends.forEach((backend, i) => {
      const tg = this.targetGroups[i].targetGroup;
      const rule = new aws.lb.ListenerRule(
        `${name}-${backend.key}-rule`,
        {
          listenerArn: this.backendListener.arn,
          priority: (i + 1) * 10,
          actions: [
            {
              type: "forward",
              targetGroupArn: tg.arn,
            },
          ],
          conditions: [
            {
              pathPattern: {
                values: [backend.pathPattern],
              },
            },
          ],
          tags: { ...baseTags, Name: `${name}-${backend.key}-rule`, Backend: backend.key },
        },
        childOpts,
      );
      this.listenerRules.push({ key: backend.key, rule });
    });

    this.registerOutputs({
      alb_arn: this.loadBalancer.arn,
      alb_dns_name: this.loadBalancer.dnsName,
      alb_zone_id: this.loadBalancer.zoneId,
      https_listener_arn: this.httpsListener.arn,
      backend_listener_arn: this.backendListener.arn,
      target_group_arns: this.targetGroupArns,
      certificate_arn: this.certificate.arn,
      certificate_validation_arn: this.certificateValidation.certificateArn,
    });
  }
}
