# Clarifications — #708

## Batch 1 — 2026-05-23

### Q1: `.env` file missing in worker-scaler
**Context**: FR-001 requires `scaleWorkers` to write `WORKER_COUNT` to the host project's `.env` file using the existing `atomicWrite` helper. FR-002 covers the in-place update + append cases, but the spec is silent on what happens when `.env` doesn't exist at all (e.g. user deleted it, or it was never scaffolded because of a non-standard launch path). The choice changes both file-system semantics and the meaning of FR-006 "failure logged but non-blocking."
**Question**: When `scaleWorkers` runs and the host project's `.env` file does not exist, what should it do?
**Options**:
- A: Create a new `.env` containing just `WORKER_COUNT=<N>` (and any later writes preserve it).
- B: Skip the `.env` write with a warning log; rely on CLI re-derivation (FR-003/FR-004) to reconcile on the next `up`/`update`.
- C: Treat as an error and surface via FR-006's "logged but non-blocking" path (same as a write failure).

**Answer**: B — skip with warning, rely on CLI re-derivation.

Creating a fresh `.env` (A) would be misleading: the file the scaffolder normally writes has REPO_URL, GENERACY_CLUSTER_ID, MONITORED_REPOS, and others. A minimal one-line `.env` from `worker-scaler` lacks all of those, and the next compose run would silently fall back to environment defaults that may or may not be correct. C is also overkill — a missing `.env` is not an error in worker-scaler's contract; it just means the host-side state is in a non-standard shape that the CLI re-derive path (FR-003/FR-004) is the right place to fix. Worker-scaler doesn't own `.env`'s existence; it only owns one variable inside it when the file is present.

### Q2: Write ordering between `cluster.yaml` and `.env`
**Context**: FR-001 says the `.env` write happens "atomically alongside the `cluster.yaml` update," but there's no true cross-file atomicity primitive — one will be written before the other. If the first write succeeds and the second fails partway, the two files diverge for the window between the failure and the next CLI invocation. The choice determines which file is more likely to be stale on partial-failure, and whether the next `docker compose up -d` reads the new or old worker count.
**Question**: In `scaleWorkers`, which file should be written first?
**Options**:
- A: `.env` first, then `cluster.yaml`. (If `.env` fails, no state changes; if `cluster.yaml` fails, `.env` is briefly ahead of yaml — but the next CLI re-derivation reads yaml as source of truth, so `.env` gets corrected.)
- B: `cluster.yaml` first, then `.env`. (Matches today's behavior — yaml already gets written first. If `.env` write fails, the source-of-truth is correct and CLI re-derivation fixes `.env` on next invocation.)
- C: Both writes wrapped in a try/catch that attempts both regardless of which one fails first (best-effort, no ordering guarantee).

**Answer**: B — `cluster.yaml` first, then `.env`.

`cluster.yaml` is the source of truth; if the second write fails, the source of truth is still correct and the next CLI re-derivation will reconcile `.env`. With A (`.env` first), the failure mode of "cluster.yaml fails after .env succeeds" leaves the next CLI re-derive reading the stale cluster.yaml value and *overwriting* the new `.env` — losing the user's scale entirely. B is self-healing; A is self-destructive on partial failure.

### Q3: Handling `workers: 0` in `cluster.yaml`
**Context**: FR-003/FR-004 require the CLI to re-derive `WORKER_COUNT` from `cluster.yaml`. Today `scaleWorkers` validates `count >= 1` upstream in the lifecycle route, so the Engine API path can't produce `workers: 0`. But a hand-edit to `cluster.yaml` (US2) could set `workers: 0`. If the CLI passes `WORKER_COUNT=0` through to `docker compose up -d`, compose will scale the worker service to zero replicas — destroying all workers. FR-005 covers "missing or no `workers` key" but not "zero or negative."
**Question**: When `cluster.yaml` has `workers: 0` (or a negative value), what should the CLI do?
**Options**:
- A: Pass `WORKER_COUNT=0` through to compose unchanged — honor the user's hand-edit literally, even if destructive.
- B: Clamp to `1` and log a warning; treat `workers: 0` as invalid and fall through to FR-005's fallback behavior.
- C: Reject the operation with an error message instructing the user to set `workers >= 1` or remove the key entirely.

**Answer**: B — clamp to 1 with warning, fall through to FR-005's default.

Rejecting (C) is too disruptive: the CLI's re-derivation runs as part of `npx generacy up` / `update`, which the user is invoking for many reasons other than scaling. Failing the whole flow because of a stale `workers: 0` blocks image updates, channel switches, and other ops. Passing through (A) silently destroys all workers — a literal interpretation that doesn't match user mental models for what "running a generacy cluster" means. B preserves operability and surfaces the issue via the warning log. If we want a louder signal later, the warning can escalate to a one-shot UI notification — but that's a separate concern.

### Q4: Invalid `workers` field type
**Context**: FR-005 covers the "missing or has no `workers` key" case, falling back to the scaffolder default. But `cluster.yaml` could also have an invalid value — a non-integer string, `null`, an array, or a negative number. The assumption section states `workers` is "always a non-negative integer when present (no string coercion required beyond existing validation)" — but a hand-edit could violate that. Without a clear rule, the CLI could crash, pass a garbage value to compose, or silently fall through.
**Question**: When `cluster.yaml` has a `workers` value that is not a non-negative integer (e.g. string, null, negative), what should the CLI do?
**Options**:
- A: Same as a missing `workers` key — fall through to FR-005's scaffolder-default fallback with a warning.
- B: Reject with a clear error message identifying the invalid value, so the user knows their hand-edit is malformed.
- C: Attempt coercion (e.g. `parseInt`) and use the coerced value if valid; fall through to FR-005 otherwise.

**Answer**: A — same as missing key, fall through to FR-005 default with a warning.

Symmetric with Q3's reasoning. C (coercion) is the classic anti-pattern: silent coercion masks real bugs in the user's hand-edit. B (reject) is too disruptive for the reasons in Q3. A treats malformed identically to absent — "I couldn't parse a useful value, using the default" — with the warning log differentiating the parse-error case from a genuinely missing key for anyone debugging the logs later.
