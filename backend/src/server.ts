import 'dotenv/config';
import { createApp } from './app.js';
import { parseConfig } from './config/env.js';
import { prismaActorRepository } from './modules/actors/actors.repository.js';
import { prismaContentRepository } from './modules/content/content.repository.js';
import { prismaGptRepository } from './modules/gpt/gpt.repository.js';
import { prismaReadinessCheck } from './modules/health/health.repository.js';
import { disconnectPrisma } from './shared/database/prisma.js';

const config = parseConfig(process.env);
const app = createApp(config, {
  actorRepository: prismaActorRepository,
  contentRepository: prismaContentRepository,
  gptRepository: prismaGptRepository,
  readiness: prismaReadinessCheck,
});
const server = app.listen(config.PORT, config.HOST, () => { console.info(`cronicas-backend listening on port ${config.PORT}`); });

let shutdownStarted = false;

async function shutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
  await disconnectPrisma();
}

function requestShutdown(): void {
  void shutdown().catch(() => {
    process.exitCode = 1;
  });
}

process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);
