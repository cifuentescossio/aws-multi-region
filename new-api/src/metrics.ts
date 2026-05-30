import { metrics } from '@opentelemetry/api';

/**
 * Custom application metrics for new-api (v2). When the OTEL SDK is active these
 * are exported to Grafana Cloud via the collector sidecar; otherwise the OTEL API
 * returns a no-op meter, so this is safe to import in tests and local runs.
 */
const meter = metrics.getMeter('new-api');

export const customEndpointHits = meter.createCounter('custom_endpoint_hits_total', {
  description: 'Number of hits on the custom metrics endpoint'
});
