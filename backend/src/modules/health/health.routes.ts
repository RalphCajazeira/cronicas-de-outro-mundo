import { Router } from 'express';

export interface ReadinessCheck {
  check(timeoutMs: number): Promise<boolean>;
}

export function createHealthRouter(readiness: ReadinessCheck) {
  return Router()
    .get('/', (_request, response) => {
      response.json({ status: 'ok' });
    })
    .get('/ready', async (_request, response) => {
      let ready: boolean;
      try {
        ready = await readiness.check(1_500);
      } catch {
        ready = false;
      }
      response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
    });
}
