# Tasks: PR review feedback must continue processing after a workflow completes

**Input**: Design documents from `/specs/1049-problem-pr-review-feedback/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/orchestration-guard.md, contracts/drop-gate-logging.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1..US4)

## Phase 1: Types (shared foundation)

- [X] T001 [US4] Add `prMerged: boolean` (non-optional) to `PrReviewEvent` in `packages/orchestrator/src/types/monitor.ts` (existing interface at `:76-89`). Extend `GitHubPrReviewWebhookPayload.pull_request` (`:124-131`) with optional `merged?: boolean` and `merged_at?: string | null`. Match the JSDoc block in `data-model.md` verbatim so the field's provenance (webhook vs. poll) is documented at the type. No consumers wired yet — expect TS errors at test doubles and construction sites, resolved in T002/T004/T005.

- [X] T002 [P] [US1/US3] Define exported `PrLinkResult` discriminated union in `packages/orchestrator/src/worker/pr-linker.ts` per `data-model.md` §`PrLinkResult`: `{ kind: 'ok'; link: PrToIssueLink } | { kind: 'no-link' } | { kind: 'no-issue'; issueNumber: number } | { kind: 'not-orchestrated'; issueNumber: number }`. Keep `PrToIssueLink` unchanged. Do not change `linkPrToIssue`'s signature yet — the return-type widening happens in T003.

## Phase 2: Core `PrLinker` change

- [X] T003 [US1/US2/US3] Widen the orchestration guard AND change the return type in `packages/orchestrator/src/worker/pr-linker.ts`:
  - Add module-level constant `ORCHESTRATION_PREFIXES = ['agent:', 'workflow:', 'completed:'] as const` with the JSDoc from `data-model.md` (Q4 rationale is load-bearing — one WHY comment permitted per plan §Constitution Check).
  - Replace the `isOrchestrated` check at `:115` with the prefix-set-`some` idiom from `research.md` §Implementation patterns.
  - Change `linkPrToIssue`'s return type from `Promise<PrToIssueLink | null>` to `Promise<PrLinkResult>`. Apply the transition mapping table in `data-model.md`: no-body/branch-match → `{ kind: 'no-link' }`; `getIssue` throw → `{ kind: 'no-issue', issueNumber }`; guard false → `{ kind: 'not-orchestrated', issueNumber }`; success → `{ kind: 'ok', link }`.
  - Update the `debug` log wording at the not-orchestrated site to `'Linked issue carries no orchestration evidence (no agent:*, workflow:*, or completed:* label) — skipping non-orchestrated issue'` per plan §1. Level stays `debug` here (the `info` lift is caller-side).
  - Do NOT touch `parsePrBody` or link-resolution (FR-007).

## Phase 3: Monitor service — gate ordering, log levels, merged-PR

- [X] T004 [US4] In `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` `processPrReviewEvent`, add the merged-PR gate as the FIRST check after `'Processing PR review event from ${source}'`, before any `PrLinker` call. Shape per `contracts/drop-gate-logging.md` §G1: `if (event.prMerged) { logger.info({ owner, repo, prNumber, gate: 'merged-pr', source }, '...') ; return false; }`. Always `info` (no probe).

- [X] T005 [US1/US3] In the same file, migrate the `PrLinker` call site (`:148`) to the discriminated result per `data-model.md` §Caller migration. Introduce a small private `dropWithGateLog(client, event, result)` helper (co-located in the file — no new module) that:
  1. Computes `unresolvedThreads` via `probeUnresolvedThreads` (T006) ONLY for gates G2/G3/G4 (never G5/wrong-cluster, never G1/merged-pr — those bypass).
  2. Emits `logger.info` when count ≥ 1 (message + `gate:` field per `contracts/drop-gate-logging.md` §Log-line shape) or `logger.debug` when count === 0 (same object with `unresolvedThreads: 0`).
  3. On probe error: falls back to `logger.debug` with a `probeError: <msg>` field (contract §Probe helper — probe failure MUST NOT itself become an error signal).
  Route `no-link` and `not-orchestrated` returns through this helper; keep `no-issue` at `warn` per contract §G3b.

- [X] T006 [US3] Extract private helper `probeUnresolvedThreads(client, owner, repo, prNumber): Promise<number>` in the same file. Reuses `client.getPRReviewThreads(...)`, filters `t => !t.isResolved`, returns count. No caching. Not called on the wrong-cluster or merged-pr branches (contract §Probe helper).

- [X] T007 [US1/US3] Migrate the `assignees-empty` and `wrong-cluster` gates in the same file (existing sites around `:162-174`):
  - `assignees-empty` (G4): call `dropWithGateLog` with `gate: 'assignees-empty'` — probe fires, level lifts to `info` if ≥1 unresolved thread.
  - `wrong-cluster` (G5): stays `debug` unconditionally per FR-004 / Q3=B. Add `gate: 'wrong-cluster'` field for uniformity but DO NOT call the probe (contract §G5 explicit).
  - Add `gate: 'blocked-label-present'` field to the existing `blocked:*` info log at `:342-353` for parity (contract §Gate catalogue tail note). Level unchanged — already `info`.
  - Do NOT change link-stage, thread-trust, or `blocked:*` behavior beyond field parity (FR-007).

- [X] T008 [US4] In `pollRepo` in the same file, hardcode `prMerged: false` when constructing `PrReviewEvent` (poll uses `listOpenPullRequests` → open-only invariant, per D5).

## Phase 4: Webhook route

- [X] T009 [US4] In `packages/orchestrator/src/routes/pr-webhooks.ts` (event construction site around `:109-116`), populate `prMerged: payload.pull_request.merged ?? false`. The `?? false` is a boundary-sanitize for backward-compat with existing test doubles (plan §Constitution Check bullet 2 — this is boundary, not defensive validation).

## Phase 5: Tests

- [X] T010 [P] [US1/US2/US3] Extend `packages/orchestrator/src/worker/__tests__/pr-linker.test.ts` with:
  - Every positive row from `contracts/orchestration-guard.md` §Positive cases → returns `{ kind: 'ok', link: ... }`.
  - Every negative row from §Negative cases → returns `{ kind: 'not-orchestrated' | 'no-link' | 'no-issue' }` (whichever fires first).
  - Boundary-behaviour tests: `startsWith`-not-`includes` (`'agent-based-labeling'` must reject), case-sensitivity (`'Agent:in-progress'` must reject), no-trim.
  - Invariants I1–I5 asserted as tests (SC-001, SC-002, SC-003 map here).
  - Regression: `[{ name: 'workflow:speckit-feature' }, { name: 'completed:validate' }, { name: 'completed:implementation-review' }]` (post-advance shape) → `kind: 'ok'` — this is the SC-003 anchor.

- [X] T011 [P] [US1/US3/US4] Extend `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts` per `contracts/drop-gate-logging.md` §Invariants:
  - INV-1 through INV-6 (each drop-gate scenario, exact spy expectations on `logger.info` / `logger.debug` and `gate:` field values).
  - Merged-PR gate: `event.prMerged: true` → `logger.info` with `gate: 'merged-pr'`, NO `PrLinker` call, NO enqueue (SC-006 unit half).
  - Zero-unresolved on all lift-eligible gates → `logger.debug`, negative assertion on `logger.info` (INV-6).
  - Probe error path → falls back to `debug` with `probeError:` field.
  - Post-`cockpit_advance` shape → enqueue path runs (SC-003 monitor-side).
  - Update existing test doubles to set `prMerged: false` by default and pass `PrLinkResult` shape from mocked `PrLinker`.

- [X] T012 [P] [US4] Extend `packages/orchestrator/src/routes/__tests__/pr-webhooks.test.ts`:
  - Webhook payload with `pull_request.merged: true` → constructed `PrReviewEvent` has `prMerged: true` (SC-006 webhook half).
  - Payload with `merged` omitted → `prMerged: false` (boundary-sanitize verified).
  - Update `createWebhookPayload` helper (or equivalent) to accept a `merged` override, defaulting to `false`.

## Phase 6: Changeset + verification

- [X] T013 [US1/US2/US3/US4] Add `.changeset/1049-pr-feedback-post-validate-guard.md` with front-matter `"@generacy-ai/orchestrator": patch` (defect fix under `workflow:speckit-bugfix` per CLAUDE.md changeset gate; no `workflow-engine` bump — no new label vocabulary, existing labels read as evidence only). Body: one sentence describing the widened guard + merged-PR gate + log-level lift; link `#1049`.

