import path from 'node:path';
import { expect, it } from 'vitest';
import YAML from 'yamljs';
import { api } from './helpers';

it('serves Swagger UI with a spec that documents every operation', async () => {
  const page = await api.get('/docs/');
  const init = await api.get('/docs/swagger-ui-init.js');
  const spec = YAML.load(path.join(__dirname, '../src/docs/openapi.yaml'));
  const operations = Object.entries(spec.paths).flatMap(([route, methods]) =>
    Object.keys(methods as object).map((method) => `${method.toUpperCase()} ${route}`),
  );

  expect(page.status).toBe(200);
  expect(page.headers['content-type']).toMatch(/text\/html/);
  expect(init.text).toContain('WhistleDrop API');
  expect(spec.openapi).toMatch(/^3\./);
  expect(operations.sort()).toEqual(
    [
      'GET /health',
      'POST /api/reports',
      'GET /api/reports/status',
      'POST /api/reports/check',
      'POST /api/moderator/login',
      'GET /api/moderator/reports',
      'GET /api/moderator/reports/{id}',
      'PATCH /api/moderator/reports/{id}/status',
      'POST /api/moderator/reports/{id}/updates',
    ].sort(),
  );
});

it('redirects the root URL to the docs', async () => {
  const res = await api.get('/');

  expect(res.status).toBe(302);
  expect(res.headers.location).toBe('/docs/');
});
