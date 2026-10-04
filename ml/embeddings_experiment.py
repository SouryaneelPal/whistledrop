"""Offline experiment: TF-IDF baseline versus sentence embeddings for the category model.

Uses the same data, folds and threshold rule as train.py, and changes nothing that ships.
Run from the repo root with the local venv:
    ml/.venv/bin/python ml/embeddings_experiment.py
"""

import json
import platform
import resource
import statistics
import time
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression

from train import (
    FOLDS,
    MIN_SUGGESTED,
    RANDOM_STATE,
    TARGET_ACCURACY,
    choose_threshold,
    cross_validate,
    load,
    make_pipeline_for,
    matrix_table,
    threshold_table,
)

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "ml" / "experiments.md"
CACHE = ROOT / "ml" / ".cache"
ONNX_EMBEDDINGS = CACHE / "embeddings.json"
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
MIN_DF = 1  # what train.py ships with
LATENCY_RUNS = 50
SAMPLE = "The purchasing lead takes a cut from the vendor on every order."


def peak_rss_mb():
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # macOS reports bytes, Linux reports kilobytes.
    return peak / 1024 / 1024 if platform.system() == "Darwin" else peak / 1024


def folder_mb(path):
    # The Hugging Face cache links snapshot files to blobs; count each real file once.
    # embeddings.json is our own output, not part of the download.
    files = [f for f in path.rglob("*") if f.is_file() and not f.is_symlink() and f != ONNX_EMBEDDINGS]
    return sum(f.stat().st_size for f in files) / 1024 / 1024


def onnx_comparison(texts, categories, torch_vectors):
    if not ONNX_EMBEDDINGS.exists():
        return "Not run: `ml/.cache/embeddings.json` is missing. Run `npm run ml:embed` first."

    data = json.loads(ONNX_EMBEDDINGS.read_text(encoding="utf-8"))
    if [row["text"] for row in data["rows"]] != texts:
        return "Not run: `ml/.cache/embeddings.json` does not match dataset.csv. Rerun `npm run ml:embed`."

    onnx_vectors = np.array([row["vector"] for row in data["rows"]])
    # Both sets are L2-normalised, so the row-wise dot product is the cosine similarity.
    cosine = (onnx_vectors * torch_vectors).sum(axis=1)
    onnx = cross_validate(onnx_vectors, categories, lambda: LogisticRegression(max_iter=2000))
    onnx_rows = threshold_table(onnx)

    return f"""The server uses the quantised ONNX export of the same model through transformers.js
(`{data["model"]}`, int8). These are its vectors for the same {len(texts)} reports, from
`npm run ml:embed`, scored the same way.

| embeddings | accuracy | macro F1 | threshold by the 75% rule |
|---|---|---|---|
{{torch_row}}
{summary_row("quantised ONNX (transformers.js)", onnx, choose_threshold(onnx_rows), onnx_rows)}

Cosine similarity between the torch and ONNX vector for each report: mean {cosine.mean():.4f},
lowest {cosine.min():.4f}."""


def median_ms(predict):
    predict()  # warm-up
    times = []
    for _ in range(LATENCY_RUNS):
        start = time.perf_counter()
        predict()
        times.append((time.perf_counter() - start) * 1000)
    return statistics.median(times)


def summary_row(name, result, threshold, rows):
    (acc, acc_sd), (f1, f1_sd) = result["accuracy"], result["macro_f1"]
    if threshold is None:
        chosen = "none reaches the target"
    else:
        _, _, share, accuracy = next(row for row in rows if row[0] == threshold)
        chosen = f"{threshold:.3f} ({share:.0%} covered, {accuracy:.1%} right)"
    return f"| {name} | {acc:.3f} ± {acc_sd:.3f} | {f1:.3f} ± {f1_sd:.3f} | {chosen} |"


def coverage(rows, threshold):
    if threshold is None:
        return "no reports, since no threshold meets the rule"
    share = next(row for row in rows if row[0] == threshold)[2]
    return f"{share:.0%} of reports"


def threshold_lines(rows, threshold):
    lines = ["| threshold | reports with a suggestion | share | accuracy on those |", "|---|---|---|---|"]
    for t, count, share, accuracy in rows:
        mark = " (chosen)" if t == threshold else ""
        lines.append(f"| {t:.3f}{mark} | {count} | {share:.0%} | {accuracy:.3f} |")
    return "\n".join(lines)


