import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 } as const;

function toSeconds(value: string) {
  const unit = value.at(-1) as keyof typeof UNIT_SECONDS;
  return unit in UNIT_SECONDS ? parseInt(value, 10) * UNIT_SECONDS[unit] : parseInt(value, 10);
}

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(16, 'Must be at least 16 characters'),
    JWT_EXPIRES_IN: z
      .string()
      .regex(/^[1-9]\d*[smhd]?$/, 'Use seconds or a number with s, m, h or d, for example 1h')
      .default('1h')
      .transform(toSeconds),
    PORT: z.coerce.number().int().positive().default(3000),
    SUBMIT_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(30),
    TRACK_LIMIT_PER_15_MIN: z.coerce.number().int().positive().default(30),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    ML_EMBEDDINGS: z.enum(['on', 'off']).default('on'),
    TRIAGE_BUDGET_MS: z.coerce.number().int().positive().default(1500),
  })
  .refine((env) => env.NODE_ENV !== 'production' || !env.JWT_SECRET.startsWith('change-me'), {
    message: 'Set a real secret in production',
    path: ['JWT_SECRET'],
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid environment variables:\n${z.prettifyError(parsed.error)}`);
}

export const env = parsed.data;
