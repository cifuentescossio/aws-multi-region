# Documento de Diseño de Arquitectura

**Sistema:** Infraestructura de Backend Multi-Región Activo-Pasivo  
**Patrón:** Arquitectura de "Nada Compartido" (Shared-Nothing), Cómputo sin Estado (Stateless), Recuperación ante Desastres Pilot Light
**Base de Datos:** PostgreSQL (Amazon Aurora)  
**Región Principal:** `us-east-1` (Virginia)  
**Región Secundaria:** `us-west-2` (Oregón)  

## Diagrama de Arquitectura

![Diagrama de arquitectura multi-región activo-pasivo: Route 53 con enrutamiento de failover, API Gateway + WAF, VPC Link → NLB puente → ALB interno, backends v1/v2 sobre ECS Fargate y Aurora Global Database replicando de Virginia (us-east-1) a Oregón (us-west-2).](./aws-multi-region-architecture.png)

> El diagrama resume visualmente la arquitectura descrita en este documento: el enrutamiento global con Route 53 (sección 1), la cadena de ingreso `API Gateway → VPC Link → NLB → ALB` (secciones 3 y 10.2), el split de rutas `/v1/*` y `/v2/*` sobre ECS (secciones 3 y 6) y la replicación de Aurora entre la región principal y la secundaria (sección 5). Las secciones siguientes detallan cada componente.

> **Evidencia de despliegue:** las capturas de la infraestructura real desplegada en AWS están en [`aws-conf/README.md`](./aws-conf/README.md).

---

## 1. Configuración y Estrategia Multi-Región

El sistema emplea una arquitectura **Activo-Pasivo (Recuperación ante Desastres)** para equilibrar la alta disponibilidad con la eficiencia de costos.

*   **Enrutamiento de Tráfico:** AWS Route 53 actúa como el resolutor de DNS global utilizando una **Política de Enrutamiento de Failover (Conmutación por Error)**.
*   **Estado Activo:** El 100% del tráfico de los usuarios en vivo se dirige a la Región Principal (Virginia).
*   **Estado Pasivo:** La Región Secundaria (Oregón) opera en una configuración de "Luz Piloto" (Pilot Light). La base de datos PostgreSQL recibe constantemente datos replicados, pero los recursos de cómputo (contenedores) se reducen al mínimo absoluto para ahorrar costos.
*   **Mecanismo de Failover:** Route 53 realiza continuamente verificaciones de estado (Health Checks) contra el endpoint `/health` del API Gateway de Virginia (registro `PRIMARY`). Si la región principal se vuelve inactiva, el DNS cambia automáticamente a Oregón (registro `SECONDARY`). En Oregón el cómputo se mantiene "tibio" en `passive_min_capacity` (pilot light) y el **App Auto Scaling (target-tracking de CPU)** escala horizontalmente de forma automática a medida que llega el tráfico y sube la utilización, hasta `max_capacity`.
    *   *Estado actual:* el health check y el routing de failover están desplegados; el servicio ECS con autoescalado está implementado pero **deshabilitado por defecto** (`ecs.service_enabled`) hasta que existan imágenes de contenedor para los backends. La promoción del clúster Aurora secundario sigue siendo una acción operativa (ver runbook de DR).

---

## 2. Descripción de Red (Networking)

Cada región opera como un entorno de red aislado con arquitecturas idénticas pero bloques CIDR no superpuestos (ej. `10.0.0.0/16` para Virginia y `10.1.0.0/16` para Oregón).

*   **Virtual Private Cloud (VPC):** Proporciona el límite de red lógico.
*   **Subredes Públicas:** Contienen únicamente los **NAT Gateways**. Debido a que la arquitectura es completamente privada, ningún contenedor de aplicación ni balanceador de carga se expone en la subred pública.
*   **Subredes Privadas:** Albergan los Balanceadores de Carga de Aplicaciones Internos (ALB), las instancias de cómputo (backends Java y TS) y los clústeres de base de datos PostgreSQL.
*   **Tablas de Enrutamiento (Route Tables):**
    *   *Tabla de Ruta Pública:* Enruta el tráfico `0.0.0.0/0` (salida a internet) hacia la Puerta de Enlace de Internet (Internet Gateway - IGW).
    *   *Tabla de Ruta Privada:* Enruta el tráfico `0.0.0.0/0` hacia el NAT Gateway, permitiendo que los contenedores privados descarguen dependencias o envíen métricas a herramientas externas sin exponerse a conexiones entrantes desde el internet público.
