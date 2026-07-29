# Quickstart: PR-feedback CLI self-commit detection

**Feature**: `1073-problem-when-pr-feedback`

Verifying the fix locally, in tests, and in the field. Reads as a checklist.

---

## Prerequisites

- Node.js ≥22 (per repo `.nvmrc` / `engines`).
- `pnpm install` completed at the repo root.
- Familiarity with `packages/orchestrator/src/worker/pr-feedback-handler.ts` — the sole production file with substantive changes.

---

## Local test invocations

Two `pnpm` commands cover the regression + parity story.

```bash
# 1. Fix-specific regression tests
pnpm --filter @generacy-ai/orchestrator test pr-feedback-handler.cli-self-commit

# 2. Full pr-feedback-handler test suite (SC-007 — must stay green)
pnpm --filter @generacy-ai/orchestrator test pr-feedback-handler
```

**Expected**: both pass. If (2) fails but (1) passes, a #1070 timeout-disposition or #941 gate-reassert assertion has drifted — check the dispatcher decision table in `contracts/pr-feedback-disposition.md` for an unintended change to rows B4/B5/B6.

Third command covers cockpit precedence:

```bash
pnpm --filter @generacy-ai/cockpit test precedence
```

**Expected**: passes with the new `blocked:resolve-failed` assertion in place.

---

## Reading a worker log to distinguish the four dispositions

Grep-friendly `disposition:` values (all lowercase-hyphenated, cause-oriented):

| `disposition:` value | Meaning | Label applied | Source (file:line) |
|----------------------|---------|---------------|--------------------|
| `'timeout-no-progress'` | CLI timed out, zero commits | `blocked:fixer-timeout-no-progress` | #1070 B4 |
| `'fixer-timeout'` | CLI timed out with partial push, retry available | `blocked:fixer-timeout` | #1070 B5 |
| `'fixer-timeout-repeat'` | CLI timed out with partial push, retry budget exhausted | `blocked:fixer-timeout-repeat` | #1070 B6 |
| `'push-failed'` | Non-timeout: CLI exit was non-zero | `blocked:stuck-feedback-loop` | Pre-#1073 B1 |
| `'no-diff'` | Non-timeout: CLI success, no head advance, no handler diff | `blocked:stuck-feedback-loop` | Pre-#1073 B2/B3 |
| **`'cli-self-committed'`** | **NEW**: CLI success, head advanced, handler had nothing to commit | (none — falls through to reply/resolve) | **#1073 B0** |

**Grep target for SC-003** — one line per self-commit cycle:

```bash
grep 'disposition.*cli-self-committed' <worker-log>
```

Each hit should be accompanied by a `preFixSha` and `postFixSha` field on the same log line, per FR-008a. If a hit is missing either, the auditability requirement is broken — file a defect referencing this quickstart.

**Anti-grep for SC-004** — the historically observed contradictory sequence:

```bash
# Should return zero lines in a healthy worker log post-fix.
grep -B1 -A1 'no-diff cycle' <worker-log> | grep 'No changes to commit'
```

If it returns rows, either the fix is not deployed or the pre-fix bug is recurring on a different code path.

---

## Reading a PR's label state

Before this fix, a successful CLI-self-commit cycle produced this label churn:

```
PR opened
  + waiting-for:address-pr-feedback
  + agent:in-progress
CLI pushes 4a006c61
  (handler runs)
  + blocked:stuck-feedback-loop   ← misfire
Operator investigates, clears label by hand
  - blocked:stuck-feedback-loop
```

After this fix, the same successful cycle produces:

```
PR opened
  + waiting-for:address-pr-feedback
  + agent:in-progress
CLI pushes 4a006c61
  (handler runs)
  (reply/resolve loop runs)
  - waiting-for:address-pr-feedback
  - agent:in-progress               ← coalesced with the line above
  (no blocked:* label)
```

A cycle where the CLI committed AND reply/resolve failed produces (FR-013, new):

```
PR opened
  + waiting-for:address-pr-feedback
  + agent:in-progress
CLI pushes 4a006c61
  (handler runs)
  (reply/resolve loop runs — zero successes)
  + blocked:resolve-failed          ← NEW label
```

The genuine no-diff cycle (FR-005, unchanged) still produces:

```
PR opened
  + waiting-for:address-pr-feedback
  + agent:in-progress
CLI runs, produces no changes
  (handler runs)
  + blocked:stuck-feedback-loop     ← still the right label for this case
```

---

## Operator remediation for the two dispositions

**`blocked:stuck-feedback-loop`** — the fixer isn't making progress.
- Read the worker log for the last cycle on this PR. Look for `disposition:` values `'no-diff'` (nothing happened) or `'push-failed'` (CLI exit non-zero).
- Fix the underlying obstacle (prompt clarity, missing context, CLI environment issue).
- `gh issue edit <n> --remove-label blocked:stuck-feedback-loop` to re-enable the trigger.

**`blocked:resolve-failed`** — the code is fine; the GitHub side didn't take.
- Read the worker log for the last cycle on this PR. Look for `resolveReviewThread persistently failed after retries` warn lines — each names a specific `threadId` and error.
- Manually resolve those threads in the GitHub UI (the reply is already on the thread, so the reviewer can see the acknowledgement).
- `gh issue edit <n> --remove-label blocked:resolve-failed` to re-enable the trigger.

---

## Deploy verification

After deploy, tail a worker log through one or more real PR-feedback cycles. Confirm:

1. `disposition: 'cli-self-committed'` appears at least once when a CLI genuinely self-commits (rare but observable).
2. Every `disposition: 'cli-self-committed'` line has both `preFixSha` and `postFixSha` fields.
3. No `blocked:stuck-feedback-loop` labels land on PRs whose branch HEAD advanced during the cycle. (Cross-check `gh pr view <n> --json commits` timestamps against the worker log window.)
4. New `blocked:resolve-failed` labels correlate with `resolveReviewThread persistently failed` warn lines in the same log window.

---

## Rollback

Revert of the single fix commit is safe:
- Removing the new label `blocked:resolve-failed` from `label-definitions.ts` triggers a next-sync-tick delete-out on any repo the label was pushed to. `LabelSyncService` (existing) handles missing labels gracefully.
- Any PR wearing `blocked:resolve-failed` at rollback time would retain the label (GitHub doesn't propagate a definition delete). Operators can hand-clear or leave it; the label is no longer honored by the monitor's short-circuit (which greps `blocked:*` by prefix — the prefix match keeps working).
- The dispatcher reverts to its pre-#1073 shape (misfire returns on the CLI-self-commit case). No data-migration needed.

Rollback is preferable to hot-patch if the fix produces false positives on a specific PR — the failure mode is the pre-existing one, which is well-understood.
