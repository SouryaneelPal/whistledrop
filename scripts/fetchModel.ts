import { EMBEDDING_MODEL, loadEmbedder } from '../src/services/embedding.service';

const ATTEMPTS = 3;
const WAIT_MS = 3000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const embed = await loadEmbedder({ download: true });
      const vector = await embed('Model check.');
      console.log(`${EMBEDDING_MODEL} ready in .models (${vector.length} dimensions)`);
      return;
    } catch (err) {
      console.warn(`Fetching ${EMBEDDING_MODEL} failed (attempt ${attempt} of ${ATTEMPTS}): ${err instanceof Error ? err.message : err}`);
      if (attempt < ATTEMPTS) await sleep(WAIT_MS);
    }
  }

  // The build still succeeds: without the model the server runs on the TF-IDF fallback.
  console.warn(`WARNING: ${EMBEDDING_MODEL} could not be downloaded. The server will use TF-IDF triage until a build fetches it.`);
}

main();