*   **NAT Gateway (uno por AZ):** Cada subred privada sale por un NAT Gateway en su **misma Zona de Disponibilidad** (estrategia `OnePerAz`). Es una decisión de **alta disponibilidad**: la caída de una AZ no deja sin salida a las demás, a costa de pagar un NAT por zona. *Alternativa / optimización futura:* un único NAT compartido abarata el costo pero reintroduce un punto único de fallo; y para el tráfico hacia servicios de AWS (ECR, S3, Secrets Manager, CloudWatch) se añadirían **VPC Endpoints** (Gateway e Interface), que evitan el NAT por completo y reducen su factura de transferencia de datos.

---

## 3. Exposición de Endpoints (Backends v1 y v2)

El ingreso de tráfico está fuertemente protegido y se enruta de manera inteligente entre los backends legados y modernos.

*   **AWS API Gateway:** Actúa como la "Puerta de Entrada" pública. **Estado actual:** la autenticación se realiza mediante **API Key** asociada a un **Usage Plan** (control de flujo / throttling y cuotas por cliente a nivel de API). La validación de tokens JWT **no está implementada todavía** y se documenta como ruta de evolución en la sección 10.1.
    *   *Excepción:* el endpoint público `/health` no requiere API Key, ya que es sondeado por el Health Check de Route 53 para el failover Activo-Pasivo.
*   **VPC Link (a través de un NLB puente):** Conecta de forma segura el API Gateway público con la VPC privada. **Detalle técnico importante:** un VPC Link de API Gateway **REST** no puede apuntar directamente a un ALB; requiere un **Network Load Balancer (NLB) interno** como destino. Por eso la cadena real es:
    `API Gateway → VPC Link → NLB interno (puerto 8080) → ALB Interno`.
    El NLB se despliega en las subredes privadas con un *target group* de tipo `alb` que registra al ALB Interno, y el API Gateway integra vía `HTTP_PROXY`/`VPC_LINK` contra el DNS del NLB. El control L7 (split de rutas v1/v2) lo sigue haciendo el ALB; el NLB solo actúa de puente L4 exigido por el tipo de API.
*   **Enrutamiento basado en Rutas (Reglas de Escucha del ALB):** El ALB Interno actúa como el controlador de ingreso, dividiendo el tráfico según la ruta de la URL:
    *   Las peticiones a `/v1/*` se dirigen al Grupo de Destino (Target Group) del **Backend Legado** (Java/Spring Boot, puerto 8080). El patrón coincide con lo que el servicio expone realmente (el ALB reenvía la ruta sin reescribirla), por lo que su health check apunta a `/v1/actuator/health`.
    *   Las peticiones a `/v2/*` se dirigen al Grupo de Destino del **Backend Moderno** (TypeScript/Node, puerto 3000); su health check apunta a `/v2/actuator/health`.
    *   *Estado actual:* las reglas de path y ambos Target Groups ya están desplegados; las rutas no reconocidas devuelven `404`. Los Target Groups permanecen vacíos (responden `503`) hasta que se adjunten los servicios ECS en una iteración futura.

---

## 4. Postura de Seguridad

La arquitectura emplea una estrategia de "Defensa en Profundidad" a lo largo de múltiples capas:

*   **AWS WAF (Web Application Firewall):** Conectado directamente al API Gateway. Aplica límites de velocidad (Rate Limiting) para mitigar ataques de denegación de servicio (DDoS/brute force) y bloquea IPs maliciosas o exploits comunes (OWASP Top 10) en el borde de la red.
*   **Subredes Privadas y Cero IPs Públicas:** Ningún recurso de cómputo ni de base de datos posee IPs públicas. Son matemáticamente inaccesibles desde el internet público.
*   **Grupos de Seguridad (Security Groups):** Configurados con el principio de mínimo privilegio:
    *   *SG del ALB:* Solo acepta tráfico entrante desde la red privada de la VPC (en los puertos 80, 443 y 8080). En la práctica el origen es el **NLB puente** del VPC Link, cuyos nodos viven en las subredes privadas; por eso el ingress se restringe al CIDR de la VPC y no hay exposición pública.
    *   *SG de la Aplicación:* Solo acepta tráfico entrante desde el SG del ALB en los puertos específicos (ej. 8080, 3000).
    *   *SG de la Base de Datos:* Solo acepta tráfico entrante en el puerto estándar de PostgreSQL (`5432`) proveniente estrictamente del SG de la Aplicación.
