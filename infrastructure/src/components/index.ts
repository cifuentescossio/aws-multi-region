// Networking: VPC, subnets, NAT, flow logs, and security groups.
export * from "./networking/network";
export * from "./networking/security";

// Edge: public entry points — ALB, API Gateway, and Route 53 failover records.
export * from "./edge/alb";
export * from "./edge/apigw";
export * from "./edge/dns";

// Compute: ECR registries, ECS cluster/roles and the per-backend Fargate services.
export * from "./compute/ecr";
export * from "./compute/ecs";
export * from "./compute/ecs-service";

// Data: Aurora PostgreSQL global database.
export * from "./data/database";
