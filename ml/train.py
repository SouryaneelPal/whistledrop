"""Train the moderator category suggestion model and export it for the TypeScript service.

Run from the repo root with the local venv:
    ml/.venv/bin/python ml/train.py               # TF-IDF only
    ml/.venv/bin/python ml/train.py --embeddings  # also the embedding head (run npm run ml:embed first)
"""

import argparse
import csv
import json
from pathlib import Path

import numpy as np
from sklearn.dummy import DummyClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score
from sklearn.model_selection import StratifiedKFold
from sklearn.pipeline import make_pipeline

ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT / "ml" / "dataset.csv"
METRICS = ROOT / "ml" / "metrics.md"
MODEL = ROOT / "src" / "ml" / "model.json"
PARITY = ROOT / "tests" / "fixtures" / "triage-parity.json"
EMBEDDINGS = ROOT / "ml" / ".cache" / "embeddings.json"
EMBEDDING_HEAD = ROOT / "src" / "ml" / "embedding-head.json"
EMBEDDING_PARITY = ROOT / "tests" / "fixtures" / "embedding-parity.json"

RANDOM_STATE = 42
FOLDS = 5

# A suggestion is only shown when it is right at least this often in cross-validation,
# and the threshold must still leave enough reports with a suggestion to be measured.
TARGET_ACCURACY = 0.75
# The embedding head already meets 75% with no filtering, so that target would never withhold
# anything; it needs a higher bar for the threshold to act at all.
EMBEDDING_TARGET_ACCURACY = 0.90
MIN_SUGGESTED = 30
THRESHOLDS = [round(0.20 + 0.025 * i, 3) for i in range(21)]

# Fixed texts whose predictions the TypeScript port must reproduce. They include a text
# with no known words (below the threshold) and one with accented characters.
PARITY_TEXTS = [
    "Someone keeps forwarding confidential client files to a personal email address.",
    "My manager mocks my accent in every meeting and the team laughs along.",
    "The purchasing lead takes a cut from the vendor on every order.",
    "Backups have failed for two weeks and nobody checks the alerts.",
    "The stairs near the loading dock have no railing and someone will fall.",
    "A minor typo on the notice board, already fixed.",
    "Hello there.",
    "Le café du bureau est très sale, the canteen food made people sick.",
]

# Dataset rows whose embeddings are used for the embedding head parity test, one or more per
# category. A zero vector is added as well, which only the intercepts score.
PARITY_ROWS = [0, 60, 120, 180, 240, 299, 150]


def load():
    with DATASET.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    texts = [row["text"] for row in rows]
    return texts, [row["category"] for row in rows], [row["urgency"] for row in rows]


def make_vectorizer(min_df):
    # These settings are what the TypeScript tokenizer reproduces; change both together.
    return TfidfVectorizer(lowercase=True, ngram_range=(1, 2), token_pattern=r"\b\w\w+\b", min_df=min_df)


def make_pipeline_for(min_df):
    return make_pipeline(make_vectorizer(min_df), LogisticRegression(max_iter=2000))


def cross_validate(texts, labels, make_model):
    """Out-of-fold predictions plus per-fold scores, so every report is scored once by a
    model that never saw it."""
    texts, labels = np.array(texts), np.array(labels)
    classes = sorted(set(labels))
    folds = StratifiedKFold(n_splits=FOLDS, shuffle=True, random_state=RANDOM_STATE)

    predicted = np.empty(len(labels), dtype=object)
    top_probability = np.zeros(len(labels))
    accuracies, macro_f1s = [], []

    for train_idx, test_idx in folds.split(texts, labels):
        model = make_model().fit(texts[train_idx], labels[train_idx])
        probabilities = model.predict_proba(texts[test_idx])
        fold_predicted = model.classes_[probabilities.argmax(axis=1)]

        predicted[test_idx] = fold_predicted
        top_probability[test_idx] = probabilities.max(axis=1)
        accuracies.append(accuracy_score(labels[test_idx], fold_predicted))
        macro_f1s.append(f1_score(labels[test_idx], fold_predicted, average="macro", zero_division=0))

    return {
        "classes": classes,
        "labels": labels,
        "predicted": predicted,
        "top_probability": top_probability,
        "accuracy": (np.mean(accuracies), np.std(accuracies)),
        "macro_f1": (np.mean(macro_f1s), np.std(macro_f1s)),
        "matrix": confusion_matrix(labels, predicted, labels=classes),
    }


