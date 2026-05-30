import { Router } from 'express';
import { getAwsRegion } from '../services/awsRegionService';
import { customEndpointHits } from '../metrics';

const router = Router();

router.get('/region', async (_req, res, next) => {
  try {
    const region = await getAwsRegion();
    res.json({ region });
  } catch (error) {
    next(error);
  }
});

// Custom metric endpoint: each hit increments a counter exported to Grafana via
// the OTEL collector sidecar. Mirrors GET /v1/metrics/ping in legacy-api.
router.get('/metrics/ping', (_req, res) => {
  customEndpointHits.add(1, { endpoint: 'ping', service: 'new-api' });
  res.json({ metric: 'custom_endpoint_hits_total', status: 'recorded' });
});

router.get('/actuator/info', (_req, res) => {
  res.json({
    app: {
      name: 'new-api',
      description: 'TypeScript API service exposing AWS region information',
      version: '0.0.1'
    }
  });
});

export default router;
