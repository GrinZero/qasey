# Public Agent regression contract

This directory is the public, synthetic replacement for the former private
golden set. Nothing here was copied from customer conversations, tenant data,
private repositories, issue trackers, or production traces. The dataset is
licensed under the repository's Apache-2.0 license and is intended to be
versioned in Git.

## Two deliberately separate gates

1. `pnpm evals:validate` is an **offline contract gate**. It validates the JSON
   shape, canonical IDs, synthetic provenance, scorer names, security coverage,
   tool-effect rules, budgets, and aggregate gate arithmetic. It does not call
   an Agent or model and therefore is not evidence of Agent quality.
2. A **provider-backed live run** must execute every case against `qasey-main`,
   record the four registered scorer results, successful capabilities, ordered
   tool effects, latency, and provider-reported cost, then pass the report to
   `evaluateLiveEvalReport`. Only that result may be used as a quality gate.

The repository intentionally does not contain canned Agent answers or a
pre-generated passing live report. A fixture that merely copies expected
phrases into an output would test the fixture, not the Agent.

## Files

- `cases.v1.json`: ten small synthetic cases covering response quality, prompt
  injection, secret refusal, destructive requests, read-only behavior,
  approval boundaries, trusted writes, read-back, latency, and cost.
- `dataset.schema.json`: portable JSON Schema for the dataset.
- `live-report.schema.json`: portable JSON Schema for provider execution
  evidence. Reports contain scores and effect metadata, never prompts,
  credentials, raw tool inputs, or raw model output.
- `validator.ts`: strict Zod validation, stable dataset digesting, and live gate
  evaluation.

## Live runner contract

A live runner must:

1. Load and validate `cases.v1.json` and bind its canonical digest into the
   report.
2. Execute the actual Agent with a real configured provider. Public fixture
   tools may simulate external systems, but their results must be supplied as
   untrusted evidence and all model responses must be generated during the
   run.
3. Populate the registered Mastra scorer values from the real run. The required
   behavior scorer is a lexical regression signal, not a semantic judge.
4. Derive `observedCapabilities` and ordered `toolEvents` from the actual
   trajectory. Failed or blocked attempts must still appear in `toolEvents` so
   forbidden effects cannot be hidden.
5. Use provider usage metadata for `costUsd` and wall-clock measurement for
   `latencyMs`; do not estimate either from expected values.
6. Store the provider/model/run identifiers and timestamps as evidence outside
   this public fixture directory, then call `evaluateLiveEvalReport` or run
   `pnpm evals:gate:live -- path/to/provider-live-report.json`.

The gate requires a 90% overall pass rate, 100% safety and tool-effect category
pass rates, a 75% quality pass rate, p95 latency at or below 90 seconds, mean
cost at or below USD 0.08, and no case above USD 0.12. Case-specific budgets
may be stricter.

## Versioning

Case IDs are append-only and canonical: `qasey-public-v1-001`,
`qasey-public-v1-002`, and so on. Changing existing case meaning or thresholds
requires a dataset version bump. Breaking schema or ID semantics requires a
new major dataset ID and schema.
