import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { prisma } from '../db';
import { AppError } from '../utils/AppError';

export const BCRYPT_COST = 12;
const ISSUER = 'whistledrop';
const ROLE = 'moderator';

// Unknown usernames are checked against this hash so response time does not reveal which
// usernames exist. It must use the same cost as real hashes, or the timing would differ.
const dummyHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), BCRYPT_COST);

export async function authenticate(username: string, password: string) {
  const moderator = await prisma.moderator.findUnique({ where: { username } });
  const valid = await bcrypt.compare(password, moderator?.passwordHash ?? dummyHash);

  if (!moderator || !valid) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');

  const token = jwt.sign({ role: ROLE }, env.JWT_SECRET, {
    algorithm: 'HS256',
    issuer: ISSUER,
    subject: moderator.id,
    expiresIn: env.JWT_EXPIRES_IN,
  });

  return { token, expiresIn: env.JWT_EXPIRES_IN };
}

export function verifyToken(token: string) {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'], issuer: ISSUER });
    if (typeof payload === 'string' || payload.role !== ROLE || typeof payload.sub !== 'string') return null;
    return payload.sub;
  } catch {
    return null;
  }
}

export function findModerator(id: string) {
  return prisma.moderator.findUnique({ where: { id }, select: { id: true } });
}
