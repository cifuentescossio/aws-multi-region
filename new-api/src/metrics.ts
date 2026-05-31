import { metrics } from '@opentelemetry/api';

/** Custom metrics. No-op meter when the OTEL SDK is inactive (tests/local). */
const meter = metrics.getMeter('new-api');

export const customEndpointHits = meter.createCounter('custom_endpoint_hits_total', {
  description: 'Number of hits on the custom metrics endpoint'
});
