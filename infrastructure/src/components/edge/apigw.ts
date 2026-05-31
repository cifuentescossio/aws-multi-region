import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface ApiGatewayArgs {
  vpcId: pulumi.Input<string>;
  privateSubnetIds: pulumi.Input<string>[];
  backendAlbArn: pulumi.Input<string>;
  backendPort: number;
  apiDomainName: string;
  certificateArn: pulumi.Input<string>;
  stageName: string;
  /** Backend health path proxied by the public /health endpoint (ALB-routable). */
  healthCheckPath: string;
  throttleBurstLimit: number;
  throttleRateLimit: number;
  quotaLimit: number;
  quotaPeriod: pulumi.Input<string>;
  wafRateLimit: number;
  enableManagedCommonRuleSet: boolean;
  tags?: Record<string, string>;
}

export class ApiGatewayComponent extends pulumi.ComponentResource {
  public readonly nlb: aws.lb.LoadBalancer;
  public readonly vpcLink: aws.apigateway.VpcLink;
  public readonly restApi: aws.apigateway.RestApi;
  public readonly deployment: aws.apigateway.Deployment;
  public readonly stage: aws.apigateway.Stage;
  public readonly apiKey: aws.apigateway.ApiKey;
  public readonly usagePlan: aws.apigateway.UsagePlan;
  public readonly webAcl: aws.wafv2.WebAcl;
  public readonly domainName: aws.apigateway.DomainName;
  /** Public execute-api FQDN that Route 53 health-checks for failover. */
  public readonly executeApiFqdn: pulumi.Output<string>;
  /** Resource path (including stage) of the public health endpoint, e.g. /v1/health. */
  public readonly healthCheckResourcePath: pulumi.Output<string>;

