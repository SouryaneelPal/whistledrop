import { ChildProcess, execFileSync, execSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { readDatasetTexts } from './dataset';

const ROOT = path.join(__dirname, '..');
const DATABASE_URL = 'file:./memcheck.db';
const DB_FILE = path.join(ROOT, 'prisma/memcheck.db');
const PORT = 4310;
const LIMIT_MB = 380;
const REPORTS = 100;
const REQUESTS = 50;
const PAGE_SIZE = 20;
const PASSWORD = crypto.randomBytes(16).toString('hex');

type Run = { peakMb: number; readyMb: number; firstMs: number; repeatMs: number; models: Set<string> };

function removeDatabase() {
  for (const file of [DB_FILE, `${DB_FILE}-journal`]) fs.rmSync(file, { force: true });
}

async function seed() {
  removeDatabase();
  execSync('npx prisma db push --skip-generate', { cwd: ROOT, env: { ...process.env, DATABASE_URL }, stdio: 'ignore' });

  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const texts = readDatasetTexts();
  await prisma.moderator.create({ data: { username: 'memcheck', passwordHash: await bcrypt.hash(PASSWORD, 4) } });
  for (let i = 0; i < REPORTS; i++) {
    await prisma.report.create({
      data: {
        caseCodeHash: crypto.randomBytes(32).toString('hex'),
        category: 'OTHER',
        description: texts[(i * 3) % texts.length],
      },
    });
  }
  await prisma.$disconnect();
}

function rssMb(pid: number) {
  const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim());
  return kb / 1024;
}

function waitForLine(server: ChildProcess, pattern: RegExp, failure: RegExp) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}`)), 120_000);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      if (failure.test(text)) reject(new Error(text.trim()));
      if (!pattern.test(text)) return;
      clearTimeout(timer);
      server.stdout?.off('data', onData);
      resolve();
    };
    server.stdout?.on('data', onData);
    server.stderr?.on('data', onData);
  });
}

async function measure(embeddings: boolean): Promise<Run> {
  const server = spawn('node', ['dist/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL,
      PORT: String(PORT),
      JWT_SECRET: crypto.randomBytes(32).toString('hex'),
      TRUST_PROXY: '0',
      ML_EMBEDDINGS: embeddings ? 'on' : 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = server.pid!;

  let peakMb = 0;
  // Sampled every 100 ms, so a spike shorter than that could be missed.
  const sampler = setInterval(() => {
    peakMb = Math.max(peakMb, rssMb(pid));
  }, 100);

  try {
    await waitForLine(server, embeddings ? /Triage model: embeddings/ : /Triage model: tfidf/, /unavailable|Error/);
    const readyMb = rssMb(pid);
    const base = `http://127.0.0.1:${PORT}`;

    const login = await fetch(`${base}/api/moderator/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'memcheck', password: PASSWORD }),
    });
    const { token } = (await login.json()) as { token: string };

    const models = new Set<string>();
    const pages = REPORTS / PAGE_SIZE;
    const first: number[] = [];
    const repeat: number[] = [];
    for (let i = 0; i < REQUESTS; i++) {
      const page = (i % pages) + 1;
      const started = performance.now();
      const res = await fetch(`${base}/api/moderator/reports?limit=${PAGE_SIZE}&page=${page}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as { data: { triage: { model: string } }[] };
      // The first pass over the pages embeds every report; later passes hit the cache.
      (i < pages ? first : repeat).push(performance.now() - started);
      for (const report of body.data) models.add(report.triage.model);
    }
    peakMb = Math.max(peakMb, rssMb(pid));

    const average = (times: number[]) => times.reduce((sum, t) => sum + t, 0) / times.length;
    return { peakMb, readyMb, firstMs: average(first), repeatMs: average(repeat), models };
  } finally {
    clearInterval(sampler);
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
}

function describe(name: string, run: Run) {
  return [
    `${name}:`,
    `  models used:            ${[...run.models].join(', ')}`,
    `  RSS when ready:         ${run.readyMb.toFixed(0)} MB`,
    `  peak RSS:               ${run.peakMb.toFixed(0)} MB`,
    `  first list request:     ${run.firstMs.toFixed(1)} ms avg for ${PAGE_SIZE} reports (${REPORTS / PAGE_SIZE} requests)`,
    `  repeat list request:    ${run.repeatMs.toFixed(1)} ms avg (${REQUESTS - REPORTS / PAGE_SIZE} requests)`,
  ].join('\n');
}

async function main() {
  execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
  await seed();

  try {
    const withEmbeddings = await measure(true);
    const withTfidf = await measure(false);

    console.log(`${REPORTS} seeded reports, ${REQUESTS} list requests of ${PAGE_SIZE}, NODE_ENV=production\n`);
    console.log(describe('Embeddings (ML_EMBEDDINGS=on)', withEmbeddings));
    console.log(describe('TF-IDF only (ML_EMBEDDINGS=off)', withTfidf));
    const triageMs = (withEmbeddings.firstMs - withTfidf.firstMs) / PAGE_SIZE;
    console.log(`\nEmbedding cost per uncached report over TF-IDF: ${triageMs.toFixed(2)} ms`);

    if (!withEmbeddings.models.has('embeddings') || withEmbeddings.models.size !== 1) {
      throw new Error('the embeddings run did not use the embedding model for every report');
    }
    if (withEmbeddings.peakMb > LIMIT_MB) {
      console.log(`\nFAIL: peak RSS ${withEmbeddings.peakMb.toFixed(0)} MB is over the ${LIMIT_MB} MB gate.`);
      process.exitCode = 1;
      return;
    }
    console.log(`\nPASS: peak RSS ${withEmbeddings.peakMb.toFixed(0)} MB is within the ${LIMIT_MB} MB gate.`);
  } finally {
    removeDatabase();
  }
}

main().catch((err) => {
  console.error(`memcheck failed: ${err instanceof Error ? err.message : err}`);
  removeDatabase();
  process.exitCode = 1;
});
