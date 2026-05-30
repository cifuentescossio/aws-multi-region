import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';

/**
 * OpenTelemetry bootstrap for new-api (v2).
 *
 * Exports traces, metrics and logs over OTLP/HTTP to the OTEL collector sidecar
 * (http://localhost:4318 in ECS) which forwards them to Grafana Cloud. All wiring
 * is driven by the standard `OTEL_*` env vars set on the task definition.
 *
 * Imported FIRST in index.ts so the auto-instrumentations patch `http`/`express`
 * (CommonJS require hooks) before the app is loaded.
 *
 * No-op when OTEL is disabled or no endpoint is configured (e.g. under Jest), so
 * tests and local runs without a collector don't spin up exporters.
 */
const disabled = process.env.OTEL_SDK_DISABLED === 'true';
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();

let sdk: NodeSDK | undefined;

if (!disabled && endpoint) {
  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 15000
    }),
    logRecordProcessors: [new BatchLogRecordProcessor(new OTLPLogExporter())],
    instrumentations: [getNodeAutoInstrumentations()]
  });

  sdk.start();

  const shutdown = () => {
    sdk
      ?.shutdown()
      .catch((err) => console.error('Error shutting down OpenTelemetry SDK', err))
      .finally(() => process.exit(0));
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export {};