def baseline(texts, labels):
    return cross_validate(texts, labels, lambda: DummyClassifier(strategy="most_frequent"))


def score_line(name, result):
    (acc, acc_sd), (f1, f1_sd) = result["accuracy"], result["macro_f1"]
    return f"| {name} | {acc:.3f} ± {acc_sd:.3f} | {f1:.3f} ± {f1_sd:.3f} |"


def matrix_table(result):
    classes = result["classes"]
    lines = [
        "| actual \\ predicted | " + " | ".join(classes) + " |",
        "|" + "---|" * (len(classes) + 1),
    ]
    for label, row in zip(classes, result["matrix"]):
        lines.append(f"| {label} | " + " | ".join(str(n) for n in row) + " |")
    return "\n".join(lines)


def threshold_table(result):
    correct = result["predicted"] == result["labels"]
    rows = []
    for threshold in THRESHOLDS:
        shown = result["top_probability"] >= threshold
        accuracy = correct[shown].mean() if shown.any() else float("nan")
        rows.append((threshold, int(shown.sum()), shown.mean(), accuracy))
    return rows


def threshold_lines(rows, threshold):
    lines = ["| threshold | reports with a suggestion | share | accuracy on those |", "|---|---|---|---|"]
    for t, count, share, accuracy in rows:
        mark = " (chosen)" if t == threshold else ""
        shown = "n/a" if count == 0 else f"{accuracy:.3f}"
        lines.append(f"| {t:.3f}{mark} | {count} | {share:.0%} | {shown} |")
    return "\n".join(lines)


def choose_threshold(rows, target=TARGET_ACCURACY):
    # The lowest threshold that meets the accuracy target keeps the most suggestions.
    for threshold, count, _, accuracy in rows:
        if count >= MIN_SUGGESTED and accuracy >= target:
            return threshold
    return None


def export(texts, categories, min_df, threshold):
    vectorizer = make_vectorizer(min_df)
    x = vectorizer.fit_transform(texts)
    model = LogisticRegression(max_iter=2000).fit(x, categories)

    # The TypeScript side applies a softmax over every class, which is what scikit-learn
    # does for multinomial logistic regression with three or more classes.
    assert len(model.classes_) > 2

    MODEL.parent.mkdir(parents=True, exist_ok=True)
    MODEL.write_text(json.dumps({
        "vocabulary": vectorizer.get_feature_names_out().tolist(),
        "idf": vectorizer.idf_.tolist(),
        "classes": [str(c) for c in model.classes_],
        "coef": model.coef_.tolist(),
        "intercept": model.intercept_.tolist(),
        "threshold": threshold,
    }), encoding="utf-8")

    fixtures = []
    for text, probabilities in zip(PARITY_TEXTS, model.predict_proba(vectorizer.transform(PARITY_TEXTS))):
        best = probabilities.argmax()
        fixtures.append({
            "text": text,
            "topCategory": str(model.classes_[best]),
            "confidence": float(probabilities[best]),
            "suggestedCategory": str(model.classes_[best]) if probabilities[best] >= threshold else None,
        })

    PARITY.parent.mkdir(parents=True, exist_ok=True)
    PARITY.write_text(json.dumps(fixtures, indent=2) + "\n", encoding="utf-8")
    return len(vectorizer.vocabulary_)


def load_embeddings(texts):
    if not EMBEDDINGS.exists():
        raise SystemExit("ml/.cache/embeddings.json is missing; run npm run ml:embed first.")
    data = json.loads(EMBEDDINGS.read_text(encoding="utf-8"))
    if [row["text"] for row in data["rows"]] != texts:
        raise SystemExit("ml/.cache/embeddings.json does not match dataset.csv; rerun npm run ml:embed.")
    return data["model"], np.array([row["vector"] for row in data["rows"]])


