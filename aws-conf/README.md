# Evidencia de Despliegue — AWS

Capturas de la infraestructura desplegada con Pulumi para la arquitectura multi-región
activo-pasivo (pilot light DR).

---

## 00 · Pulumi

### Stacks y outputs del despliegue

![Pulumi](./00-pulumi/Pulumi.png)

### GET /health (público, sin API Key)

![Get Health](./00-pulumi/Get-Health.png)

### GET /v1/region sin API Key (403 Forbidden)

![Get Without Token](./00-pulumi/Get-Without-Token.png)

### GET /v1/region con API Key

![Get With Token](./00-pulumi/Get-With-Token.png)

---

## 01 · VPC y Networking

### VPC — Virginia (us-east-1)

![VPC Virginia](./01-vpc-networking/VPC-Virginia.png)

### VPC — Oregón (us-west-2)

![VPC Oregon](./01-vpc-networking/VPC-Oregon.png)

---

## 02 · Security Groups

### Security Groups — Virginia

![Security Groups Virginia](./02-security-groups/Security-Groups-Virginia.png)

### Security Groups — Oregón

![Security Groups Oregon](./02-security-groups/Security-Groups-Oregon.png)

---

## 03 · ALB interno

### ALB — Virginia

![ALB Virginia](./03-alb/ALB-Virginia.png)

### ALB — Oregón

![ALB Oregon](./03-alb/ALB-Oregon.png)

---

## 04 · HTTPS / Certificado (ACM)

### Certificate Manager

![Certificate Manager](./04-acm-https/Certificate-Manager.png)

---

## 05 · API Gateway

### API Gateway — Virginia

![API Gateway Virginia](./05-api-gateway/API-Gateway-Virginia.png)

### API Gateway — Oregón

![API Gateway Oregon](./05-api-gateway/API-Gateway-Oregon.png)

### API Key — Virginia

![API Gateway API Key Virginia](./05-api-gateway/API-Gateway-API-Key-Virginia.png)

### API Key — Oregón

![API Gateway API Key Oregon](./05-api-gateway/API-Gateway-API-Key-Oregon.png)

### Usage Plan — Virginia

![API Gateway Usage Plan Virginia](./05-api-gateway/API-Gateway-Usage-Plan-Virginia.png)

### Usage Plan — Oregón

![API Gateway Usage Plan Oregon](./05-api-gateway/API-Gateway-Usage-Plan-Oregon.png)

### VPC Link — Virginia

![API Gateway VPC Link Virginia](./05-api-gateway/API-Gateway-VPC-Link-Virginia.png)

### VPC Link — Oregón

![API Gateway VPC Link Oregon](./05-api-gateway/API-Gateway-VPC-Link-Oregon.png)

---

## 06 · WAF

### WAF — Virginia

![WAF Virginia](./06-waf/WAF-Virginia.png)

### WAF — Oregón

![WAF Oregon](./06-waf/WAF-Oregon.png)

---

## 07 · ECR

### ECR — Virginia

![ECR Virginia](./07-ecr/ECR-Virginia.png)

### ECR — Oregón

![ECR Oregon](./07-ecr/ECR-Oregon.png)

---

## 08 · ECS

### ECS — Virginia

![ECS Virginia](./08-ecs/ECS-Virginia.png)

### ECS — Oregón

![ECS Oregon](./08-ecs/ECS-Oregon.png)

---

## 09 · Secrets Manager

### Secrets Manager — Virginia

![Secrets Manager Virginia](./09-secrets-manager/Secrets-Manager-Virginia.png)

### Secrets Manager — Oregón

![Secrets Manager Oregon](./09-secrets-manager/Secrets-Manager-Oregon.png)

---

## 10 · Aurora PostgreSQL Global Database

### RDS Aurora Global Database

![RDS Aurora Global Database](./10-aurora-global-db/RDS-Aurora-Global-Database.png)

---

## 11 · Route 53 — Failover multi-región

### Route 53 — Registros y hosted zone

![Route 53](./11-route53-failover/Route53.png)

### Health check de failover

![Route 53 Failover Health](./11-route53-failover/Route53-Failover-Health.png)

---

## 12 · CloudWatch / Observabilidad

### Container Insights

![CloudWatch Container Insights](./12-cloudwatch/CloudWatch-Container-Insights.png)