*   **HTTPS y AWS ACM:** Cifrado de extremo a extremo. AWS Certificate Manager (ACM) gestiona y renueva automáticamente los certificados SSL/TLS en el API Gateway y el ALB Interno.
*   **IAM de Mínimo Privilegio:** Las tasks de ECS usan dos roles separados: el *task execution role* (solo la política gestionada de ejecución de ECS más `secretsmanager:GetSecretValue` **acotado al ARN** del secret que necesita) y un *task role* propio de la aplicación, mínimo por defecto. El rol de los Flow Logs se limita a escribir en su Log Group. Ningún rol usa comodines amplios.
*   **Gestión de Secretos:** Todo secreto vive en **AWS Secrets Manager**, nunca en el código ni en las imágenes. La credencial maestra de Aurora la genera Pulumi y la administra el propio RDS (*managed master secret*); la cabecera de autenticación de la observabilidad se siembra como **secret de Pulumi** y se inyecta en runtime. Las apps obtienen los secretos vía su rol IAM al arrancar.
*   **Auditoría:** Los **VPC Flow Logs** (tráfico de red, 30 días en CloudWatch) y los logs `postgresql` de Aurora ya están desplegados. Para una postura completa se recomienda habilitar **AWS CloudTrail** a nivel de organización (auditoría de llamadas a la API de AWS), junto con **AWS Config** y **GuardDuty** para cumplimiento y detección de amenazas.
*   **Separación de Ambientes:** Hoy existe un único ambiente (`prod`). El diseño escala a múltiples ambientes con el **mismo código de Pulumi parametrizado**: cada ambiente (dev/staging/prod) es un stack idéntico a producción, variando solo capacidad (CPU/réplicas) por costo. Para aislamiento real se recomienda **una cuenta de AWS por ambiente** vía AWS Organizations.

---

## 5. Arquitectura de Base de Datos (PostgreSQL)

La gestión del estado y persistencia de datos se delega a **Amazon Aurora Global Database (compatible con PostgreSQL)**, diseñada específicamente para entornos multi-región altamente eficientes.

*   **Replicación Multi-Región:** La replicación física a nivel de almacenamiento de Aurora copia continuamente los datos de Virginia a Oregón con una latencia típica de **menos de 1 segundo**, sin afectar el rendimiento de escritura de la base de datos principal.
*   **Alta Disponibilidad (HA):** Dentro de la región activa, Aurora mantiene automáticamente copias de seguridad de los datos distribuidas en 3 Zonas de Disponibilidad (AZs) diferentes.
*   **Escalabilidad de Lectura y Escritura:** La instancia principal en Virginia maneja el 100% de las escrituras. Se pueden añadir hasta 15 réplicas de lectura de Aurora PostgreSQL para escalar horizontalmente las consultas de lectura intensiva.
*   **Cifrado:** Los datos se cifran **en reposo** utilizando claves gestionadas por AWS KMS y **en tránsito** mediante TLS para todas las conexiones de base de datos.
*   **Respaldos y Recuperación a un Punto en el Tiempo (PITR):** Se habilitan copias de seguridad continuas y automáticas. PITR permite restaurar la base de datos a cualquier segundo exacto dentro de los últimos 35 días (protegiendo contra errores lógicos o corrupción de datos).
*   **Plan de Recuperación ante Desastres (Disaster Recovery):** En caso de una falla total en Virginia, el clúster secundario de Aurora PostgreSQL en Oregón es promovido a Clúster Principal. Esta promoción toma menos de un minuto y habilita inmediatamente la capacidad de lectura y escritura en la región de respaldo.
*   **Conexión de los Backends:** Aurora vive en las **subredes privadas** y no es accesible desde internet; su Security Group solo admite el puerto `5432` desde el SG de las tasks de ECS. *Estado actual:* las aplicaciones son **stateless** (solo devuelven la región AWS), por lo que todavía no abren conexión; el clúster queda aprovisionado y listo. *Cómo se haría la comunicación:* la task leería el endpoint y la credencial desde Secrets Manager y conectaría por **TLS** dentro de la VPC al **endpoint escritor** para escrituras y al **reader endpoint** para lecturas, repartiendo la carga de lectura entre réplicas.
*   **Gestión Segura de Credenciales:** No hay credenciales en código ni en variables de entorno en texto plano. La contraseña maestra se genera con Pulumi y queda en el **secret gestionado por RDS** (Secrets Manager); la aplicación la resuelve en runtime a través de su rol IAM.
*   **Pooling de Conexiones:** Para el volumen actual basta un **pool en la propia aplicación** (HikariCP en v1 / `pg-pool` en v2). A medida que crezca el número de tasks se recomienda **Amazon RDS Proxy** como capa intermedia: multiplexa y reutiliza conexiones, evita agotar el límite de Postgres ante picos o *scale-out* agresivo y acelera el failover.
*   **Estrategia de Migraciones:** Los cambios de esquema se versionan dentro de cada servicio y se aplican en el pipeline de **CD** como paso previo al despliegue (Flyway para v1/Java, node-pg-migrate para v2/TypeScript), ejecutados como **tarea ECS one-off** contra el endpoint escritor. Las migraciones son idempotentes y quedan bajo control de versión junto al código que las requiere.

