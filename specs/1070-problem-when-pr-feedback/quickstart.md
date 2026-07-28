# Quickstart: PR-feedback fixer timeout dispositions

**Branch**: `1070-problem-when-pr-feedback` | **Issue**: [generacy#1070](https://github.com/generacy-ai/generacy/issues/1070)

Operator runbook for the new PR-feedback fixer disposition labels introduced in #1070. Read this before running `docker logs --since 45m worker-N | grep <prNumber>` to diagnose a "stuck" PR.

## What changed

Before #1070, the PR-feedback fixer applied a single label — `blocked:stuck-feedback-loop` — to every failed cycle, regardless of whether it timed out (retry-eligible) or genuinely couldn't advance (needs human intervention). The label's description said "last cycle could not advance the trigger", so an operator seeing it had to grep worker logs to know whether waiting one more cycle would help.

After #1070, the fixer applies one of **four** labels depending on what actually happened:

| Label | Cause | Retry behavior | Your action |
|---|---|---|---|
| `blocked:stuck-feedback-loop` | Clean CLI exit with no diff, OR clean CLI exit but the resolve batch had zero successes | **None** (unchanged from today) | Investigate why the fixer produced no diff / no resolves. Remove label to retry. |
| `blocked:fixer-timeout` | CLI timed out (exit 143) with a partial commit pushed | **Automatic** — monitor auto-dispatches on next poll; label removed at dispatch time | **Wait one 20-minute cycle.** If the retry succeeds, the label vanishes. Up to 2 auto-retries per trigger. |
| `blocked:fixer-timeout-no-progress` | CLI timed out (exit 143) but no commit was pushed | **None** (terminal — retries would not help) | Investigate why the fixer produced no commit. Remove label to permit a fresh trigger. |
| `blocked:fixer-timeout-repeat` | CLI timed out after the 2-retry budget was exhausted | **None** (terminal — budget spent) | Review whether the work is too large for a single 20-minute window. Either intervene manually to finish the reply/resolve loop, OR split the review into smaller chunks and remove the label. |

## Installation

Nothing to install. #1070 lands as an internal orchestrator + workflow-engine + cockpit change. Once your cluster is running a version that includes it, the new labels will start appearing on triggered PRs automatically.

**Verify your cluster is on the fixed version**:

```bash
docker exec -it <cluster-name>-orchestrator-1 cat /shared-packages/node_modules/@generacy-ai/workflow-engine/dist/actions/github/label-definitions.js \
  | grep -c 'blocked:fixer-timeout'
```

Expected output: `3` (three new label names present).

## Usage — Observing the new dispositions

### The one-liner every operator should learn

```bash
docker logs --since 45m <cluster>-worker-N | grep -E 'disposition|exitCode: 143'
```

Every disposition-log line now carries a structured `disposition` field:

- `disposition: 'no-diff'` → today's `blocked:stuck-feedback-loop` for clean-exit-no-diff.
- `disposition: 'timeout-no-progress'` → new `blocked:fixer-timeout-no-progress`.
- `disposition: 'fixer-timeout'` → new `blocked:fixer-timeout` (retry-eligible).
- `disposition: 'fixer-timeout-repeat'` → new `blocked:fixer-timeout-repeat` (terminal).

The old contradictory line `msg: "Successfully pushed changes to PR branch" success: false` is fixed — when the CLI times out with a partial push, the log line now reads:

```
msg: "Pushed partial changes before CLI timed out — retry may follow"
cliCompleted: false
exitCode: 143
```

### Log-line audit: prove the fix landed

Run this against a worker log window that includes any pushed commit:

```bash
docker logs --since 4h <cluster>-worker-N \
  | jq -c 'select(.msg == "Successfully pushed changes to PR branch") | {success, msg}'
```

Every returned line MUST have `"success": true`. Any `"success": false` line is a regression of SC-004.

## Available commands

None new — #1070 does not add CLI subcommands. The only operator-facing surface is the label vocabulary.

## Troubleshooting

### "The label says `blocked:fixer-timeout` — why isn't the retry happening?"

The monitor polls every 60 seconds (or 30 seconds with adaptive polling). Wait one full cycle. If the label persists after 2 minutes, check:

1. **Retry budget exhausted silently**. The monitor logs `gate: 'blocked-fixer-timeout-budget-exhausted'` at `warn` level when the label is present but the counter is already at 2. This shouldn't happen (the handler should have applied `blocked:fixer-timeout-repeat` instead) — file a bug.
2. **Label-removal race**. The monitor logs `Failed to remove blocked:fixer-timeout before retry dispatch` if the GitHub API call fails. Next poll will retry.
3. **Any other `blocked:*` label present**. The retry-eligible branch fires ONLY for exact-match `blocked:fixer-timeout`. If both `blocked:fixer-timeout` AND `blocked:body-finding-unaddressed` (or any other `blocked:*`) are present, the generic short-circuit at `pr-feedback-monitor-service.ts:373-389` matches the other label and pauses. Resolve or remove the other blocked label first.

### "The label says `blocked:fixer-timeout-repeat` — what do I do?"

The fixer tried three total times (original + 2 auto-retries) without fully resolving the review threads. Two escape hatches:

1. **Finish it yourself**: read the worker log for the last cycle, understand what's left, and post the missing replies / resolve the remaining threads manually. Then remove `blocked:fixer-timeout-repeat` — the next poll will hit Case C (all threads resolved) and reset the counter.
2. **Split the review**: if the review is legitimately too large for a 20-minute window, split it into chunks. Ask the reviewer to file smaller review chunks, then remove the label — the next poll will treat it as a fresh trigger.

### "The label says `blocked:fixer-timeout-no-progress` — the fixer didn't even try?"

Zero commits landed on the branch. Common causes:

1. **Wrong branch**: the fixer switched to the PR branch but there's no diff between the base and head — the CLI ran but produced nothing to commit. Check `docker logs ... | grep 'switchBranch'`.
2. **CLI never started**: check for `Failed to spawn Claude CLI process` in worker logs.
3. **CLI wrote to /tmp and the changes didn't reach the checkout**: extremely rare; check the CLI's own output for cwd mismatches.

Remove the label to permit a fresh trigger.

### "Cockpit shows `waiting-for:address-pr-feedback` even though `blocked:fixer-timeout-no-progress` is on the issue — is that right?"

**Yes, IF** you're on a version older than #1070's cockpit precedence change (D-3). Verify with:

```bash
grep -c 'blocked:fixer-timeout' packages/cockpit/dist/state/precedence.js
```

Expected: `3`. If less, the cockpit-side change didn't ship — pull the latest and rebuild.

After the fix, cockpit surfaces the terminal `blocked:fixer-timeout-*` label ahead of `waiting-for:address-pr-feedback` (matching how `blocked:stuck-feedback-loop` outranks it today). The retry-eligible `blocked:fixer-timeout` intentionally stays BELOW `waiting-for:address-pr-feedback` — the retry is coming, so "still waiting" is the more-informative status.

### "The retry budget seems to persist across unrelated review rounds"

By design (Q5=C, D-5). The counter resets ONLY when all review threads are fully resolved on the PR (monitor's Case C branch). A partial completion + fresh review that lands on the same PR still shares the accumulated budget. Rationale: a trigger that keeps almost-but-not-quite finishing is exactly the runaway scenario the bounded budget is meant to catch.

If you need to force a full reset without resolving remaining threads, resolve them manually in the GitHub UI (or use `gh api` to close each thread) — the next poll will detect zero unresolved threads and reset the counter.

## Where the change lives

For code review or further reading:

- **Handler** (four-branch disposition + log fix): `packages/orchestrator/src/worker/pr-feedback-handler.ts` (~lines 412, 451-481, 687-806).
- **Monitor** (retry-eligible check + counter): `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` (~lines 79, 296-317, 373-389, 414-428).
- **Labels**: `packages/workflow-engine/src/actions/github/label-definitions.ts` (~line 111).
- **Cockpit precedence**: `packages/cockpit/src/state/precedence.ts` (~lines 26-40).
- **Wire-format field**: `packages/orchestrator/src/types/monitor.ts:38-43` (`PrFeedbackMetadata.retryAttempt?: number`).
- **Spec bundle**: `specs/1070-problem-when-pr-feedback/` (spec, clarifications, plan, research, data-model, contracts).
