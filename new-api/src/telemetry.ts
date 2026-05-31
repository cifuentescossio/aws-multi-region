import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';

/**
 * OpenTelemetry bootstrap. Imported first in index.ts so auto-instrumentation
 * patches http/express before they load. No-op when OTEL is disabled or has no
 * endpoint (e.g. under Jest).
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
