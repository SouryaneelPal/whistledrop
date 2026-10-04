import http from 'node:http';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../src/middleware/errorHandler';
import { createLimiter } from '../src/middleware/rateLimit';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// Loads a fresh copy of the real app so it reads TRUST_PROXY again.
async function trustSettingFor(trustProxy?: string) {
  if (trustProxy !== undefined) vi.stubEnv('TRUST_PROXY', trustProxy);
  vi.resetModules();
  const { default: app } = await import('../src/app');
  return app.get('trust proxy');
}

// The real limiter factory with skipping off, allowing one request per client.
async function requestsFrom(trustProxy: unknown, clients: string[]) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.get('/', createLimiter(60_000, 1, false), (_req, res) => {
    res.sendStatus(204);
  });
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const statuses = [];
  for (const client of clients) {
    statuses.push((await request(server).get('/').set('X-Forwarded-For', client)).status);
  }

  server.close();
  return statuses;
}

describe('TRUST_PROXY', () => {
  it('counts clients with different X-Forwarded-For addresses separately when set to 1', async () => {
    const trust = await trustSettingFor('1');

    expect(trust).toBe(1);
    expect(await requestsFrom(trust, ['203.0.113.1', '203.0.113.2'])).toEqual([204, 204]);
  });

  it('ignores X-Forwarded-For when unset', async () => {
    // express-rate-limit warns about the untrusted header, which is exactly this case.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const trust = await trustSettingFor();

    expect(trust).toBe(false);
    expect(await requestsFrom(trust, ['203.0.113.1', '203.0.113.2'])).toEqual([204, 429]);
  });
});
