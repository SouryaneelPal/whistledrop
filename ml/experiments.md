# Embeddings experiment

Offline comparison only; nothing here changes the shipped model. Reproduce with
`ml/.venv/bin/python ml/embeddings_experiment.py` after
`ml/.venv/bin/pip install -r ml/requirements-experiment.txt` (torch and sentence-transformers,
about 1 GB). The shipped models need only `ml/requirements.txt`.

Same 300 reports, same stratified 5-fold split (`random_state=42`) and the
same threshold rule as `train.py`: the lowest threshold where suggestions are right at least
75% of the time with at least 30 reports measured. Both models use
`LogisticRegression(max_iter=2000)` with default regularisation.

## Results

| model | accuracy | macro F1 | threshold by the 75% rule |
|---|---|---|---|
| TF-IDF + LogisticRegression (min_df=1, shipped) | 0.557 ± 0.044 | 0.558 ± 0.042 | 0.300 (24% covered, 79.2% right) |
| all-MiniLM-L6-v2 embeddings + LogisticRegression | 0.833 ± 0.026 | 0.830 ± 0.029 | 0.200 (100% covered, 83.3% right) |

### TF-IDF thresholds

| threshold | reports with a suggestion | share | accuracy on those |
|---|---|---|---|
| 0.200 | 300 | 100% | 0.557 |
| 0.225 | 273 | 91% | 0.579 |
| 0.250 | 186 | 62% | 0.624 |
| 0.275 | 113 | 38% | 0.699 |
| 0.300 (chosen) | 72 | 24% | 0.792 |
| 0.325 | 53 | 18% | 0.868 |
| 0.350 | 33 | 11% | 0.909 |
| 0.375 | 25 | 8% | 0.880 |
| 0.400 | 19 | 6% | 0.895 |
| 0.425 | 14 | 5% | 0.857 |
| 0.450 | 10 | 3% | 0.800 |
| 0.475 | 8 | 3% | 0.750 |
| 0.500 | 6 | 2% | 1.000 |
| 0.525 | 2 | 1% | 1.000 |
| 0.550 | 1 | 0% | 1.000 |
| 0.575 | 0 | 0% | nan |
| 0.600 | 0 | 0% | nan |
| 0.625 | 0 | 0% | nan |
| 0.650 | 0 | 0% | nan |
| 0.675 | 0 | 0% | nan |
| 0.700 | 0 | 0% | nan |

### Embedding thresholds

| threshold | reports with a suggestion | share | accuracy on those |
|---|---|---|---|
| 0.200 (chosen) | 300 | 100% | 0.833 |
| 0.225 | 300 | 100% | 0.833 |
| 0.250 | 299 | 100% | 0.833 |
| 0.275 | 299 | 100% | 0.833 |
| 0.300 | 291 | 97% | 0.842 |
| 0.325 | 274 | 91% | 0.872 |
| 0.350 | 257 | 86% | 0.891 |
| 0.375 | 240 | 80% | 0.900 |
| 0.400 | 212 | 71% | 0.906 |
| 0.425 | 188 | 63% | 0.920 |
| 0.450 | 162 | 54% | 0.944 |
| 0.475 | 139 | 46% | 0.950 |
| 0.500 | 122 | 41% | 0.943 |
| 0.525 | 109 | 36% | 0.954 |
| 0.550 | 92 | 31% | 0.957 |
| 0.575 | 80 | 27% | 0.963 |
| 0.600 | 67 | 22% | 0.970 |
| 0.625 | 59 | 20% | 0.983 |
| 0.650 | 47 | 16% | 0.979 |
| 0.675 | 33 | 11% | 0.970 |
| 0.700 | 25 | 8% | 1.000 |

### Summed confusion matrices

TF-IDF:

| actual \ predicted | CORRUPTION | HARASSMENT | OTHER | SECURITY | TECHNICAL |
|---|---|---|---|---|---|
| CORRUPTION | 38 | 3 | 9 | 9 | 1 |
| HARASSMENT | 3 | 45 | 4 | 7 | 1 |
| OTHER | 11 | 5 | 26 | 11 | 7 |
| SECURITY | 8 | 5 | 9 | 29 | 9 |
| TECHNICAL | 7 | 0 | 8 | 16 | 29 |

Embeddings:

| actual \ predicted | CORRUPTION | HARASSMENT | OTHER | SECURITY | TECHNICAL |
|---|---|---|---|---|---|
| CORRUPTION | 52 | 0 | 4 | 3 | 1 |
| HARASSMENT | 0 | 60 | 0 | 0 | 0 |
| OTHER | 7 | 8 | 39 | 2 | 4 |
| SECURITY | 3 | 0 | 6 | 47 | 4 |
| TECHNICAL | 3 | 0 | 2 | 3 | 52 |

## Quantised ONNX versus torch

The server uses the quantised ONNX export of the same model through transformers.js
(`Xenova/all-MiniLM-L6-v2`, int8). These are its vectors for the same 300 reports, from
`npm run ml:embed`, scored the same way.

| embeddings | accuracy | macro F1 | threshold by the 75% rule |
|---|---|---|---|
| torch (sentence-transformers) | 0.833 ± 0.026 | 0.830 ± 0.029 | 0.200 (100% covered, 83.3% right) |
| quantised ONNX (transformers.js) | 0.823 ± 0.023 | 0.820 ± 0.025 | 0.200 (100% covered, 82.3% right) |

Cosine similarity between the torch and ONNX vector for each report: mean 0.9961,
lowest 0.9932.

## Cost

Measured on arm64 Darwin, Python 3.14.7, CPU only.
Peak memory is the peak resident size of this Python process, so it includes Python,
NumPy and scikit-learn as well as torch and the model. Memory and timing vary between runs
(by tens of MB and a few ms here), so treat them as rough figures.

| measurement | value |
|---|---|
| embedding model download (`sentence-transformers/all-MiniLM-L6-v2`) | 87 MB |
| torch package on disk | 555 MB |
| peak memory before importing torch | 146 MB |
| peak memory after loading the model | 468 MB |
| peak memory after embedding all 300 texts | 579 MB |
| time to embed all 300 texts | 0.4 s |
| one prediction, TF-IDF (median of 50) | 0.30 ms |
| one prediction, embeddings (median of 50) | 5.01 ms |

## Conclusion

**Does the embedding model meaningfully beat the baseline?** Yes. Macro F1 is
0.830 ± 0.029 against 0.558 ± 0.042, a gap
larger than the fold-to-fold spread of both models combined. It also
changes how useful the threshold is: under the same 75% rule the baseline suggests a category
for 24% of reports and the embedding model for 100% of reports.
The lowest threshold in the table is 0.200, one in five categories, so "100% covered" means
every report already clears the floor of the grid.

Two caveats. The dataset is 300 short reports written by one author, so both models
are judged on clean, similar wording and the gap may be smaller on real reports. And the
latency was measured on this machine with every CPU core available to torch; a small shared
server core would be slower.

**Would it fit on a 512 MB server?** Not as measured. This Python process peaked
at 579 MB with torch and the model loaded, before any of the Node API is counted.
The model file itself is only 87 MB; most of the memory is the torch runtime. A
lighter runtime (for example the same model exported to ONNX and run from Node) could need much
less, but that was not measured here.
