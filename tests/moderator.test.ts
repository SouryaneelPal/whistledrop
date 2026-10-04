import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { api, createModerator, loginAs, PASSWORD, signToken, submitReport } from './helpers';

function login(username: string, password: string) {
  return api.post('/api/moderator/login').send({ username, password });
}

describe('POST /api/moderator/login', () => {
  beforeEach(async () => {
    await createModerator('alice');
  });

  it('succeeds with correct credentials', async () => {
    const res = await login('alice', PASSWORD);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: expect.any(String), expiresIn: 3600 });
  });

  it('gives the same 401 for a wrong password and an unknown user', async () => {
    const wrongPassword = await login('alice', 'not the password');
    const unknownUser = await login('mallory', PASSWORD);

    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknownUser.status).toBe(401);
    expect(unknownUser.body).toEqual(wrongPassword.body);
  });

  it('logs in with the username in uppercase', async () => {
    const res = await login('  ALICE ', PASSWORD);

    expect(res.status).toBe(200);
  });
});

describe('moderator authentication', () => {
  let moderatorId: string;

  beforeEach(async () => {
    moderatorId = (await createModerator()).id;
  });

  async function expectRejected(authorization?: string) {
    const req = api.get('/api/moderator/reports');
    const res = await (authorization ? req.set('Authorization', authorization) : req);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  }

  it('rejects requests with no token', async () => {
    await expectRejected();
  });

  it('rejects a garbage token', async () => {
    await expectRejected('Bearer not.a.token');
    await expectRejected('Basic abc');
  });

  it('rejects an expired token', async () => {
    const token = signToken({ sub: moderatorId, role: 'moderator' }, { expiresIn: -60 });

    await expectRejected(`Bearer ${token}`);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const token = signToken({ sub: moderatorId, role: 'moderator' }, { secret: 'some-other-secret-value' });

    await expectRejected(`Bearer ${token}`);
  });

  it('rejects an alg none token', async () => {
    const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const token = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      sub: moderatorId,
      role: 'moderator',
      iss: 'whistledrop',
      iat: now,
      exp: now + 3600,
    })}.`;

    await expectRejected(`Bearer ${token}`);
  });

  it('rejects a token without the moderator role', async () => {
    const token = signToken({ sub: moderatorId, role: 'reporter' });

    await expectRejected(`Bearer ${token}`);
  });

  it('rejects a token for a moderator who was deleted', async () => {
    const token = await loginAs();
    await prisma.moderator.delete({ where: { id: moderatorId } });

    await expectRejected(`Bearer ${token}`);
  });
});

describe('GET /api/moderator/reports', () => {
  let token: string;

  beforeEach(async () => {
    await createModerator();
    token = await loginAs();
  });

  function list(query = '') {
    return api.get(`/api/moderator/reports${query}`).set('Authorization', `Bearer ${token}`);
  }

  async function createAt(minutesAgo: number, data: { category?: string; status?: string; description?: string } = {}) {
    return prisma.report.create({
      data: {
        caseCodeHash: `hash-${Math.random()}`,
        category: 'OTHER',
        description: 'Something happened that should be looked at.',
        createdAt: new Date(Date.now() - minutesAgo * 60_000),
        ...data,
      },
    });
  }

  it('lists reports newest first', async () => {
    const old = await createAt(30);
    const newest = await createAt(1);
    const middle = await createAt(10);

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { id: string }) => r.id)).toEqual([newest.id, middle.id, old.id]);
    expect(res.body).toMatchObject({ page: 1, limit: 20, total: 3 });
    expect(Object.keys(res.body.data[0]).sort()).toEqual(
      ['category', 'createdAt', 'descriptionPreview', 'id', 'status', 'triage', 'updatedAt'],
    );
  });

  it('cuts the description preview at 120 characters', async () => {
    await createAt(1, { description: 'x'.repeat(300) });

    const res = await list();

    expect(res.body.data[0].descriptionPreview).toBe('x'.repeat(120));
  });

  it('filters by category', async () => {
    const security = await createAt(1, { category: 'SECURITY' });
    await createAt(2, { category: 'OTHER' });

    const res = await list('?category=SECURITY');

    expect(res.body.data.map((r: { id: string }) => r.id)).toEqual([security.id]);
    expect(res.body.total).toBe(1);
  });

  it('filters by status', async () => {
    await createAt(1);
    const reviewing = await createAt(2, { status: 'UNDER_REVIEW' });

    const res = await list('?status=UNDER_REVIEW');

    expect(res.body.data.map((r: { id: string }) => r.id)).toEqual([reviewing.id]);
  });

  it('searches the description with q in any letter case', async () => {
    const match = await createAt(1, { description: 'Payroll numbers were changed after approval.' });
    await createAt(2, { description: 'The fire exit on floor two is blocked.' });

    for (const q of ['payroll', 'PAYROLL', 'PayRoll']) {
      const res = await list(`?q=${q}`);

      expect(res.body.data.map((r: { id: string }) => r.id)).toEqual([match.id]);
    }
  });

  it('paginates', async () => {
    const reports = [];
    for (let i = 0; i < 5; i++) reports.push(await createAt(i));

    const res = await list('?page=2&limit=2');

    expect(res.body).toMatchObject({ page: 2, limit: 2, total: 5 });
    expect(res.body.data.map((r: { id: string }) => r.id)).toEqual([reports[2].id, reports[3].id]);
  });

  it('rejects an unknown filter value and an unknown query param', async () => {
    for (const query of ['?category=GOSSIP', '?status=OPEN', '?sort=asc', '?limit=500', '?page=abc']) {
      const res = await list(query);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('GET /api/moderator/reports/:id', () => {
  let token: string;

  beforeEach(async () => {
    await createModerator();
    token = await loginAs();
  });

  it('shows one report with its updates', async () => {
    const { id } = await submitReport({ evidenceUrl: 'https://example.com/badge.png' });

    const res = await api.get(`/api/moderator/reports/${id}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id,
      category: 'SECURITY',
      description: 'Badge readers on floor 3 accept any card.',
      evidenceUrl: 'https://example.com/badge.png',
      status: 'SUBMITTED',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      updates: [{ status: 'SUBMITTED', message: 'Report received', createdAt: expect.any(String), by: null }],
      triage: expect.objectContaining({ confidence: expect.any(Number) }),
    });
  });

  it('returns 404 for an unknown or malformed report id', async () => {
    for (const id of ['00000000-0000-0000-0000-000000000000', 'nope']) {
      const res = await api.get(`/api/moderator/reports/${id}`).set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('REPORT_NOT_FOUND');
    }
  });
});

describe('moderator responses', () => {
  it('never contain caseCodeHash and are not cacheable', async () => {
    await createModerator();
    const token = await loginAs();
    const { id } = await submitReport();
    const { caseCodeHash } = await prisma.report.findUniqueOrThrow({ where: { id } });
    const auth = { Authorization: `Bearer ${token}` };

    const responses = [
      await api.get('/api/moderator/reports').set(auth),
      await api.get(`/api/moderator/reports/${id}`).set(auth),
      await api.post(`/api/moderator/reports/${id}/updates`).set(auth).send({ message: 'Looking into it.' }),
      await api
        .patch(`/api/moderator/reports/${id}/status`)
        .set(auth)
        .send({ status: 'UNDER_REVIEW', message: 'Under review now.' }),
    ];

    for (const res of responses) {
      expect(res.status).toBeLessThan(300);
      expect(res.text).not.toContain('caseCodeHash');
      expect(res.text).not.toContain(caseCodeHash);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });
});