---

## 6. Crecimiento y Escalabilidad

La arquitectura está diseñada para escalar de forma horizontal y orgánica:

*   **Cómputo sin Estado (Stateless):** Debido a que las aplicaciones Spring Boot y TypeScript no guardan sesiones de usuario de forma local, el orquestador (ECS/EKS) puede escalar horizontalmente de manera infinita añadiendo réplicas de contenedores según el uso de CPU o memoria.
    *   *Estado actual:* cada backend tiene una política de **App Auto Scaling con target-tracking de CPU** (`cpu_target_utilization`) entre `min_capacity` y `max_capacity`; `desiredCount` queda gobernado por el autoescalado (Pulumi ignora cambios en ese campo).
*   **Desacoplamiento:** Al colocar el ALB frente a las aplicaciones, los backends v1 y v2 pueden escalar de manera independiente según su propia demanda de tráfico. Cada uno corre como un **ECS Service Fargate** distinto, atado a su propio Target Group, por lo que escalan con métricas independientes.
*   **Expansión Futura:** El diseño de "VPC de Nada Compartido" permite replicar e incorporar fácilmente una tercera o cuarta región global en el futuro simplemente desplegando el stack de Pulumi en una nueva región y agregándola a las políticas de Route 53.

---

## 7. Configuración Compartida y Outputs Reutilizables

La separación entre **infraestructura base** y **servicios de aplicación** se sostiene sobre una única fuente de verdad y outputs tipados.

*   **Fuente de verdad única (`shared.config.yaml`):** un solo archivo declara lo que comparten todos los stacks — regiones y CIDRs, puerto y health path, definición de los backends (path/puerto/imagen), parámetros de ECS, API Gateway, observabilidad y tags. Un **loader tipado** (`config.ts`) lo valida y lo expone; los componentes nunca leen `process.env` ni el YAML directamente. Una clave de Pulumi por stack (`aws-multi-region:<campo>`) **sobrescribe** un valor compartido solo cuando ese stack difiere, así que los archivos `Pulumi.<stack>.yaml` cargan únicamente lo que cambia (ej. `region_key`).
*   **Sin duplicación entre regiones:** los dos stacks regionales (Virginia y Oregón) ejecutan el **mismo código** parametrizado. La región y el CIDR salen del config, no del código, lo que evita copiar/pegar y derivas entre regiones.
*   **Outputs FLAT reutilizables:** cada stack regional exporta sus identificadores de forma **plana** en `index.ts` (`vpc_id`, `private_subnet_ids`, `alb_arn`, `target_group_arns`, `ecs_cluster_arn`, endpoints de Aurora, ARNs de secrets…). El stack **global** los consume por nombre vía `StackReference.getOutput` para armar el failover de Route 53, y cualquier servicio futuro puede engancharse a esos outputs sin redeclarar la red ni la base de datos.
*   **Configuración de las aplicaciones:** los parámetros de runtime de cada backend (ej. nombre, usuario y puerto de BD) se inyectan como variables de entorno desde el pipeline (GitHub Actions `vars`), separando la configuración de aplicación de la de infraestructura y manteniendo los secretos fuera del repositorio.

