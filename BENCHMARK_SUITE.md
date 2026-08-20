# Pi Pulse Benchmark Suite

Use benchmark incubators to test whether Pi Pulse is actually improving systems, not only producing plausible-looking apps.

A good benchmark target has three properties:
- Improvement can be measured automatically.
- Several dimensions compete, so one metric cannot be gamed alone.
- There is enough design freedom that the incubator must make real product and engineering decisions.

## Recommended Suite

1. Scheduler/packing optimizer
   - Measures: valid schedules, cost, late jobs, constraint violations, runtime, memory, stability across seeds.
   - Why: clean objective score with little room for fake progress.

2. Search/ranking app
   - Measures: relevance@k, failed queries, latency, memory, index size, and UI usability.
   - Why: mixes algorithmic quality with product quality.

3. Log anomaly detector
   - Measures: precision, recall, false positives, detection latency, CPU, and explainability.
   - Why: tests robustness over many fault patterns.

4. Web dashboard under load
   - Measures: p95 latency, error rate, memory, bundle size, accessibility, screenshot quality, and core workflow evidence.
   - Why: tests practical frontend/backend product quality.

5. Tamagotchi/idle game
   - Measures: long-horizon coherence, player-understandable state, retention hooks, failure recovery, and subjective taste.
   - Why: keeps creative continuity in the suite without making every benchmark a game.

## Additional Strong Targets

- Image optimizer/editor: output size, perceptual similarity, processing time, failures, UI quality.
- Mini database/query engine: correctness, queries/sec, p95 latency, memory, crash rate.
- Compression challenge: exact round trip, compression ratio, speed, memory.
- Route/pathfinding visualizer: success rate, path quality, runtime, memory, visual inspectability.
- Recommendation engine: ranking quality, diversity, novelty, latency, coverage.
- Code search tool: retrieval accuracy, latency, index size, failure rate.
- OCR/document extraction pipeline: exact field accuracy, layout preservation, runtime, robustness.
- Simulation economy: throughput, deadlocks, inflation/deflation, viable strategy diversity.

## First Benchmark To Build

Start with the scheduler/packing optimizer.

Example score receipt:
- valid schedules: 100%
- average cost: 82.4 -> 71.8
- late jobs: 41 -> 12
- runtime: 180ms -> 104ms
- memory: 94MB -> 76MB
- constraint violations: 0

A run is not better unless it improves the weighted benchmark score without increasing hard failures, constraint violations, or app-evidence risk.

## Benchmark Run Contract

Benchmark incubators should append a compact metric receipt every run:

**Benchmark target:** [scheduler/search/log/dashboard/etc.]
**Benchmark score:** [current weighted score and previous score when known]
**Metric deltas:** [3-6 concrete before/after measurements]
**Regression guard:** [metric or UI behavior that must not get worse]
**Pi Pulse lesson:** [one portable lesson future incubators should reuse]
**Learning evidence:** [benchmark output, screenshot, test, or app-evidence result]
**Applies to future apps:** yes/no - [scope]
