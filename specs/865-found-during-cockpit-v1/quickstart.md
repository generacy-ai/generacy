# Quickstart: Failure-alert bottom-of-thread comment (#865)

Verification recipes for the fix. These are the observable end-to-end behaviors a reviewer should be able to reproduce.

## Prerequisites

- Local cluster running via `pnpm dev` (see `CLAUDE.md` for the full stack setup).
- Access to a private throwaway repo where you can trigger orchestrator workflows (e.g., `christrudelpw/sniplink-test`).
- GitHub CLI (`gh`) authenticated with a user account that watches the test repo (so notifications are observable).
- Cluster running the `865-found-during-cockpit-v1` branch's orchestrator image.

## Repro the buried-evidence bug (pre-fix baseline)

Confirm the `#847` fix ships the evidence but nobody sees it.

1. Check out `main` (before `#865` lands).
2. Trigger a validate failure: on any fresh repo scaffold, add `process:speckit-feature` label to a bug-report issue whose fix will fail validate. (Fastest: a single-package Next.js scaffold with no `test` script — `npm test` exits 1 immediately.)
3. Watch the issue thread:
   - The orchestrator posts the stage comment near the top of the thread within seconds of starting.
   - Comments accumulate mid-thread as the workflow progresses (labels, PRs, etc.).
   - When validate fails, the stage comment is edited *in place* to include the `#847` evidence block.
4. Observe:
   - **No new comment appears at the bottom of the thread.**
   - **Your GitHub email/mobile notifications show nothing new** (edits do not notify).
   - The evidence is present but invisible unless you scroll up.

This is the bug `#865` fixes.

## Verify the fix (post-`#865`)

Same repro, but with the `865-found-during-cockpit-v1` branch running:

1. Trigger the same validate-failure workflow.
2. When validate fails, observe:
   - **A new comment appears at the bottom of the issue thread.** Its first visible line looks like:
     ```
     ❌ **validate failed** — `npm test && npm run build` exit 1.
     ```
   - **You receive a GitHub notification** (email / mobile / web) for the new comment. The preview text shows the summary line above.
   - Clicking the notification lands on the new comment. Expanding the `<details>` section shows the full `buildErrorEvidence` output — failing command, exit descriptor, bounded stderr tail.
   - The original stage comment up-thread ALSO still has the evidence block (unchanged from `#847` — canonical state preserved).

## Verify no duplicate alerts on repeated polls

The orchestrator may call `updateStageComment({ status: 'error' })` multiple times during a single failure (retry logic, product-diff detection). Only one alert should appear.

1. Trigger a validate failure that causes two `status: 'error'` transitions within one `runPhaseLoop` invocation. (Any terminal-failure repro works — the loop only reaches one terminal site per invocation in practice, but the dedup path is exercised by the second `updateStageComment` poll on the same site.)
2. Count comments carrying the failure-alert marker:
   ```bash
   gh api repos/OWNER/REPO/issues/N/comments --jq '.[] | select(.body | contains("<!-- generacy:failure-alert:")) | .id'
   ```
3. Expected: exactly ONE comment ID printed.

## Verify no alerts on intermediate retries

Intermediate implement-retry failures (which the worker self-heals within `maxImplementRetries`) MUST NOT post alerts.

1. Set `maxImplementRetries: 2` in `.generacy/config.yaml` for the test repo.
2. Trigger an implement phase that fails on the first attempt but succeeds on retry. (Fastest way: use a prompt that causes Claude CLI to time out on the first invocation but complete on the second — e.g., a very ambiguous task description.)
3. Observe:
   - The stage comment shows `implement` progressing through retries → complete.
   - **Zero failure-alert comments appear on the issue.**
4. Confirm with the same `gh` command as above — no output.

## Verify the no-progress site emits evidence (FR-007)

The `phase-loop.ts:~278` no-progress guard previously fired without an evidence block. `#865` closes that gap.

1. Contrive an implement phase that stalls — same task count returned across two increments. (Direct repro is hard; easiest is a unit test — see `phase-loop.test.ts` after the fix lands, or use a mocked `implementResult` in a manual harness.)
2. When the no-progress guard fires, observe:
   - The stage comment's evidence block includes: **Failed command**: `implement (no-progress guard)`, **Exit**: `exit 1`, stderr tail: `no progress: tasks_remaining stayed at N across two increments`.
   - The bottom-of-thread alert comment includes the same evidence in its `<details>` block.

## Inspect the marker format

Cockpit tooling (future) parses the alert marker to discover history. Confirm the marker format matches the contract:

```bash
gh api repos/OWNER/REPO/issues/N/comments \
  --jq '.[] | select(.body | contains("<!-- generacy:failure-alert:")) | .body' \
  | head -c 200
```

Expected output starts with a line matching:
```
<!-- generacy:failure-alert:<stage>:<runId> -->
```

where `<stage>` is one of `specification` / `planning` / `implementation` and `<runId>` is a UUID v4.

## Rollback

If the fix causes noise or false positives:

1. Revert the merge PR: `gh pr revert <PR#>`.
2. Redeploy the orchestrator image.
3. Existing failure-alert comments remain on issues (they're plain GitHub comments). They render fine, they're just no longer refreshed. Their markers remain valid identifiers for post-hoc cockpit tooling that lands later.
4. No data migration is required. No schema change. No relay-payload change.

## Troubleshooting

**"I don't see any alert comment on the failed issue."**
- Confirm the orchestrator is running the `865-found-during-cockpit-v1` branch: `docker logs orchestrator | grep 'Posted failure alert comment'`.
- Confirm the failure was terminal, not intermediate: check `docker logs orchestrator | grep 'Implement phase failed with partial progress'` — if this line appears, the failure was intermediate and correctly silent.
- Confirm the `github.addIssueComment` call succeeded: check for `Posted failure alert comment` log at `info` level. If missing, look for exceptions from `getIssueComments` or `addIssueComment`.

**"I see two alert comments for one workflow run."**
- Two distinct alerts with different `<runId>` values indicates the worker restarted mid-run. Acceptable per Q4/A — the phase re-ran, so a fresh alert is right.
- Two identical `<runId>` values indicates a dedup bug. Capture the two comment bodies and file a bug — this violates FR-004.

**"The notification preview truncates the summary line at the exit descriptor."**
- Expected on long failing commands. The phase name (most important information) is at byte 0 of the summary line, so it always renders. The developer can click through for the descriptor.

**"The `<details>` block is broken — the fenced code block escaped."**
- Check the stderr tail for triple-backticks: `docker exec orchestrator cat /tmp/stderr.log | grep -c '\`\`\`'`. If non-zero, the neutralization substitution should have applied. File a bug if the substitution failed.
