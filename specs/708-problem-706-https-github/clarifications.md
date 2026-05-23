# Clarifications — #708

## Batch 1 — 2026-05-23

### Q1: `.env` file missing in worker-scaler
**Context**: FR-001 requires `scaleWorkers` to write `WORKER_COUNT` to the host project's `.env` file using the existing `atomicWrite` helper. FR-002 covers the in-place update + append cases, but the spec is silent on what happens when `.env` doesn't exist at all (e.g. user deleted it, or it was never scaffolded because of a non-standard launch path). The choice changes both file-system semantics and the meaning of FR-006 "failure logged but non-blocking."
**Question**: When `scaleWorkers` runs and the host project's `.env` file does not exist, what should it do?
**Options**:
- A: Create a new `.env` containing just `WORKER_COUNT=<N>` (and any later writes preserve it).
- B: Skip the `.env` write with a warning log; rely on CLI re-derivation (FR-003/FR-004) to reconcile on the next `up`/`update`.
- C: Treat as an error and surface via FR-006's "logged but non-blocking" path (same as a write failure).

**Answer**: *Pending*

### Q2: Write ordering between `cluster.yaml` and `.env`
**Context**: FR-001 says the `.env` write happens "atomically alongside the `cluster.yaml` update," but there's no true cross-file atomicity primitive — one will be written before the other. If the first write succeeds and the second fails partway, the two files diverge for the window between the failure and the next CLI invocation. The choice determines which file is more likely to be stale on partial-failure, and whether the next `docker compose up -d` reads the new or old worker count.
**Question**: In `scaleWorkers`, which file should be written first?
**Options**:
- A: `.env` first, then `cluster.yaml`. (If `.env` fails, no state changes; if `cluster.yaml` fails, `.env` is briefly ahead of yaml — but the next CLI re-derivation reads yaml as source of truth, so `.env` gets corrected.)
- B: `cluster.yaml` first, then `.env`. (Matches today's behavior — yaml already gets written first. If `.env` write fails, the source-of-truth is correct and CLI re-derivation fixes `.env` on next invocation.)
- C: Both writes wrapped in a try/catch that attempts both regardless of which one fails first (best-effort, no ordering guarantee).

**Answer**: *Pending*

### Q3: Handling `workers: 0` in `cluster.yaml`
**Context**: FR-003/FR-004 require the CLI to re-derive `WORKER_COUNT` from `cluster.yaml`. Today `scaleWorkers` validates `count >= 1` upstream in the lifecycle route, so the Engine API path can't produce `workers: 0`. But a hand-edit to `cluster.yaml` (US2) could set `workers: 0`. If the CLI passes `WORKER_COUNT=0` through to `docker compose up -d`, compose will scale the worker service to zero replicas — destroying all workers. FR-005 covers "missing or no `workers` key" but not "zero or negative."
**Question**: When `cluster.yaml` has `workers: 0` (or a negative value), what should the CLI do?
**Options**:
- A: Pass `WORKER_COUNT=0` through to compose unchanged — honor the user's hand-edit literally, even if destructive.
- B: Clamp to `1` and log a warning; treat `workers: 0` as invalid and fall through to FR-005's fallback behavior.
- C: Reject the operation with an error message instructing the user to set `workers >= 1` or remove the key entirely.

**Answer**: *Pending*

### Q4: Invalid `workers` field type
**Context**: FR-005 covers the "missing or has no `workers` key" case, falling back to the scaffolder default. But `cluster.yaml` could also have an invalid value — a non-integer string, `null`, an array, or a negative number. The assumption section states `workers` is "always a non-negative integer when present (no string coercion required beyond existing validation)" — but a hand-edit could violate that. Without a clear rule, the CLI could crash, pass a garbage value to compose, or silently fall through.
**Question**: When `cluster.yaml` has a `workers` value that is not a non-negative integer (e.g. string, null, negative), what should the CLI do?
**Options**:
- A: Same as a missing `workers` key — fall through to FR-005's scaffolder-default fallback with a warning.
- B: Reject with a clear error message identifying the invalid value, so the user knows their hand-edit is malformed.
- C: Attempt coercion (e.g. `parseInt`) and use the coerced value if valid; fall through to FR-005 otherwise.

**Answer**: *Pending*
