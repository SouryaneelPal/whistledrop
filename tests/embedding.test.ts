import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEmbedder } from '../src/services/embedding.service';

const MODELS_DIR = path.join(__dirname, '../.models');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loading the embedding model', () => {
  it('fails without downloading anything when the local model is missing', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'whistledrop-models-'));

    await expect(loadEmbedder({ modelsDir: empty })).rejects.toThrow(/not found locally/);
    expect(fetch).not.toHaveBeenCalled();

    fs.rmSync(empty, { recursive: true, force: true });
  });

  // Only runs after npm run build has fetched the model.
  it.skipIf(!fs.existsSync(MODELS_DIR))('loads the local model with network access blocked', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network blocked'));

    const embed = await loadEmbedder();

    expect(await embed('Model check.')).toHaveLength(384);
    expect(fetch).not.toHaveBeenCalled();
  }, 30_000);
});
