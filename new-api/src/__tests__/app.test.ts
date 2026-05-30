import request from 'supertest';
import { createHttpServer } from '../server';
import type { Server } from 'node:http';

describe('new-api v2', () => {
  const originalAwsRegion = process.env.AWS_REGION;
  let server: Server;

  beforeEach(() => {
    server = createHttpServer();
  });

  afterEach(() => {
    server.close();

    if (originalAwsRegion === undefined) {
      delete process.env.AWS_REGION;
    } else {
      process.env.AWS_REGION = originalAwsRegion;
    }
  });

  it('returns region from AWS_REGION env var', async () => {
    process.env.AWS_REGION = 'eu-west-1';

    const response = await request(server).get('/v2/region');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ region: 'eu-west-1' });
  });

  it('returns health endpoint under /v2/actuator', async () => {
    const response = await request(server).get('/v2/actuator/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBeDefined();
  });

  it('records a custom metric on /v2/metrics/ping', async () => {
    const response = await request(server).get('/v2/metrics/ping');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ metric: 'custom_endpoint_hits_total', status: 'recorded' });
  });

  it('returns structured JSON for unknown endpoint', async () => {
    const response = await request(server).get('/v2/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body.status).toBe(404);
    expect(response.body.error).toBe('Not Found');
    expect(response.body.path).toBe('/v2/does-not-exist');
    expect(response.body.message).toContain('No endpoint found for GET /v2/does-not-exist');
    expect(response.body.timestamp).toBeDefined();
  });
});
