import { Router } from 'express';

export interface ReadinessCheck {
  check(timeoutMs: number): Promise<boolean>;
}

export interface ReleaseInfo {
  status: 'ok';
  commit: string;
  branch: string;
  nodeVersion: string;
}

export function createReleaseInfo(
  environment: NodeJS.ProcessEnv = process.env,
  nodeVersion = process.version,
): ReleaseInfo {
  return {
    status: 'ok',
    commit: environment.RENDER_GIT_COMMIT?.trim() || 'local',
    branch: environment.RENDER_GIT_BRANCH?.trim() || 'local',
    nodeVersion,
  };
}

export function createHealthRouter(readiness: ReadinessCheck, releaseInfo = createReleaseInfo()) {
  return Router()
    .get('/', (_request, response) => {
      response.json({ status: 'ok' });
    })
    .get('/version', (_request, response) => {
      response.json(releaseInfo);
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