def export_embedding_head(embedding_model, vectors, categories, threshold):
    model = LogisticRegression(max_iter=2000).fit(vectors, categories)
    assert len(model.classes_) > 2

    EMBEDDING_HEAD.write_text(json.dumps({
        "embeddingModel": embedding_model,
        "classes": [str(c) for c in model.classes_],
        "coef": model.coef_.tolist(),
        "intercept": model.intercept_.tolist(),
        "threshold": threshold,
    }), encoding="utf-8")

    parity_vectors = [vectors[i] for i in PARITY_ROWS] + [np.zeros(vectors.shape[1])]
    fixtures = []
    for vector, probabilities in zip(parity_vectors, model.predict_proba(np.array(parity_vectors))):
        best = probabilities.argmax()
        fixtures.append({
            "vector": vector.tolist(),
            "topCategory": str(model.classes_[best]),
            "confidence": float(probabilities[best]),
            "suggestedCategory": str(model.classes_[best]) if probabilities[best] >= threshold else None,
        })
    EMBEDDING_PARITY.write_text(json.dumps(fixtures) + "\n", encoding="utf-8")


def embedding_section(texts, categories, category, category_baseline):
    embedding_model, vectors = load_embeddings(texts)
    result = cross_validate(vectors, categories, lambda: LogisticRegression(max_iter=2000))
    rows = threshold_table(result)
    threshold = choose_threshold(rows, EMBEDDING_TARGET_ACCURACY)
    if threshold is None:
        raise SystemExit("No embedding threshold reaches the accuracy target.")
    chosen = next(row for row in rows if row[0] == threshold)
    at_75 = choose_threshold(rows)
    unfiltered = rows[0]
    tfidf_rows = threshold_table(category)
    tfidf_at_90 = next(row for row in tfidf_rows if row[0] == choose_threshold(tfidf_rows, EMBEDDING_TARGET_ACCURACY))

    export_embedding_head(embedding_model, vectors, categories, threshold)
    size_kb = EMBEDDING_HEAD.stat().st_size / 1024

    return f"""## Embeddings (shipped, with TF-IDF as fallback)

`{embedding_model}`, quantised ONNX, mean pooling and L2 normalisation, embedded by the same
code the server runs (`npm run ml:embed`). Logistic regression on the 384-dimensional vectors,
same folds and baseline as above. The threshold rule is the same except for its accuracy
target, explained below.

| model | accuracy | macro F1 |
|---|---|---|
{score_line("majority-class baseline", category_baseline)}
{score_line("TF-IDF (fallback)", category)}
{score_line("ONNX embeddings", result)}

{matrix_table(result)}

{threshold_lines(rows, threshold)}

**Chosen: {threshold:.3f}.** It is the lowest threshold where suggestions are right at least
{EMBEDDING_TARGET_ACCURACY:.0%} of the time with at least {MIN_SUGGESTED} reports measured. At this
threshold {chosen[2]:.0%} of reports get a suggestion and {chosen[3]:.1%} of those are right,
against {unfiltered[3]:.1%} when every report gets one.

**Why the target differs from TF-IDF.** With five classes the top probability is always at
least 0.200, the bottom of the grid. The embedding head is already right
{unfiltered[3]:.1%} of the time there, so the {TARGET_ACCURACY:.0%} target is met at
{at_75:.3f} and would never withhold a suggestion. A {EMBEDDING_TARGET_ACCURACY:.0%} target makes the
threshold act on the reports the head is least sure of. TF-IDF keeps {TARGET_ACCURACY:.0%}: it is right
only {tfidf_rows[0][3]:.1%} of the time unfiltered, so 75% already filters most reports, and a
{EMBEDDING_TARGET_ACCURACY:.0%} target would leave only {tfidf_at_90[2]:.0%} with a suggestion.

`src/ml/embedding-head.json`: {size_kb:.0f} KB.
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--embeddings", action="store_true", help="also train and export the embedding head")
    args = parser.parse_args()

    texts, categories, urgencies = load()

    by_min_df = {min_df: cross_validate(texts, categories, lambda: make_pipeline_for(min_df)) for min_df in (1, 2)}
    min_df = 2 if by_min_df[2]["macro_f1"][0] >= by_min_df[1]["macro_f1"][0] else 1
    category = by_min_df[min_df]
    category_baseline = baseline(texts, categories)

    rows = threshold_table(category)
    threshold = choose_threshold(rows)
    if threshold is None:
        raise SystemExit("No threshold reaches the accuracy target; revisit TARGET_ACCURACY or the data.")
    chosen = next(row for row in rows if row[0] == threshold)

    urgency = cross_validate(texts, urgencies, lambda: make_pipeline_for(min_df))
    urgency_baseline = baseline(texts, urgencies)

    terms = export(texts, categories, min_df, threshold)
    size_kb = MODEL.stat().st_size / 1024

    embeddings = (
        embedding_section(texts, categories, category, category_baseline) if args.embeddings else ""
    )

    metrics = f"""# Triage model metrics

