# Quickstart — #1092

## What this PR does (one paragraph)

`WebhookSetupService` now subscribes Generacy-managed GitHub webhooks to `pull_request_review`, `pull_request_review_comment`, and `issue_comment` in addition to the existing 4-event set, and heals existing hooks in place on orchestrator boot instead of silently warning. After this ships, PR review-comment / review-body findings and clarification-answer comments arrive over the smee channel within seconds of GitHub delivery instead of waiting for `PrFeedbackMonitorService` / `ClarificationAnswerMonitorService` polling (which #953 actively *widens* whenever an unrelated `issues.labeled` event flows on the same repo).

## Reviewer smoke test

### 1. Verify the constant widens (SC-001)

```bash
git diff develop -- packages/orchestrator/src/services/webhook-setup-service.ts | grep -A3 LOCKED_EVENTS
```

Should show three new entries: `pull_request_review`, `pull_request_review_comment`, `issue_comment`. `pull_request_review_thread` MUST NOT be present (Decision 5 / Assumption 7).

### 2. Verify the heal branch was added (SC-002)

```bash
grep -n "missing events — patched\|missingEvents\|newEvents" packages/orchestrator/src/services/webhook-setup-service.ts
```

Should show one `logger.info` call with the new message and the two structured fields.

### 3. Verify the warn line was deleted (FR-004)

```bash
grep -n "events not updated\|expectedEvents.*'issues'" packages/orchestrator/src/services/webhook-setup-service.ts
```

Should return **zero matches**. The pre-fix `logger.warn(..., 'Existing webhook has event mismatch - events not updated')` and its stale `expectedEvents: ['issues']` field are gone.

### 4. Verify the reactivate branch merges the full set (FR-005)

```bash
grep -n "hook.events, 'issues'\]" packages/orchestrator/src/services/webhook-setup-service.ts
```

Should return **zero matches**. The pre-fix `[...new Set([...hook.events, 'issues'])]` is replaced with `[...new Set([...hook.events, ...LOCKED_EVENTS])]`.

### 5. Pre-fix test failure demonstration (SC-007)

Prove the new tests catch a regression:

```bash
git worktree add ../generacy-1092-baseline HEAD~1
cd ../generacy-1092-baseline
pnpm install --frozen-lockfile
pnpm --filter @generacy-ai/orchestrator test webhook-setup-service.test.ts 2>&1 | tail -30
```

Expected: the new "should heal active webhook when events subset of LOCKED_EVENTS" test AND the updated reactivate-events tests fail against pre-fix source. Attach a screenshot / log excerpt to the PR description.

Clean up:

```bash
cd -
git worktree remove ../generacy-1092-baseline
```

### 6. Full-suite run

```bash
pnpm --filter @generacy-ai/orchestrator test webhook-setup-service.test.ts smee-receiver-987.test.ts
```

All existing branch tests (`create`, `update-url`, `skip-active`, `reactivate`, `foreign`) still pass. The new tests (`heal-on-skip-active`, idempotency SC-003) pass. `smee-receiver-987.test.ts` tests 6, 7, 8 (SC-005 pins) pass without modification.

### 7. Changeset present

```bash
ls .changeset/1092-*.md
```

Expect one file (`.changeset/1092-widen-locked-events.md` or similar) bumping `@generacy-ai/orchestrator` **patch**. Missing → CI's changeset gate will red-flag the PR (per CLAUDE.md).

## Operator post-deploy smoke test (SC-005 live-cluster check)

Not a CI gate, per Q4=C. Run on any cluster within one review cycle of the fix landing:

1. Submit a `CHANGES_REQUESTED` review with review-body findings on a Generacy-managed PR.
2. Watch orchestrator logs:

   ```bash
   docker compose logs -f orchestrator | grep -iE "pull_request_review|smee-receiver|processPrReviewEvent"
   ```

   Expected: a `pull_request_review` webhook event arrives via smee within seconds; `PrFeedbackMonitorService.processPrReviewEvent` fires.

3. Confirm the `/webhooks/pr` route observes non-zero traffic (US1 acceptance criterion 3).
4. Post a clarification-answer comment on an issue carrying `waiting-for:clarification` + `agent:paused`. Expected: `ClarificationAnswerMonitorService.processClarificationAnswerEvent` fires via smee, not polling.

## Fresh-boot-post-upgrade behavior (US3 / SC-002)

On the first orchestrator boot after this fix ships against a cluster with pre-existing Generacy webhooks:

```
INFO Existing webhook was missing events — patched
     owner=<org> repo=<repo1> webhookId=<id>
     missingEvents=["pull_request_review","pull_request_review_comment","issue_comment"]
     newEvents=["issues","pull_request","check_run","check_suite","pull_request_review","pull_request_review_comment","issue_comment"]
```

One line per managed repo. Second boot on the same repo hits the idempotent skip-active path (row 4a) with zero PATCH calls and only the existing `info: Webhook already exists and is active` line — no boot-log noise on repeat (FR-008 / SC-003).

## Troubleshooting

| Symptom | Diagnosis | Fix |
|---|---|---|
| First boot post-upgrade shows `warn: Webhook registration forbidden` for the heal PATCH | GitHub App is missing `admin:repo_hook` scope (same failure mode as create, now hit on PATCH too) | Cloud-side app permissions update. `cluster.bootstrap` relay event carries `reason: 'webhook-registration-forbidden'` (existing fail-loud triple, no change). |
| Second boot re-emits `Existing webhook was missing events — patched` for the same repo | PATCH silently returned success but did not persist (extremely rare GitHub API glitch) | Retry ships transparently — no boot-log noise if `hook.events` now includes LOCKED_EVENTS on next list. |
| `pull_request_review_thread` shows up in the log payload | Regression — this event should NOT be in LOCKED_EVENTS | Revert the tuple change (Decision 5). |
| Reactivate branch merges only `'issues'` in log payload | FR-005 not applied | Re-check `webhook-setup-service.ts:415` — must spread `...LOCKED_EVENTS`, not the string `'issues'`. |
| `WebhookSetupResult.action === 'healed'` appears in tests | Regression — Q1=A specifies reuse of `'reactivated'`, no new union member | Revert the action-union change (should never have been added). |

## Not in scope for this PR

- Any change to `smee-receiver.ts`, `PrFeedbackMonitorService`, `ClarificationAnswerMonitorService`, `LabelMonitorService`, `/webhooks/pr` route (FR-009).
- Any change to `adaptive-poll-controller.ts` (#953 orthogonal, FR-010).
- Adding `pull_request_review_thread` to `LOCKED_EVENTS` (Decision 5 / Assumption 7).
- Any operator CLI to force-heal outside boot (`generacy webhooks sync` etc.).
- Retroactive migration of hooks on non-Generacy-created webhooks (URL mismatch → foreign-hook branch, intentionally untouched).

## Next step

Run `/speckit:tasks` to generate the ordered task list from this plan.