---

## 8. Observabilidad (Métricas, Logs y Tracing Distribuido)

La observabilidad se apoya en **dos capas complementarias**: la **nativa de AWS (CloudWatch)** y **Grafana Cloud** vía OpenTelemetry. La telemetría de ambos backends se envía a Grafana Cloud mediante el protocolo **OTLP**, usando el patrón de **sidecar**: cada *task* de ECS corre, junto al contenedor de la aplicación, un **OpenTelemetry Collector (ADOT)**.

*   **Capa nativa (CloudWatch):** independientemente de Grafana, AWS deja telemetría en CloudWatch. Los logs de cada contenedor salen por el *log driver* `awslogs` a un **Log Group** por región, los **VPC Flow Logs** registran el tráfico de red (30 días) y Aurora exporta sus logs `postgresql`. Las métricas de infraestructura (CPU/memoria de ECS, ALB, Aurora) quedan disponibles para alarmas básicas de CloudWatch.
*   **Flujo:** la app exporta OTLP a `http://localhost:4318` (los dos contenedores comparten el *network namespace* de la task `awsvpc`); el collector hace *batching* y lo reenvía al **OTLP gateway de Grafana Cloud** con autenticación HTTP `Basic`. Se exportan las **tres señales**: trazas, métricas y logs.
*   **Instrumentación de las apps:**
    *   *v1 (Java/Spring Boot):* **OpenTelemetry Java agent** (`-javaagent`) en la imagen → auto-instrumentación sin tocar lógica (HTTP, JVM, logs de Logback y trazas).
    *   *v2 (TypeScript/Node):* `@opentelemetry/sdk-node` + auto-instrumentations, inicializado antes que Express.
*   **Métrica custom (paridad v1/v2):** un endpoint `GET /api/vN/metrics/ping` incrementa el contador `custom_endpoint_hits_total` y responde `{ "metric": "custom_endpoint_hits_total", "status": "recorded" }`. Es la forma simple de emitir una métrica de negocio a Grafana desde cualquiera de los dos servicios.
*   **Manejo de credenciales:** el endpoint OTLP (no sensible) vive en `shared.config.yaml`; la cabecera de autenticación (`base64` de `instanceID:token`) se guarda en **AWS Secrets Manager** (creado por Pulumi por región) y se inyecta en el collector vía `secrets` de la *task*. El *task execution role* recibe permiso `secretsmanager:GetSecretValue` solo sobre ese ARN. El token nunca queda en el repositorio.
*   **Estado actual:** se activa con `observability.enabled: true` y solo despliega los sidecars cuando el servicio ECS está habilitado (`ecs.service_enabled: true`) con imágenes de contenedor. El SG de tasks ya permite el *egress* HTTPS necesario hacia Grafana Cloud.

---

## 9. Despliegue y Operaciones (CI/CD)

La infraestructura y el código de las aplicaciones se gestionan a través de un **Monorepo** y se despliegan utilizando **GitHub Actions** y **Pulumi**.

### Estructura del Monorepo

    infrastructure/   (TypeScript / Pulumi — infraestructura base)
    legacy-api/       (Java / Spring Boot — backend v1)
    new-api/          (TypeScript / Node — backend v2)

### Pipelines de CI/CD

*   **Disparadores Basados en Rutas:** Cada proyecto tiene su propio workflow de GitHub Actions con filtros de ruta (`on: push: paths:`). Modificar código en `new-api/` solo activará la compilación del backend v2, mientras que cambios en `infrastructure/` solo dispararán el flujo de infraestructura.
*   **Flujo de Pull Requests (PR - Integración Continua):**
    *   *Cambios en Aplicaciones:* Ejecuta pruebas unitarias, análisis estático y formateadores de código (ej. SonarQube, ESLint, Maven test) para garantizar la calidad antes de fusionar.
    *   *Cambios en Infraestructura:* Ejecuta `pulumi preview`. Esto genera y publica un comentario automático en el PR de GitHub detallando exactamente qué recursos de AWS serán creados, modificados o destruidos.
