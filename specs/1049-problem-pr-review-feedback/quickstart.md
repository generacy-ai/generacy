# Quickstart: PR review feedback must continue processing after a workflow completes

## What this feature does

Fixes a silent-drop defect: reviews posted on a PR whose linked issue has reached `completed:validate` (its last `agent:*` label stripped) were dropped by the PR-feedback monitor with only a `debug` log. After this fix:

1. **Post-validate reviews still enqueue.** The orchestration guard now accepts `workflow:*` or `completed:*` as evidence, in addition to `agent:*`.
2. **Silent drops become observable.** When a PR has pending human feedback and the monitor declines to process it, the log line lifts to `info` and names which gate rejected it.
3. **Merged PRs are explicitly excluded.** Webhook-delivered reviews on merged PRs are rejected before any git operation runs — preventing the fixer from resurrecting deleted remote branches.

## Prerequisites

- Node.js ≥22
- pnpm
- Running against a repo checkout at `/workspaces/generacy`

## Install & build

```bash
pnpm install
pnpm --filter @generacy-ai/orchestrator build
```

## Run the affected test suites

```bash
# Unit tests for the guard and the monitor
pnpm --filter @generacy-ai/orchestrator test --run \
  packages/orchestrator/src/worker/__tests__/pr-linker.test.ts \
  packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts \
  packages/orchestrator/src/routes/__tests__/pr-webhooks.test.ts
```

## Verify the fix manually (post-deploy)

### SC-001: Post-validate review reaches the fixer

1. Take an existing speckit PR whose linked issue is at `completed:validate` (no `agent:*` label).
2. Post a `Request changes` review with an inline comment on any file in the PR diff.
3. Wait for the next PR-feedback monitor poll (`PR_FEEDBACK_MONITOR_POLL_INTERVAL_MS`, default 60s).
4. Expect the monitor log to show:
   ```
   INFO  Processing PR review event from poll
   INFO  Linked PR #X to issue #Y via pr-body
   INFO  Found N unresolved review thread(s)
   INFO  PR feedback work enqueued
   ```
5. Expect the issue to gain `waiting-for:address-pr-feedback`.

### SC-004: Silent-drop diagnostic — `info` line names the gate

1. Take a PR whose linked issue has NO `agent:*` / `workflow:*` / `completed:*` labels (e.g., a manually-opened PR against an unrelated `bug` issue).
2. Post any review.
3. Expect the monitor log to include:
   ```
   INFO  PR-feedback event dropped by not-orchestrated gate (PR has 1 unresolved thread(s))
   ```
   with `gate: 'not-orchestrated'` in the structured fields.

### SC-006: Merged-PR gate prevents branch resurrection

1. Take a squash-merged PR whose head branch has been deleted (post-`cockpit merge`).
2. Post an inline review comment on the merged PR (this fires the webhook, not the poll).
3. Expect:
   ```
   INFO  PR-feedback event dropped by merged-pr gate (PR is merged; reviews on merged PRs are not processed)
   ```
   with `gate: 'merged-pr'` in the structured fields.
4. Verify the remote branch is NOT recreated (`git ls-remote origin '<branch>'` returns nothing).

## Available flags / config

No new configuration is introduced. The fix reads existing config:
- `CLUSTER_GITHUB_USERNAME` — assignee-cluster check (unchanged)
- `PR_FEEDBACK_MONITOR_POLL_INTERVAL_MS` — poll cadence (unchanged)
- `PR_FEEDBACK_MONITOR_WEBHOOK_SECRET` — webhook auth (unchanged)

## Troubleshooting

**Symptom**: Reviews on `completed:validate` PRs still don't enqueue.
- Check that `packages/orchestrator/src/worker/pr-linker.ts` `isOrchestrated` check uses the `ORCHESTRATION_PREFIXES` array with `'agent:', 'workflow:', 'completed:'` — not just `'agent:'`.
- Check that the linked issue actually carries a `workflow:*` or `completed:*` label (`gh issue view <N> --json labels`).
- Check the monitor is polling — look for `Processing PR review event from poll` at `info`.

**Symptom**: Wrong-cluster gate flooded `info` logs.
- Regression: the gate should remain at `debug` per Q3=B. Grep the monitor for `gate: 'wrong-cluster'` and verify the `.debug` (not `.info`) call site.

**Symptom**: Merged-PR gate did not fire on a webhook review.
- Verify `payload.pull_request.merged === true` was in the webhook payload. GitHub always sends this on `pull_request_review.submitted` events for merged PRs.
- Verify `pr-webhooks.ts` populates `prMerged: payload.pull_request.merged ?? false`.
- Verify `processPrReviewEvent` checks `event.prMerged` before calling `PrLinker`.

**Symptom**: Poll-delivered review on a merged PR reached the fixer.
- Not expected — `client.listOpenPullRequests` filters to `state: open`. If this happens, investigate the `openPRs` result set in `pollRepo` — merged PRs should not appear.

**Symptom**: `not-orchestrated` gate fires on an issue that HAS `workflow:*`.
- Check the label case (predicate is case-sensitive; GitHub normalizes to lowercase but custom label imports may not).
- Check that the label name has a colon (`workflow:speckit-feature`, not `workflow-speckit-feature`).

## Next steps

- Run `/speckit:tasks` to generate the ordered task list for implementation.
- Run `/speckit:implement` to execute the tasks (build + tests + changeset).
