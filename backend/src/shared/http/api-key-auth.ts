import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

function keysMatch(received: string, expected: string): boolean {
  const receivedDigest = createHash('sha256').update(received).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(receivedDigest, expectedDigest);
}

export function createApiKeyAuth(expectedKey: string): RequestHandler {
  return (request, response, next) => {
    const received = request.header('x-rpg-key');
    if (received === undefined || !keysMatch(received, expectedKey)) {
      response.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
      return;
    }
    next();
  };
}