- [X] T014 [P] Run the affected suites per `quickstart.md`:
  ```
  pnpm --filter @generacy-ai/orchestrator test --run \
    packages/orchestrator/src/worker/__tests__/pr-linker.test.ts \
    packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts \
    packages/orchestrator/src/routes/__tests__/pr-webhooks.test.ts
  ```
  Fix any failures at the source — do NOT weaken assertions to make tests pass.

- [X] T015 [P] Run `pnpm --filter @generacy-ai/orchestrator build` to confirm the `PrLinker` return-type widening didn't break any consumer the plan's grep missed. Only two callers were expected (`pr-feedback-monitor-service.ts` prod, `pr-linker.test.ts` tests) — any surprise TS error means an unmapped caller. Migrate or file-follow-up.

- [X] T016 Full-repo type check: `pnpm typecheck` (or the repo's equivalent). Confirms no downstream package imports `PrLinker` and breaks on the widened return type.

## Dependencies & Execution Order

**Sequential chain (types → guard → callers → webhook → tests → verify)**:
- T001 (types) → T004, T008, T009 (all populate `prMerged`) → T011, T012 (tests depend on the shape).
- T002 (`PrLinkResult` type) → T003 (impl uses the type) → T005 (caller migration).
- T003 → T005, T007 (monitor callers must match `PrLinker`'s new return shape).
- T005 depends on T006 (`probeUnresolvedThreads` helper).
- T013 (changeset) can land any time before merge; group with T014/T015/T016 (verification) so the PR ships green.

**Parallel opportunities**:
- T010, T011, T012 are separate test files → `[P]` after their source files land (T003, T004–T008, T009 respectively).
- T014 (test run) and T015 (build) can run in parallel; T016 is independent.
- T002 can be written in parallel with T001 (different files); marked `[P]`.

**Anti-parallel constraints**:
- All monitor-service edits (T004, T005, T006, T007, T008) touch the SAME file — must serialize.
- Both `PrLinker` edits (T002 type, T003 impl) touch the SAME file — must serialize.

---

*Playbook coupling check*: spec.md and plan.md do NOT reference any `packages/claude-plugin-cockpit/commands/*.md` path. No `playbook-verification.test.ts` re-pin task required.

*Generated by speckit*
