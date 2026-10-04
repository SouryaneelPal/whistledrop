import { afterEach, expect, it, vi } from 'vitest';
import { prisma } from '../src/db';
import { logger } from '../src/utils/logger';
import { api } from './helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

const headers = {
  'User-Agent': 'ProbeBrowser/7.3 (zq-unique-agent)',
  'X-Forwarded-For': '198.51.100.73',
  Referer: 'https://zq-unique-referer.example/leak',
  Origin: 'https://zq-unique-origin.example',
  Cookie: 'session=zq-unique-cookie-value',
};

function capturePrinted() {
  const printed: unknown[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args) => printed.push(args));
  }
  const loggerSpies = (['info', 'warn', 'error'] as const).map((method) => vi.spyOn(logger, method));

  return () => JSON.stringify([printed, loggerSpies.map((spy) => spy.mock.calls)]);
}

async function allRows() {
  return JSON.stringify([
    await prisma.report.findMany(),
    await prisma.statusUpdate.findMany(),
    await prisma.moderator.findMany(),
  ]);
}

it('stores and prints none of the identifying request headers', async () => {
  const printed = capturePrinted();

  const submitted = await api
    .post('/api/reports')
    .set(headers)
    .send({ category: 'OTHER', description: 'Someone is shredding contracts after hours.' });
  const tracked = await api.get('/api/reports/status').set(headers).set('X-Case-Code', submitted.body.caseCode);

  expect(submitted.status).toBe(201);
  expect(tracked.status).toBe(200);

  const rows = await allRows();
  const logs = printed();

  for (const value of Object.values(headers)) {
    expect(rows).not.toContain(value);
    expect(logs).not.toContain(value);
  }
  expect(rows).not.toContain('zq-unique');
  expect(logs).not.toContain('zq-unique');
});

it('neither stores nor prints text sent to the identity check', async () => {
  const printed = capturePrinted();
  const description = 'My name is Zqvelda, mail zqvelda.k@example.org or call 9876543210';

  const res = await api.post('/api/reports/check').set(headers).send({ description });

  expect(res.status).toBe(200);
  expect(res.body.warnings.length).toBeGreaterThan(0);
  expect(res.text).not.toContain('Zqvelda');
  expect(res.text).not.toContain('9876543210');

  const rows = await allRows();
  const logs = printed();

  expect(await prisma.report.count()).toBe(0);
  for (const value of ['Zqvelda', 'zqvelda.k@example.org', '9876543210', ...Object.values(headers)]) {
    expect(rows).not.toContain(value);
    expect(logs).not.toContain(value);
  }
});
