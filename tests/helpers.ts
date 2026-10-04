import http from 'node:http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/db';
import { hashCaseCode, normalizeCaseCode } from '../src/services/caseCode.service';

// SuperTest alone listens on the IPv6 wildcard but connects to 127.0.0.1, where on macOS another
// process can own the same port. tests/setup.ts binds this server to 127.0.0.1 instead.
export const server = http.createServer(app);
export const api = request(server);

export const PASSWORD = 'correct horse battery staple';

export async function createModerator(username = 'alice') {
  // Cost 4 keeps the suite fast; real hashes use cost 12.
  return prisma.moderator.create({ data: { username, passwordHash: await bcrypt.hash(PASSWORD, 4) } });
}

export async function loginAs(username = 'alice') {
  const res = await api.post('/api/moderator/login').send({ username, password: PASSWORD });
  return res.body.token as string;
}

export function signToken(payload: object, { secret = env.JWT_SECRET, expiresIn = 3600 } = {}) {
  return jwt.sign(payload, secret, { algorithm: 'HS256', issuer: 'whistledrop', expiresIn });
}

export async function submitReport(body: object = {}) {
  const res = await api
    .post('/api/reports')
    .send({ category: 'SECURITY', description: 'Badge readers on floor 3 accept any card.', ...body });
  const caseCode: string = res.body.caseCode;
  const report = await prisma.report.findUniqueOrThrow({
    where: { caseCodeHash: hashCaseCode(normalizeCaseCode(caseCode)!) },
  });

  return { caseCode, id: report.id };
}
