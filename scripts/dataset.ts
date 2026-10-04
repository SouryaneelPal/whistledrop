import fs from 'node:fs';
import path from 'node:path';

const DATASET = path.join(__dirname, '../ml/dataset.csv');

// Only the text column is needed. Fields may be quoted, with "" for a literal quote.
export function readDatasetTexts() {
  const rows = fs.readFileSync(DATASET, 'utf8').trim().split('\n').slice(1);
  return rows.map((row) => {
    if (!row.startsWith('"')) return row.slice(0, row.indexOf(','));
    return row.slice(1, row.lastIndexOf('",')).replaceAll('""', '"');
  });
}
