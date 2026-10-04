import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';

// Counters live only in process memory and expire with their window. They are never stored or
// logged, so no record of who contacted the service outlives the window.
export function createLimiter(windowMs: number, limit: number, skipInTests = true) {
  return rateLimit({
    windowMs,
    limit,
    // draft-8 adds a pk= partition key to RateLimit-Policy that is derived from the client IP.
    standardHeaders: 'draft-6',
    legacyHeaders: false,
    // All Supertest requests share one loopback address, so limits are off under Vitest only.
    skip: () => skipInTests && env.NODE_ENV === 'test',
    handler: (_req, _res, next) => {
      next(new AppError(429, 'RATE_LIMITED', 'Too many requests, try again later'));
    },
  });
}

export const submitLimiter = createLimiter(60 * 60 * 1000, env.SUBMIT_LIMIT_PER_HOUR);
export const trackLimiter = createLimiter(15 * 60 * 1000, env.TRACK_LIMIT_PER_15_MIN);
export const checkLimiter = createLimiter(15 * 60 * 1000, 60);
export const loginLimiter = createLimiter(15 * 60 * 1000, 5);