def main():
    texts, categories, _ = load()

    tfidf = cross_validate(texts, categories, lambda: make_pipeline_for(MIN_DF))
    tfidf_rows = threshold_table(tfidf)
    tfidf_threshold = choose_threshold(tfidf_rows)
    tfidf_model = make_pipeline_for(MIN_DF).fit(texts, categories)
    tfidf_ms = median_ms(lambda: tfidf_model.predict_proba([SAMPLE]))

    rss_before_import = peak_rss_mb()
    # Imported here so the memory figures above do not include torch.
    from sentence_transformers import SentenceTransformer

    encoder = SentenceTransformer(MODEL_NAME, device="cpu", cache_folder=str(CACHE))
    rss_after_load = peak_rss_mb()

    # Embeddings do not learn from the labels, so computing them once for all texts does not
    # leak anything across folds; only the logistic regression is fitted per fold.
    start = time.perf_counter()
    embeddings = encoder.encode(texts, batch_size=32, show_progress_bar=False)
    embed_seconds = time.perf_counter() - start
    rss_after_embed = peak_rss_mb()

    embedded = cross_validate(embeddings, categories, lambda: LogisticRegression(max_iter=2000))
    embedded_rows = threshold_table(embedded)
    embedded_threshold = choose_threshold(embedded_rows)
    embedded_model = LogisticRegression(max_iter=2000).fit(embeddings, categories)
    embedded_ms = median_ms(lambda: embedded_model.predict_proba(encoder.encode([SAMPLE], show_progress_bar=False)))

    download_mb = folder_mb(CACHE)
    import torch

    torch_mb = folder_mb(Path(torch.__file__).parent)
    onnx_section = onnx_comparison(texts, categories, embeddings).replace(
        "{torch_row}",
        summary_row("torch (sentence-transformers)", embedded, embedded_threshold, embedded_rows),
    )

    (tfidf_f1, tfidf_sd), (embedded_f1, embedded_sd) = tfidf["macro_f1"], embedded["macro_f1"]
    beats = embedded_f1 - tfidf_f1 > tfidf_sd + embedded_sd
    fits = rss_after_embed < 512

    results = f"""# Embeddings experiment

Offline comparison only; nothing here changes the shipped model. Reproduce with
`ml/.venv/bin/python ml/embeddings_experiment.py` after
`ml/.venv/bin/pip install -r ml/requirements-experiment.txt` (torch and sentence-transformers,
about 1 GB). The shipped models need only `ml/requirements.txt`.

Same {len(texts)} reports, same stratified {FOLDS}-fold split (`random_state={RANDOM_STATE}`) and the
same threshold rule as `train.py`: the lowest threshold where suggestions are right at least
{TARGET_ACCURACY:.0%} of the time with at least {MIN_SUGGESTED} reports measured. Both models use
`LogisticRegression(max_iter=2000)` with default regularisation.

## Results

| model | accuracy | macro F1 | threshold by the 75% rule |
|---|---|---|---|
{summary_row(f"TF-IDF + LogisticRegression (min_df={MIN_DF}, shipped)", tfidf, tfidf_threshold, tfidf_rows)}
{summary_row("all-MiniLM-L6-v2 embeddings + LogisticRegression", embedded, embedded_threshold, embedded_rows)}

### TF-IDF thresholds

{threshold_lines(tfidf_rows, tfidf_threshold)}

### Embedding thresholds

{threshold_lines(embedded_rows, embedded_threshold)}

### Summed confusion matrices

TF-IDF:

{matrix_table(tfidf)}

Embeddings:

{matrix_table(embedded)}

## Quantised ONNX versus torch

{onnx_section}

## Cost

Measured on {platform.machine()} {platform.system()}, Python {platform.python_version()}, CPU only.
Peak memory is the peak resident size of this Python process, so it includes Python,
NumPy and scikit-learn as well as torch and the model. Memory and timing vary between runs
(by tens of MB and a few ms here), so treat them as rough figures.

| measurement | value |
|---|---|
| embedding model download (`{MODEL_NAME}`) | {download_mb:.0f} MB |
| torch package on disk | {torch_mb:.0f} MB |
| peak memory before importing torch | {rss_before_import:.0f} MB |
| peak memory after loading the model | {rss_after_load:.0f} MB |
| peak memory after embedding all {len(texts)} texts | {rss_after_embed:.0f} MB |
| time to embed all {len(texts)} texts | {embed_seconds:.1f} s |
| one prediction, TF-IDF (median of {LATENCY_RUNS}) | {tfidf_ms:.2f} ms |
| one prediction, embeddings (median of {LATENCY_RUNS}) | {embedded_ms:.2f} ms |

## Conclusion

**Does the embedding model meaningfully beat the baseline?** {"Yes" if beats else "No"}. Macro F1 is
{embedded_f1:.3f} ± {embedded_sd:.3f} against {tfidf_f1:.3f} ± {tfidf_sd:.3f}, a gap
{"larger" if beats else "no larger"} than the fold-to-fold spread of both models combined. It also
changes how useful the threshold is: under the same 75% rule the baseline suggests a category
for {coverage(tfidf_rows, tfidf_threshold)} and the embedding model for {coverage(embedded_rows, embedded_threshold)}.
The lowest threshold in the table is 0.200, one in five categories, so "100% covered" means
every report already clears the floor of the grid.

Two caveats. The dataset is {len(texts)} short reports written by one author, so both models
are judged on clean, similar wording and the gap may be smaller on real reports. And the
latency was measured on this machine with every CPU core available to torch; a small shared
server core would be slower.

**Would it fit on a 512 MB server?** {"Yes" if fits else "Not as measured"}. This Python process peaked
at {rss_after_embed:.0f} MB with torch and the model loaded, before any of the Node API is counted.
The model file itself is only {download_mb:.0f} MB; most of the memory is the torch runtime. A
lighter runtime (for example the same model exported to ONNX and run from Node) could need much
less, but that was not measured here.
"""
    RESULTS.write_text(results, encoding="utf-8")
    print(results)


if __name__ == "__main__":
    main()
