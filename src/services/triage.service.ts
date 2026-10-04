import { env } from '../config/env';
import { CATEGORIES } from '../domain/statusWorkflow';
import head from '../ml/embedding-head.json';
import model from '../ml/model.json';
import { logger } from '../utils/logger';
import { EMBEDDING_MODEL, Embedder, loadEmbedder } from './embedding.service';

// Both models mirror scikit-learn's predict_proba so results match ml/train.py (checked by
// tests/triage.test.ts). Suggestions are computed on read and never stored.

type Suggestion = {
  model: 'embeddings' | 'tfidf';
  suggestedCategory: string | null;
  reason: string | null;
  confidence: number;
  topTerms: string[];
};

// A model trained on other labels would suggest values the rest of the API does not know.
function checkLabels(classes: string[], file: string) {
  const same = classes.length === CATEGORIES.length && CATEGORIES.every((label) => classes.includes(label));
  if (!same) throw new Error(`${file} labels do not match CATEGORIES; rerun ml/train.py`);
}

checkLabels(model.classes, 'src/ml/model.json');
checkLabels(head.classes, 'src/ml/embedding-head.json');

const vocabulary = new Map(model.vocabulary.map((term, index) => [term, index]));

export const CACHE_SIZE = 500;

let embedder: Embedder | null = null;
let lastEmbed: Promise<unknown> = Promise.resolve();

// Embedding results by report id. Report text never changes after submission, so a result
// stays valid; only the suggestion is kept, never the text, and only in memory.
const cache = new Map<string, Suggestion>();

// scikit-learn lowercases, then takes runs of two or more word characters (\b\w\w+\b).
function tokenize(text: string) {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.filter((word) => [...word].length >= 2);
}

function vectorize(text: string) {
  const tokens = tokenize(text);
  const bigrams = tokens.slice(1).map((token, i) => `${tokens[i]} ${token}`);
  const weights = new Map<number, number>();

  for (const term of [...tokens, ...bigrams]) {
    const index = vocabulary.get(term);
    if (index !== undefined) weights.set(index, (weights.get(index) ?? 0) + 1);
  }

  for (const [index, count] of weights) weights.set(index, count * model.idf[index]);

  const norm = Math.sqrt([...weights.values()].reduce((sum, w) => sum + w * w, 0));
  if (norm > 0) {
    for (const [index, w] of weights) weights.set(index, w / norm);
  }

  return weights;
}

function softmaxTop(scores: number[]) {
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - max));
  const total = exps.reduce((sum, e) => sum + e, 0);
  const index = scores.indexOf(max);
  return { index, probability: exps[index] / total };
}

function topTerms(x: Map<number, number>, coef: number[]) {
  return [...x]
    .map(([index, w]) => ({ term: model.vocabulary[index], push: w * coef[index] }))
    .filter((t) => t.push > 0)
    .sort((a, b) => b.push - a.push)
    .slice(0, 3)
    .map((t) => t.term);
}

// Below each model's threshold (chosen in ml/metrics.md) its top category is wrong too often to show.
function toSuggestion(
  name: Suggestion['model'],
  label: string,
  probability: number,
  threshold: number,
  terms: string[],
): Suggestion {
  const confident = probability >= threshold;
  return {
    model: name,
    suggestedCategory: confident ? label : null,
    reason: confident ? null : 'low confidence',
    confidence: Math.round(probability * 1000) / 1000,
    topTerms: terms,
  };
}

export function suggestWithTfidf(text: string) {
  const x = vectorize(text);
  const scores = model.intercept.map((bias, k) => {
    let score = bias;
    for (const [index, w] of x) score += w * model.coef[k][index];
    return score;
  });
  const top = softmaxTop(scores);

  return toSuggestion('tfidf', model.classes[top.index], top.probability, model.threshold, topTerms(x, model.coef[top.index]));
}

// Embeddings carry no per-word weights, so this model has no top terms to show.
export function classifyEmbedding(vector: number[]) {
  const scores = head.intercept.map((bias, k) => head.coef[k].reduce((sum, c, i) => sum + c * vector[i], bias));
  const top = softmaxTop(scores);

  return toSuggestion('embeddings', head.classes[top.index], top.probability, head.threshold, []);
}

// Loads in the background. Until it is ready, or if it fails, suggestions come from TF-IDF.
export function startEmbeddings(load: () => Promise<Embedder> = loadEmbedder) {
  embedder = null;
  cache.clear();

  if (head.embeddingModel !== EMBEDDING_MODEL) {
    logger.warn('Triage model: tfidf (embedding-head.json was trained on another embedding model)');
    return Promise.resolve();
  }

  return load().then(
    (loaded) => {
      embedder = loaded;
      logger.info(`Triage model: embeddings (${EMBEDDING_MODEL})`);
    },
    (err: unknown) => {
      logger.warn(`Triage model: tfidf (embedding model unavailable: ${err instanceof Error ? err.message : 'unknown error'})`);
    },
  );
}

function remember(id: string, suggestion: Suggestion) {
  cache.delete(id);
  cache.set(id, suggestion);
  // Map keeps insertion order, so the first key is the least recently used.
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
}

// One embedding at a time across all requests: on a small CPU, parallel ONNX runs fight over
// the same cores. Resolves to null if the request's time budget ran out while waiting.
function embedInTurn(embed: Embedder, text: string, deadline: number) {
  const turn = lastEmbed.then(() => (performance.now() < deadline ? embed(text) : null));
  lastEmbed = turn.catch(() => undefined);
  return turn;
}

async function suggestOne(report: { id: string; description: string }, deadline: number) {
  const cached = cache.get(report.id);
  if (cached) {
    remember(report.id, cached);
    return cached;
  }
  if (!embedder) return suggestWithTfidf(report.description);

  try {
    const vector = await embedInTurn(embedder, report.description, deadline);
    if (!vector) return suggestWithTfidf(report.description);

    const suggestion = classifyEmbedding(vector);
    remember(report.id, suggestion);
    return suggestion;
  } catch (err) {
    // Only the error name is logged; inference errors could otherwise quote report text.
    logger.warn(`Embedding failed, using TF-IDF: ${err instanceof Error ? err.name : 'unknown error'}`);
    return suggestWithTfidf(report.description);
  }
}

// Reports are handled one by one. Once the budget is spent, the rest of the response uses
// TF-IDF, so a slow CPU makes suggestions worse rather than the page slower.
export async function triageReports(reports: { id: string; description: string }[], budgetMs = env.TRIAGE_BUDGET_MS) {
  const deadline = performance.now() + budgetMs;
  const suggestions: Suggestion[] = [];
  for (const report of reports) suggestions.push(await suggestOne(report, deadline));
  return suggestions;
}
