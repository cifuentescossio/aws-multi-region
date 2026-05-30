// Must be first: starts the OTEL SDK and patches http/express before they load.
import './telemetry';
import { createHttpServer } from './server';

const port = Number(process.env.PORT) || 8080;

const server = createHttpServer();

server.listen(port, () => {
  console.log(`new-api listening on port ${port}`);
});