## Reproducing the model

```
python3 -m venv ml/.venv
ml/.venv/bin/pip install -r ml/requirements.txt
npm run ml:embed
ml/.venv/bin/python ml/train.py --embeddings
```

This rewrites this file, `src/ml/model.json`, `src/ml/embedding-head.json` and the parity
fixtures in `tests/fixtures/`. Without `--embeddings` only the TF-IDF parts are rebuilt and
the embeddings section below is left out.

## Setup

- {len(texts)} hand-written reports, {len(set(categories))} categories.
- TF-IDF (unigrams and bigrams, lowercase, token pattern `\\b\\w\\w+\\b`) and multinomial logistic regression.
- Stratified {FOLDS}-fold cross-validation on the full dataset, `random_state={RANDOM_STATE}`.
  Scores are mean ± standard deviation across folds; confusion matrices are summed across folds.
- The shipped model is retrained on all reports after evaluation.

## Category (TF-IDF)

| model | accuracy | macro F1 |
|---|---|---|
{score_line("majority-class baseline", category_baseline)}
{score_line("TF-IDF, min_df=1", by_min_df[1])}
{score_line("TF-IDF, min_df=2", by_min_df[2])}

**Kept: min_df={min_df}.** min_df=2 is kept only if its cross-validated macro F1 is not lower than min_df=1.

Summed confusion matrix (min_df={min_df}):

{matrix_table(category)}

## Confidence threshold

Measured on the out-of-fold predictions above only. A report gets a suggestion when the
top-class probability is at least the threshold; below it the API returns no category.

{threshold_lines(rows, threshold)}

**Chosen: {threshold:.3f}.** It is the lowest threshold where suggestions are right at least
{TARGET_ACCURACY:.0%} of the time with at least {MIN_SUGGESTED} reports measured. At this
threshold {chosen[2]:.0%} of reports get a suggestion and {chosen[3]:.1%} of those are right,
against {category["accuracy"][0]:.1%} when every report gets one. The other reports still show
the probability and top terms, so moderators can see why no category was suggested.

Probabilities from the shipped model can run slightly higher than in cross-validation,
because it is trained on all {len(texts)} reports instead of four fifths of them.

{embeddings}
## Urgency (tried and rejected)

| model | accuracy | macro F1 |
|---|---|---|
{score_line("always MEDIUM (majority-class baseline)", urgency_baseline)}
{score_line(f"TF-IDF, min_df={min_df}", urgency)}

{matrix_table(urgency)}

Urgency is still in `dataset.csv` and evaluated here, but it is not exported or shown to
moderators. It does not beat always answering MEDIUM by a useful margin, and it almost never
predicts LOW correctly. Urgency depends on cues such as "right now", "today" or "already fixed"
that a bag-of-words model cannot learn from {len(texts)} short reports, and a wrong urgency
could make a moderator deprioritise a serious report.

## Export

`src/ml/model.json`: {terms} terms, {size_kb:.0f} KB.
"""
    METRICS.write_text(metrics, encoding="utf-8")
    print(metrics)


if __name__ == "__main__":
    main()
