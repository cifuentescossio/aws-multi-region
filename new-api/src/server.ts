import http from 'node:http';
import { createTerminus } from '@godaddy/terminus';
import app from './app';

export function createHttpServer(): http.Server {
  const server = http.createServer(app);

  createTerminus(server, {
    healthChecks: {
      '/v2/actuator/health': async () => ({ status: 'UP' })
    }
  });

  return server;
}
