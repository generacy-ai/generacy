# Quickstart: Implement #941

## Prerequisites

- Node ≥ 22, pnpm.
- Working checkout on branch `941-summary-during-snappoll`.
- `pnpm install` at repo root.

## Implementation order

1. **Add `AllowGateComplete` + `HumanGateCompletionUnauthorizedError` + `isHumanGateCompletion`** at the top of `packages/orchestrator/src/worker/label-manager.ts`.
2. **Modify `LabelManager.applyLabels`** to accept the optional `allow?: AllowGateComplete` param and add the pre-network guard branch. No public API changes.
3. **Add `ensureImplementationReviewGate()`** as a private method on `PrFeedbackHandler`. Wire it into the shared `finally` block in `handle()`, before `clearInProgressLabel(...)`.
4. **Write FR-007 unit tests** (`packages/orchestrator/src/worker/__tests__/label-manager.guard.test.ts`).
5. **Write FR-002 unit tests** (`packages/orchestrator/src/worker/__tests__/pr-feedback-handler.gate-reassert.test.ts`).
6. **Write FR-005 integration test** (`packages/orchestrator/src/__tests__/pr-feedback-gate-invariant.integration.test.ts`).
7. **Type-check + test locally.** `pnpm --filter @generacy-ai/orchestrator test`, `pnpm --filter @generacy-ai/orchestrator typecheck`.

## Manual verification (SC-005 reproduction)

Simulate the snappoll scenario against a scratch repo:

1. Create an issue + PR on a test repo. Add labels `waiting-for:implementation-review, agent:paused`.
2. Trigger a PR review with a `REQUEST_CHANGES` verdict, leaving intentional problems unresolved (e.g. commit a `.env` file).
3. Have the address-pr-feedback flow enqueue and run against the issue.
4. Observe terminal labels: MUST be exactly `{ waiting-for:implementation-review, agent:paused }` — no `completed:implementation-review` written.

If the terminal state includes `completed:implementation-review`, the fix regressed.

## Static verification (SC-002)

```
grep -RIn "AllowGateComplete.CockpitAdvance" packages/ --include='*.ts' --exclude-dir='__tests__'
```

Expected: zero non-test hits. The token exists as a type export for future writers; today, none exists.

## Deliberate-regression check (SC-003)

Temporarily add to `PrFeedbackHandler.handle()`, inside the happy-path branch, before the coalesced remove:

```ts
await github.addLabels(owner, repo, issueNumber, ['completed:implementation-review']);
```

Run `packages/orchestrator/src/__tests__/pr-feedback-gate-invariant.integration.test.ts`. It MUST fail with a message pointing at the offending write. Remove the deliberate regression before committing.

## Troubleshooting

- **FR-003 guard trips in an unexpected spot.** That's the diagnostic surface working as designed (Q1 → C). Read the `TerminalLabelOpError.cause` — it will be `HumanGateCompletionUnauthorizedError` with `.label` naming the offender. Trace back through the retry-loop's `site` field in the log. The writer is the defect FR-001 asks you to remove.
- **FR-002 log spams.** If `gate-label-missing-at-fix-exit` fires on every run, that means every fix-session exits with the gate label stripped. Investigate `LabelManager.onResumeStart` (which strips `waiting-for:*` on resume) — verify it's not being called at fix-session start for `address-pr-feedback` items. See spec §Out-of-scope for follow-up scope.
- **Integration test flakes on timing.** The FR-005 test drives a synchronous mock — no timing should be involved. If flakes appear, check whether the mock `AgentLauncher.launch` returns a synchronously-exiting child or awaits a real timer.

## Related

- Spec: `specs/941-summary-during-snappoll/spec.md`
- Clarifications: `specs/941-summary-during-snappoll/clarifications.md`
- Prior structural cleanup: #926 (shared `finally` in `PrFeedbackHandler.handle()`)
- Prior feedback-loop hardening: #883 (`blocked:stuck-feedback-loop`)
