import express, { NextFunction, Request, Response } from 'express';
import v2Router from './routes/v2';

const app = express();

app.use(express.json());
app.use('/v2', v2Router);

app.use((req: Request, res: Response) => {
  res.status(404).json({
    timestamp: new Date().toISOString(),
    status: 404,
    error: 'Not Found',
    message: `No endpoint found for ${req.method} ${req.originalUrl}`,
    path: req.originalUrl
  });
});

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({
    timestamp: new Date().toISOString(),
    status: 500,
    error: 'Internal Server Error',
    message: 'Unexpected internal error',
    path: req.originalUrl
  });
});

export default app;
