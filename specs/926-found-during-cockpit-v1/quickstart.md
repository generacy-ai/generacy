# Quickstart — Found during the cockpit v1

## Overview

Two changes in this feature, both purely source-file edits + tests:

1. Insert `'waiting-for:address-pr-feedback'` at index 1 of `WAITING_PIPELINE_ORDER` in `packages/cockpit/src/state/precedence.ts`.
2. Refactor `packages/orchestrator/src/worker/pr-feedback-handler.ts` so `agent:in-progress` is cleared at a single shared exit path (try / `finally`), and the happy-path exit collapses the label clear into a single `removeLabels(['waiting-for:address-pr-feedback', 'agent:in-progress'])` call.

No new packages, no new dependencies, no schema changes, no wire-format changes.

## Local verification steps

### 1. Prereqs

```bash
pnpm install  # if not already installed
```

### 2. Apply the precedence change

Edit `packages/cockpit/src/state/precedence.ts`. Between `'blocked:stuck-feedback-loop'` and `'waiting-for:spec-review'` in the `WAITING_PIPELINE_ORDER` array, insert:

```ts
'waiting-for:address-pr-feedback',
```

Update the docstring at lines 20–25 to remove `address-pr-feedback` from the "unlisted, falls back to `WORKFLOW_LABELS` index" list.

### 3. Apply the handler exit refactor

Edit `packages/orchestrator/src/worker/pr-feedback-handler.ts`:

- Wrap the body of `handle(item, checkoutPath)` (lines 92–373) in `try { ... } finally { ... }`.
- In the `finally` block, best-effort remove `agent:in-progress` (mirror the shape of `removeFeedbackLabel` — catch errors, log at `warn`, do not throw).
- On the happy path (line 357), replace the standalone `removeFeedbackLabel(...)` call with a coalesced call: `github.removeLabels(owner, repo, issueNumber, ['waiting-for:address-pr-feedback', 'agent:in-progress'])`. The `finally` remove of `agent:in-progress` becomes a no-op on the happy path (idempotent — GitHub returns 200 whether the label was present or not).

Structural check (SC-005): after the edit, `grep -c "agent:in-progress" packages/orchestrator/src/worker/pr-feedback-handler.ts` should show a single code-site match for the removal literal (not per-site).

### 4. Run classifier tests

```bash
pnpm --filter @generacy-ai/cockpit test -- --run classifier
```

Expected: existing tests pass unchanged; new tests for `{implementation-review, address-pr-feedback}` → `address-pr-feedback` pass.

### 5. Run handler tests

```bash
pnpm --filter @generacy-ai/orchestrator test -- --run pr-feedback-handler
```

Expected: four terminal-return scenarios (happy / Case A / Case B / blocked-stuck) all pass with `agent:in-progress` absent post-return.

### 6. Full package tests

```bash
pnpm --filter @generacy-ai/cockpit test
pnpm --filter @generacy-ai/orchestrator test
```

## Verifying the fix end-to-end

The end-to-end signal is: on a request-changes review that triggers `waiting-for:address-pr-feedback`, a `cockpit watch` or `cockpit_await_events` consumer should receive **two** `issue-transition` events during the feedback cycle (add edge → `waiting-for:address-pr-feedback`; remove edge → `waiting-for:implementation-review`).

Pre-change: zero events during the cycle (curated state never leaves `waiting-for:implementation-review`).

Post-change: exactly two events.

### Manual reproduction

```bash
# In a repo with an active PR under review:
# 1. Post a request-changes review on the PR
# 2. Confirm the server-side loop enqueues (waiting-for:address-pr-feedback added)
# 3. Watch the event stream:
generacy cockpit watch <issue-ref>
# Expect: one issue-transition event to waiting-for:address-pr-feedback
# Wait for handler to complete:
# Expect: second issue-transition event back to waiting-for:implementation-review
# Post-cycle: check labels — no agent:in-progress on the issue.
```

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| Classifier test fails: `{implementation-review, address-pr-feedback}` → `implementation-review` | Precedence array not updated; `address-pr-feedback` still at unlisted position | `packages/cockpit/src/state/precedence.ts:26-36` |
| Handler test fails: `agent:in-progress` present after Case B / blocked-stuck return | `finally` block missing or wrapping the wrong scope | Confirm `try/finally` wraps the entire `handle` body from setup through happy path |
| Happy-path handler test fails: two `removeLabels` calls observed instead of one | Coalescing not applied; happy path still uses `removeFeedbackLabel` + `finally` two-call pattern | Confirm the single `removeLabels([..., ...])` call at line 357 site |
| SC-005 grep finds 2+ code-site matches for `'agent:in-progress'` inside `pr-feedback-handler.ts` | Per-site clears leaked in during refactor | Consolidate to the `finally` block + happy-path coalescing only |
| Event-stream test: two events on the add edge (or the remove edge) | Classifier or event emitter is double-triggering | Confirm `compareSourceLabels` returns a stable ordering for the pair; confirm the event emitter deduplicates on unchanged `sourceLabel` |

## Available commands

- `pnpm --filter @generacy-ai/cockpit test` — run cockpit package tests (classifier, event stream, etc.).
- `pnpm --filter @generacy-ai/orchestrator test` — run orchestrator package tests (worker, handlers, services).
- `generacy cockpit watch <issue-ref>` — subscribe to the event stream for an issue.
- `generacy cockpit status <issue-ref>` — inspect the curated state of an issue.

## Success signals

- All classifier tests pass.
- All `pr-feedback-handler` tests pass.
- Grep for `agent:in-progress` inside `pr-feedback-handler.ts` returns exactly one code-site match for the remove call.
- Manual reproduction sees two `issue-transition` events per feedback cycle (add + remove edges).
- Manual reproduction observes no `agent:in-progress` residue on the issue after cycle completion.

---

*Generated by speckit*
