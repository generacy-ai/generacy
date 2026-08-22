# Quickstart: Flag-matrix guardrails (#1165)

This feature closes four corners of the review/remediate flag matrix. Three are
orchestrator-worker changes plus tests; one is a doc-wording fix plus a pinning
test. This quickstart shows how to enable/disable the two flags, run the four
test files, and confirm each corner's behavior locally.

## Prerequisites

```bash
pnpm install
```

No emulator or external stack is required — all four corners are exercised by
Vitest unit/integration tests against in-package fakes.

## The two flags

Both default **OFF**. They are read in `packages/orchestrator/src/worker/config.ts`
and threaded through `claude-cli-worker.ts`.

| Flag env var                     | `WorkerConfig` field   | Default |
|----------------------------------|------------------------|---------|
| `WORKER_REVIEW_PHASE_ENABLED`    | `reviewPhaseEnabled`   | `false` |
| `WORKER_CI_MERGE_GATE_ENABLED`   | `ciMergeGateEnabled`   | `false` |

The four corners of interest:

- **Corner 1** — flag-OFF (`reviewPhaseEnabled=false`) validate failure now gets
  **one** bounded fix attempt before escalation (was: immediate `failed:validate`).
- **Corner 2** — `blocked:stuck-feedback-loop` behavior is unchanged; only the
  migration-guide prose is corrected.
- **Corner 3** — `speckit-bugfix` `implementation-review` gate follows
  `ciMergeGateEnabled` (post-validate `on-ci-green` when ON). No code change; pinned.
- **Corner 4** — unknown/custom workflows never enter `review` for either flag
  value, so the review↔remediate loop cannot become uncapped.

## Run the tests

```bash
# All four corners at once (from repo root):
pnpm --filter @generacy-ai/orchestrator test -- \
  phase-loop.flag-off-validate-fix \
  get-phase-sequence \
  config.bugfix-ci-gate \
  pr-feedback-stuck-loop
```

Or one corner at a time:

```bash
# Corner 1 — flag-OFF one-shot validate-fix fallback
pnpm --filter @generacy-ai/orchestrator test -- phase-loop.flag-off-validate-fix

# Corner 4 — getPhaseSequence fallback gating
pnpm --filter @generacy-ai/orchestrator test -- get-phase-sequence

# Corner 3 — speckit-bugfix on-ci-green gate under the flag
pnpm --filter @generacy-ai/orchestrator test -- config.bugfix-ci-gate

# Corner 2 — stuck-loop label still bounds the flag-OFF PR-feedback path
pnpm --filter @generacy-ai/orchestrator test -- pr-feedback-stuck-loop
```

## Confirm each corner's behavior

### Corner 1 — flag-OFF validate-fix fallback

Green means:
- flag OFF + validate fails once + remediate succeeds + validate re-run passes ⇒
  loop completes, no `failed:validate`, exactly one `remediateExecutor.execute` call.
- flag OFF + validate fails + remediate runs + validate fails again ⇒ exactly one
  `remediateExecutor.execute` call, then `failed:validate` escalation.
- flag OFF + `deps.remediateExecutor` undefined ⇒ escalates immediately.
- flag ON path and non-validate phases unaffected.

The new branch lives in `phase-loop.ts` between the flag-ON validate-fix block
(`:971-1090`) and the escalation fall-through (`:1092`), guarded by the new
block-local `flagOffValidateFixAttempted` boolean (at most one attempt per run).

### Corner 2 — stuck-loop doc reconcile

Green means the test asserts `blocked:stuck-feedback-loop` is still applied and
bounds the loop on the legacy PR-feedback path
(`pr-feedback-handler.ts:45`/`:632`). Then read the corrected line at
`docs/docs/guides/generacy/review-remediate-migration.md:140` — it must scope the
"retired/replaced" claim to the epic review/remediate path and affirm the label
remains the bounded stop on the flag-OFF PR-feedback legacy path.

### Corner 3 — speckit-bugfix CI gate

Green means parsing `WorkerConfigSchema` with `ciMergeGateEnabled: false` yields
`{ phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'on-request' }`
and with `true` yields
`{ phase: 'validate', gateLabel: 'waiting-for:implementation-review', condition: 'on-ci-green' }`.
No production change — the #1133 transform at `config.ts:229-247` already produces this.

### Corner 4 — getPhaseSequence

Green means:
- unknown workflow + `reviewPhaseEnabled=true` ⇒ result excludes `review`.
- unknown workflow + `reviewPhaseEnabled=false` ⇒ result excludes `review`.
- `speckit-feature` + `true` ⇒ includes `review` (regression guard).
- `speckit-feature` + `false` ⇒ excludes `review` (regression guard).
- `speckit-epic` (any flag) ⇒ never includes `review`.

## Manually flip a flag (optional)

To observe a full cluster run rather than the unit tests, set the env var before
starting the orchestrator worker:

```bash
WORKER_REVIEW_PHASE_ENABLED=true \
WORKER_CI_MERGE_GATE_ENABLED=true \
pnpm --filter @generacy-ai/orchestrator dev
```

With both unset (the default), behavior is byte-identical to pre-change on the
happy path (FR-009) — the only observable difference is that a flag-OFF validate
failure now attempts one remediate before escalating.

## Troubleshooting

- **`review` appears in a sequence you didn't expect** — check the workflow name.
  Only `speckit-feature`/`speckit-bugfix` with `reviewPhaseEnabled=true` include
  `review`. Any unknown workflow, and every flag-OFF known workflow, strips it.
- **Two remediate attempts on the flag-OFF path** — the block-local
  `flagOffValidateFixAttempted` guard was not set to `true` before the fix runs, or
  was reset. It must bind to exactly one attempt per phase-loop execution.
- **Partial work landed after a failed fixer** — the revert-on-non-push step
  (`context.github.discardWorkingTreeChanges(['.generacy'])`) did not run; a
  non-success, non-timeout remediate must leave the branch untouched (INV-2).
- **Changeset gate red** — the only production change is under
  `packages/orchestrator/src/`, so add `.changeset/1165-flag-matrix-guardrails.md`
  (`@generacy-ai/orchestrator` **patch**). The doc-only Corner 2 edit and all test
  files are exempt.
```