  constructor(name: string, args: ApiGatewayArgs, opts?: pulumi.ComponentResourceOptions) {
    super("aws-multi-region:apigw:ApiGateway", name, {}, opts);

    const childOpts = { parent: this };
    const baseTags = args.tags ?? {};

    this.nlb = new aws.lb.LoadBalancer(
      `${name}-nlb`,
      {
        name: `${name.substring(0, 28)}-nlb`,
        internal: true,
        loadBalancerType: "network",
        subnets: args.privateSubnetIds,
        enableDeletionProtection: false,
        tags: { ...baseTags, Name: `${name}-nlb` },
      },
      childOpts,
    );

    const albBridgeTargetGroup = new aws.lb.TargetGroup(
      `${name}-alb-bridge-tg`,
      {
        name: `${name.substring(0, 18)}-alb-bridge-tg`,
        port: args.backendPort,
        protocol: "TCP",
        targetType: "alb",
        vpcId: args.vpcId,
        tags: { ...baseTags, Name: `${name}-alb-bridge-tg` },
      },
      childOpts,
    );

    new aws.lb.TargetGroupAttachment(
      `${name}-alb-bridge-attachment`,
      {
        targetGroupArn: albBridgeTargetGroup.arn,
        targetId: args.backendAlbArn,
        port: args.backendPort,
      },
      childOpts,
    );

    new aws.lb.Listener(
      `${name}-nlb-listener`,
      {
        loadBalancerArn: this.nlb.arn,
        port: args.backendPort,
        protocol: "TCP",
        defaultActions: [
          {
            type: "forward",
            targetGroupArn: albBridgeTargetGroup.arn,
          },
        ],
      },
      childOpts,
    );

    this.vpcLink = new aws.apigateway.VpcLink(
      `${name}-vpclink`,
      {
        targetArn: this.nlb.arn,
        tags: { ...baseTags, Name: `${name}-vpclink` },
      },
      childOpts,
    );

    this.restApi = new aws.apigateway.RestApi(
      `${name}-rest`,
      {
        name: `${name}-rest`,
        endpointConfiguration: {
          types: "REGIONAL",
        },
        tags: baseTags,
      },
      childOpts,
    );

    const proxyResource = new aws.apigateway.Resource(
      `${name}-proxy-resource`,
      {
        restApi: this.restApi.id,
        parentId: this.restApi.rootResourceId,
        pathPart: "{proxy+}",
      },
      childOpts,
    );

    const rootAnyMethod = new aws.apigateway.Method(
      `${name}-root-any-method`,
      {
        restApi: this.restApi.id,
        resourceId: this.restApi.rootResourceId,
        httpMethod: "ANY",
        authorization: "NONE",
        apiKeyRequired: true,
      },
      childOpts,
    );

    const proxyAnyMethod = new aws.apigateway.Method(
      `${name}-proxy-any-method`,
      {
        restApi: this.restApi.id,
        resourceId: proxyResource.id,
        httpMethod: "ANY",
        authorization: "NONE",
        requestParameters: {
          "method.request.path.proxy": true,
        },
        apiKeyRequired: true,
      },
      childOpts,
    );

    const rootIntegration = new aws.apigateway.Integration(
      `${name}-root-integration`,
      {
        restApi: this.restApi.id,
        resourceId: this.restApi.rootResourceId,
        httpMethod: rootAnyMethod.httpMethod,
        integrationHttpMethod: "ANY",
        type: "HTTP_PROXY",
        connectionType: "VPC_LINK",
        connectionId: this.vpcLink.id,
        uri: pulumi.interpolate`http://${this.nlb.dnsName}:${args.backendPort}`,
        passthroughBehavior: "WHEN_NO_MATCH",
      },
      childOpts,
    );

    const proxyIntegration = new aws.apigateway.Integration(
      `${name}-proxy-integration`,
      {
        restApi: this.restApi.id,
        resourceId: proxyResource.id,
        httpMethod: proxyAnyMethod.httpMethod,
        integrationHttpMethod: "ANY",
        type: "HTTP_PROXY",
        connectionType: "VPC_LINK",
        connectionId: this.vpcLink.id,
        uri: pulumi.interpolate`http://${this.nlb.dnsName}:${args.backendPort}/{proxy}`,
        requestParameters: {
          "integration.request.path.proxy": "method.request.path.proxy",
        },
        passthroughBehavior: "WHEN_NO_MATCH",
      },
      childOpts,
    );

    // Public, unauthenticated health endpoint for the Route 53 failover check.
    const healthResource = new aws.apigateway.Resource(
      `${name}-health-resource`,
      {
        restApi: this.restApi.id,
        parentId: this.restApi.rootResourceId,
        pathPart: "health",
      },
      childOpts,
    );

    const healthMethod = new aws.apigateway.Method(
      `${name}-health-method`,
      {
        restApi: this.restApi.id,
        resourceId: healthResource.id,
        httpMethod: "GET",
        authorization: "NONE",
        apiKeyRequired: false,
      },
      childOpts,
    );

    const healthIntegration = new aws.apigateway.Integration(
      `${name}-health-integration`,
      {
        restApi: this.restApi.id,
        resourceId: healthResource.id,
        httpMethod: healthMethod.httpMethod,
        integrationHttpMethod: "GET",
        type: "HTTP_PROXY",
        connectionType: "VPC_LINK",
        connectionId: this.vpcLink.id,
        uri: pulumi.interpolate`http://${this.nlb.dnsName}:${args.backendPort}${args.healthCheckPath}`,
        passthroughBehavior: "WHEN_NO_MATCH",
      },
      childOpts,
    );

    this.deployment = new aws.apigateway.Deployment(
      `${name}-deployment`,
      {
        restApi: this.restApi.id,
        triggers: {
          // Key on integration URIs, not just IDs: an Integration's id is stable
          // across uri changes, so id-only would serve a stale stage on edits.
          redeploy: pulumi
            .all([
              rootAnyMethod.id,
              proxyAnyMethod.id,
              healthMethod.id,
              rootIntegration.uri,
              proxyIntegration.uri,
              healthIntegration.uri,
            ])
            .apply((parts) => parts.join(",")),
        },
      },
      { ...childOpts, dependsOn: [rootIntegration, proxyIntegration, healthIntegration] },
    );

    this.stage = new aws.apigateway.Stage(
      `${name}-stage`,
      {
        restApi: this.restApi.id,
        deployment: this.deployment.id,
        stageName: args.stageName,
        tags: baseTags,
      },
      childOpts,
    );

    new aws.apigateway.MethodSettings(
      `${name}-method-settings`,
      {
        restApi: this.restApi.id,
        stageName: this.stage.stageName,
        methodPath: "*/*",
        settings: {
          throttlingBurstLimit: args.throttleBurstLimit,
          throttlingRateLimit: args.throttleRateLimit,
          metricsEnabled: true,
        },
      },
      childOpts,
    );

    this.apiKey = new aws.apigateway.ApiKey(
      `${name}-api-key`,
      {
        name: `${name}-key`,
        enabled: true,
        tags: baseTags,
      },
      childOpts,
    );

    this.usagePlan = new aws.apigateway.UsagePlan(
      `${name}-usage-plan`,
      {
        name: `${name}-usage-plan`,
        apiStages: [{ apiId: this.restApi.id, stage: this.stage.stageName }],
        throttleSettings: {
          burstLimit: args.throttleBurstLimit,
          rateLimit: args.throttleRateLimit,
        },
        quotaSettings: {
          limit: args.quotaLimit,
          period: args.quotaPeriod,
        },
        tags: baseTags,
      },
      childOpts,
    );

    new aws.apigateway.UsagePlanKey(
      `${name}-usage-plan-key`,
      {
        keyId: this.apiKey.id,
        keyType: "API_KEY",
        usagePlanId: this.usagePlan.id,
      },
      childOpts,
    );

    const webAclRules: aws.types.input.wafv2.WebAclRule[] = [];

    if (args.enableManagedCommonRuleSet) {
      webAclRules.push({
        name: "aws-managed-common",
        priority: 1,
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            name: "AWSManagedRulesCommonRuleSet",
            vendorName: "AWS",
          },
        },
        visibilityConfig: {
          cloudwatchMetricsEnabled: true,
          metricName: `${name}-managed-common`,
          sampledRequestsEnabled: true,
        },
      });
    }

    webAclRules.push({
      name: "rate-limit",
      priority: 10,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit: args.wafRateLimit,
          aggregateKeyType: "IP",
        },
      },
      visibilityConfig: {
        cloudwatchMetricsEnabled: true,
        metricName: `${name}-rate-limit`,
        sampledRequestsEnabled: true,
      },
    });

    this.webAcl = new aws.wafv2.WebAcl(
      `${name}-web-acl`,
      {
        scope: "REGIONAL",
        defaultAction: { allow: {} },
        rules: webAclRules,
        visibilityConfig: {
          cloudwatchMetricsEnabled: true,
          metricName: `${name}-waf`,
          sampledRequestsEnabled: true,
        },
        tags: baseTags,
      },
      childOpts,
    );

    const region = aws.getRegionOutput();
    const stageArn = pulumi.interpolate`arn:aws:apigateway:${region.name}::/restapis/${this.restApi.id}/stages/${this.stage.stageName}`;

    this.executeApiFqdn = pulumi.interpolate`${this.restApi.id}.execute-api.${region.name}.amazonaws.com`;
    this.healthCheckResourcePath = pulumi.interpolate`/${this.stage.stageName}/health`;

    new aws.wafv2.WebAclAssociation(
      `${name}-waf-association`,
      {
        resourceArn: stageArn,
        webAclArn: this.webAcl.arn,
      },
      childOpts,
    );

    this.domainName = new aws.apigateway.DomainName(
      `${name}-domain`,
      {
        domainName: args.apiDomainName,
        regionalCertificateArn: args.certificateArn,
        endpointConfiguration: {
          types: "REGIONAL",
        },
        securityPolicy: "TLS_1_2",
        tags: baseTags,
      },
      childOpts,
    );

    new aws.apigateway.BasePathMapping(
      `${name}-base-path`,
      {
        restApi: this.restApi.id,
        stageName: this.stage.stageName,
        domainName: this.domainName.domainName,
      },
      childOpts,
    );

    this.registerOutputs({
      api_gateway_id: this.restApi.id,
      api_gateway_stage: this.stage.stageName,
      api_gateway_url: pulumi.interpolate`https://${this.domainName.domainName}`,
      api_gateway_domain_name: this.domainName.regionalDomainName,
      api_gateway_zone_id: this.domainName.regionalZoneId,
      api_key_id: this.apiKey.id,
      usage_plan_id: this.usagePlan.id,
      waf_arn: this.webAcl.arn,
      nlb_arn: this.nlb.arn,
      vpclink_id: this.vpcLink.id,
      execute_api_fqdn: this.executeApiFqdn,
      health_check_resource_path: this.healthCheckResourcePath,
    });
  }
}