*   **Flujo de Fusión a Rama Principal (CD - Despliegue Continuo):**
    *   Una vez aprobado y fusionado el PR a la rama `main`, el pipeline compila **una sola vez** la imagen Docker del backend y la sube, con el **mismo tag**, a los **repositorios ECR de ambas regiones** (Virginia y Oregón); luego ejecuta `pulumi up` para aplicar los cambios de infraestructura y realizar despliegues progresivos sin interrupción de servicio (Rolling Updates).
    *   **Registro de imágenes (Amazon ECR):** los repositorios los crea **Pulumi por región** (uno por backend: `<project>-v1`, `<project>-v2`), ya que ECR es un servicio **regional**. Replicar la imagen a las dos regiones permite que cada *task* de ECS haga *pull* desde su **registro local**, sin tráfico ni latencia *cross-region* durante un failover. Los repos se crean **independientemente de `ecs.service_enabled`** (el repo debe existir antes de poder subir una imagen, y la imagen antes de poder habilitar el servicio). Cada repo aplica **tags inmutables** (un tag desplegado no se sobrescribe), **escaneo de vulnerabilidades en el push** y una **lifecycle policy** que conserva solo las últimas N imágenes. La URI efectiva del contenedor se **deriva del repo ECR de la región** más el `image_tag` configurado, de modo que Virginia y Oregón nunca apuntan a un registro de otra región.

---

## 10. Trade-offs y Evolución Arquitectónica (Justificación de Decisiones)

El diseño de esta arquitectura se basa en compensaciones (trade-offs) deliberadas, priorizando la simplicidad operativa, la seguridad y la latencia predecible para el volumen actual, mientras se deja una ruta de evolución clara para una escala masiva (ej. > 1 millón de usuarios constantes).

### 10.1. API Gateway vs. Solo WAF
*   **Decisión:** Se introdujo Amazon API Gateway en lugar de exponer los ALBs directamente a internet protegidos únicamente por AWS WAF.
*   **Justificación:** Mientras que el WAF mitiga ataques y provee *rate limiting* básico por IP, delegar el control de ingreso al API Gateway centraliza la lógica de acceso (autenticación, throttling y cuotas) fuera de los microservicios. **En la iteración actual** esto se materializa con **API Key + Usage Plan**: cada cliente se identifica por su API Key y queda sujeto a límites de burst/rate y cuota mensual, sin que los contenedores tengan que implementar esa lógica.
*   **Ruta de Evolución (Autenticación JWT):** El siguiente paso natural es descargar también la **validación criptográfica de tokens (JWT)** al API Gateway, de modo que los contenedores reciban tráfico ya autenticado y ahorren CPU. Para esta REST API se haría mediante un *authorizer* de **Cognito User Pools** o un **Lambda authorizer** (validando contra un IdP externo como Auth0/Okta). Se pospuso para mantener la primera iteración simple.
*   **Ruta de Evolución (Gestión avanzada):** Si en el futuro la API se convierte en un producto comercial (B2B/B2C) que requiere portales de desarrolladores, monetización, o analítica avanzada por cliente, esta capa se migraría hacia soluciones de *Full API Lifecycle Management* como **Kong** o **Apigee**.

### 10.2. API Gateway REST vs. HTTP API (y el NLB puente)
*   **Decisión:** Se utiliza **API Gateway REST** (`aws.apigateway.*`) en lugar de **HTTP API** (`aws.apigatewayv2.*`).
*   **Costo de la decisión:** El VPC Link de una REST API opera a nivel L4 y **solo puede apuntar a un NLB**, no a un ALB. Por eso se introduce un **NLB interno como puente** (`API Gateway → VPC Link → NLB → ALB`, ver sección 3), con un *target group* de tipo `alb` que registra al ALB. Es un salto e infraestructura adicional cuyo único propósito es satisfacer ese requisito del tipo de API.
*   **¿Por qué no HTTP API entonces?:** Un HTTP API sí permite que el VPC Link apunte **directamente al ALB**, eliminando por completo el NLB puente (más barato, menos latencia, menos recursos que mantener). Sin embargo, HTTP API **no soporta dos features de las que hoy dependemos**:
    *   **API Keys + Usage Plans** (autenticación por key, throttling y cuotas por cliente — sección 10.1).
    *   **AWS WAF** asociado directamente al gateway (sección 4): WAFv2 no se puede asociar a un HTTP API.
    Por tanto, migrar a HTTP API obligaría a reconstruir el control de acceso (p. ej. JWT/Lambda authorizer) y el WAF (p. ej. en un CloudFront por delante), lo que reintroduce complejidad. El NLB es barato comparado con ese trabajo, así que el trade-off favorece mantener REST **mientras esas dos features sean requisito**.
