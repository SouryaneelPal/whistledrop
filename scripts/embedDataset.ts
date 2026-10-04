import fs from 'node:fs';
import path from 'node:path';
import { EMBEDDING_MODEL, loadEmbedder } from '../src/services/embedding.service';
import { readDatasetTexts } from './dataset';

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'ml/.cache/embeddings.json');

async function main() {
  const texts = readDatasetTexts();
  const embed = await loadEmbedder();

  const rows = [];
  for (const text of texts) rows.push({ text, vector: await embed(text) });

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify({ model: EMBEDDING_MODEL, rows }));
  console.log(`Embedded ${rows.length} reports into ${path.relative(ROOT, OUTPUT)}`);
}

main().catch((err) => {
  console.error(`Could not embed the dataset: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
