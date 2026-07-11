import { Router } from 'express';

export const healthRouter = Router().get('/', (_request, response) => {
  response.json({ status: 'ok', service: 'cronicas-backend', timestamp: new Date().toISOString() });
});