*   **Nota sobre gateways dedicados (Kong / Apigee):** Este NLB puente es un artefacto específico del modelo de VPC Link de AWS REST API. Con un **Full API Lifecycle Management como Kong o Apigee** (ver ruta de evolución en 8.1) este puente **no sería necesario**: al correr como proxy L7 dentro de la VPC/clúster, enrutan directamente contra el ALB o los servicios, y aportan de forma nativa API keys, rate limiting y políticas de seguridad equivalentes al WAF — eliminando tanto el NLB como la disyuntiva REST vs HTTP API.

### 10.3. Contenedores (ECS) vs. Serverless (Lambda)
*   **Decisión:** Se optó por contenedores de larga duración (Amazon ECS) en lugar de funciones Serverless (AWS Lambda).
*   **Justificación:** Para un escenario con un gran volumen de tráfico constante (ej. 1 millón de clientes concurrentes), los contenedores resultan más eficientes en costos que el pago por invocación de Lambda. Además, ECS garantiza latencias predecibles al eliminar por completo el problema de los *cold starts*.
*   **Ruta de Evolución (Service Mesh & GitOps):** Actualmente, implementar Kubernetes (EKS) con un Service Mesh (ej. Istio) para solo dos servicios (v1 y v2) representaría una **sobre-ingeniería prematura**. Sin embargo, a medida que el ecosistema crezca hacia decenas de microservicios, la infraestructura migrará a **Amazon EKS**. Esto habilitará el uso de **Istio** para un control granular del tráfico de red (trazabilidad, mTLS) y estrategias de despliegue avanzadas como *Canary Deployments*, todo gestionado a través de flujos **GitOps** (ej. ArgoCD).

### 10.4. Bases de Datos, Manejo del Estado y Evolución a CQRS/EDA
*   **Decisión Actual:** Uso de Amazon Aurora PostgreSQL Global Database.
*   **Justificación:** Proporciona integridad relacional estricta (ACID) y resuelve de manera nativa la complejidad de la replicación física de datos a nivel de almacenamiento entre múltiples regiones para el patrón Activo-Pasivo.
*   **Fase 1 de Evolución (Caché, Idempotencia y Append-Only):** 
    A medida que aumente la concurrencia, se introducirá **Redis** como capa frontal de datos. En sistemas distribuidos con reintentos de red (retries), Redis es crucial para validar la **idempotencia** en milisegundos (usando `SETNX` con TTL) y evitar el procesamiento duplicado de transacciones antes de golpear la base de datos. A nivel de base de datos SQL, el modelo de datos evolucionará hacia un patrón *Append-Only* (Solo Inserciones) usando índices únicos (Unique Index) para registrar transacciones inmutables, garantizando auditoría perfecta y eliminando bloqueos por sentencias `UPDATE`.
*   **Fase 2 de Evolución (Desacoplamiento Masivo con EDA y CQRS):**
    Para evitar que PostgreSQL se convierta en un cuello de botella de concurrencia y lectura en escenarios de hipercrecimiento, la arquitectura de datos evolucionará hacia un patrón **CQRS** (Command Query Responsibility Segregation) soportado por una **Arquitectura Orientada a Eventos (EDA)** con **Apache Kafka** (o Amazon MSK):
    *   *Escrituras (Commands):* Se siguen procesando de forma segura y síncrona en Aurora PostgreSQL (el "Sistema de Registro").
    *   *Eventos:* Cada transacción exitosa en la base de datos emite un evento hacia un tópico de Kafka de manera asíncrona.
    *   *Lecturas (Queries):* Microservicios de consulta consumen los eventos de Kafka para popular y actualizar bases de datos optimizadas para lecturas masivas (ej. Elasticsearch para búsquedas complejas, o DynamoDB para consultas de clave-valor en milisegundos).
    *   *Trade-off:* Se acepta la **consistencia eventual** (la vista de lectura puede tardar milisegundos en reflejar la transacción de escritura) a cambio de una capacidad de lectura infinitamente escalable y desacoplada del motor relacional principal.