# Tasks: `/cockpit:auto` doorbell full-event wake line (#985)

**Input**: Design documents from `/specs/985-summary-cockpit-auto-exhausts/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/line-schema.md, contracts/checks-mapping.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (all tasks in this issue map to **US1**)

## Phase 1: Schema Extension (foundation)

- [X] **T001** [US1] Extend `CockpitEventSchema` in `packages/generacy/src/cli/commands/cockpit/watch/emit.ts` with optional `checks: z.enum(['green', 'red', 'pending']).optional()` field (see data-model.md §"Type definitions", contracts/line-schema.md §"Field constraints"). Propagate to the `CockpitEvent` interface in `packages/generacy/src/cli/commands/cockpit/watch/diff.ts` by adding `checks?: 'green' | 'red' | 'pending'`. Do NOT change any other field. This must land first so T004 can attach the field without a type error.

## Phase 2: Core Doorbell Changes

- [X] **T002** [P] [US1] Rewrite `lineForEvent` at `packages/generacy/src/cli/commands/cockpit/doorbell/subscribe.ts:22-24` (FR-001) to serialize the full event as NDJSON — replace `return \`${event.type}\n\`;` with `return \`${JSON.stringify(event)}\n\`;`. Do NOT revalidate here; validation already happens at the `webhook-to-event.ts` `buildEvent` boundary (research.md §"NDJSON serialization"). This one change updates both the poll-fallback path (`subscribeAndEmit`) and the smee path (`doorbell.ts:236-247` `onEvent`) because both route through `lineForEvent`. Parallel with T003 — different file.

- [X] **T003** [P] [US1] Populate `to` locally on smee events by editing `buildEvent` in `packages/generacy/src/cli/commands/cockpit/doorbell/webhook-to-event.ts:109-132` (FR-003). Replace `from: null, to: null, sourceLabel: sourceLabelArg` with `const classified = classifyIssue(labels); ... from: null, to: classified.state, sourceLabel: classified.sourceLabel ?? sourceLabelArg`. Import `classifyIssue` from `../shared/classify-issue.js`. `classifyIssue` is pure — zero I/O, zero `gh` calls (research.md §"Local label classification"). Parallel with T002 — different file.

- [X] **T004** [US1] Stamp `checks` in `SmeeDoorbellSource.processEventBlock` at `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts` (FR-004/FR-005). After `webhookToStreamEvent(...)` returns and before `await this.onEvent(ev)`, for each returned event where `ev.type === 'issue-transition'` AND (`ev.event === 'pr-checks'` OR (`ev.event === 'label-change'` AND `ev.sourceLabel === 'completed:validate'`)), look up `snap = this.prev.get(snapshotKey(ev.repo, 'pr', ev.number))`. If `snap?.kind === 'pr'`, apply the strict `mapChecks` per `contracts/checks-mapping.md`: `success → 'green'`, `failure | error → 'red'`, `pending | none → omit`. Attach `checks` to the event **only** when the mapping yields `'green'` or `'red'`; otherwise, omit entirely (Q4=A). Add a single load-bearing one-liner comment on the stamp site: `// no gh calls — read-through PrSnapshot cache only (FR-005)`. Depends on T001 (schema extension). Depends on T003 not required at compile time but the `sourceLabel` populated in T003 is what this branch keys on for `completed:validate` events.

## Phase 3: Tests

- [X] **T005** [P] [US1] Extend `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/webhook-to-event.test.ts` to assert (FR-008b, INV-2): for a webhook payload with representative label sets (e.g., `['waiting-for:clarification', 'process:speckit-feature']`, `['completed:validate']`, `['agent:error']`), `buildEvent(...).to === classifyIssue(labels).state` and `sourceLabel` reflects `classified.sourceLabel` when present. Verify `from` remains `null` (Q3=A). Parallel with T006/T007/T008 — different file.

- [X] **T006** [P] [US1] Extend `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/smee-source.integration.test.ts` for (a) `checks` stamping per the `contracts/checks-mapping.md` test matrix (FR-008d, INV-4) — drive fixtures where `this.prev` has known `PrSnapshot.checksRollup` values (`success`/`failure`/`error`/`pending`/`none`/cache-miss) across both `pr-checks` and `label-change`(`sourceLabel='completed:validate'`) events, and across an unrelated event kind (e.g. `issue-closed`) to prove the presence-rule filter; (b) **no-gh assertion** (FR-008c, INV-1) — mock `GhCliWrapper` and assert **zero** method invocations between webhook receipt and `onEvent` dispatch on the smee event path. Parallel with T005/T007/T008 — different file.

- [X] **T007** [P] [US1] Add a line-shape unit test (FR-008a, INV-3) — either in an existing `subscribe.test.ts` under `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/` or a new sibling file — that captures the string written by `lineForEvent` for each of the three `CockpitStreamEvent` variants (`issue-transition`, `phase-complete`, `epic-complete`), `JSON.parse`s it, and runs it through `CockpitStreamEventSchema.parse` — MUST NOT throw, MUST terminate with a single `'\n'`. Parallel with T005/T006/T008.

- [X] **T008** [P] [US1] Update any poll-fallback / doorbell test that previously asserted `line === "issue-transition\n"` (or equivalent bare-type string equality) to parse the line as JSON and assert `event.type === "issue-transition"` (contracts/line-schema.md §"Backward compatibility": "Prior-shape assertions are load-bearing and will fail loud"). Grep the doorbell/watch test tree for such assertions before editing. Parallel with T005/T006/T007.

## Phase 4: Changeset

- [X] **T009** [US1] Add `.changeset/985-doorbell-full-event-line.md` with a `minor` bump for `@generacy-ai/generacy` (FR-009, plan.md §"Constitution Check"). Body: one-sentence "why" — the doorbell stdout contract now carries the full event as NDJSON so `/cockpit:auto` no longer re-queries GitHub per wake (removes the ~5000 pts/hr amplifier). This is a newly-added file per the changeset gate rule in project CLAUDE.md (`--diff-filter=A`).

## Dependencies & Execution Order

**Sequential edges**:
- **T001 → T004**: T004 attaches the `checks` field, which requires the schema field to exist. Landing T004 without T001 is a type error.
- **T003 → T004** (soft): T004 branches on `sourceLabel === 'completed:validate'`; the value is populated by T003 (`classified.sourceLabel`). Not a compile dep — the smee `buildEvent` may still fall back to `sourceLabelArg` if T003 hasn't landed — but the `completed:validate` branch is dead until T003 is in.
- **T002 → T007/T008**: The line-shape and legacy-assertion tests key on the new NDJSON shape. If T007/T008 land first they fail red until T002 lands.
- **T004 → T006**: The `checks`-stamp assertions in T006 exercise T004's stamp logic. Same red-until-landed dynamic.
- **T003 → T005**: The `to` correctness assertions in T005 exercise T003's `classifyIssue` call.

**Parallel opportunities**:
- **T002** and **T003** are independent files (`subscribe.ts` vs `webhook-to-event.ts`) — parallelize.
- **T005**, **T006**, **T007**, **T008** are independent test files — parallelize (they may all be written concurrently once the production changes they exercise have landed, or written first and left red until the production changes catch up).
- **T009** (changeset) is independent of all production/test work — can land any time before the PR is merged.

**Recommended ordering**:
1. **T001** (schema extension) — blocks T004.
2. **T002** and **T003** in parallel — independent production changes.
3. **T004** — depends on T001 (compile) and T003 (semantic).
4. **T005, T006, T007, T008** in parallel — test coverage.
5. **T009** — changeset (any time; latest = when opening the PR).

## Success Criteria Mapping

| Task | FRs / SCs / INVs satisfied |
|------|-----------------------------|
| T001 | Type foundation for FR-002/FR-004 |
| T002 | FR-001, SC-003 (poll-path parity) |
| T003 | FR-003, INV-2 |
| T004 | FR-004, FR-005, SC-002, INV-1, INV-4 |
| T005 | FR-008b, INV-2 |
| T006 | FR-008c, FR-008d, INV-1, INV-4 |
| T007 | FR-008a, INV-3 |
| T008 | SC-003, SC-004 (backward-compat drift audit) |
| T009 | FR-009 (changeset gate) |

Deferred / out-of-scope for #985 (per spec §"Out of Scope"):
- Live end-to-end `gh api rate_limit` delta measurement (Q5=B — reasoned inference sufficient to merge).
- MCP-server `gh` wrapper caching + rate-limit scheduler wiring (secondary amplifier — separate follow-up).
- Skill-side consumer in `generacy-ai/agency#437` (separate repo, degrades gracefully against a legacy bare-type line).

## Grouping Strategy for Issue Creation

Default: `epic-grouping:per-story`. All 9 tasks map to **US1** — a single child issue works well. If the maintainer prefers finer granularity, apply `epic-grouping:per-phase` to split into four child issues (schema / core / tests / changeset).

## Next Step

Run `/speckit:implement` to begin execution. Suggested first hop: **T001** (schema extension), then **T002 || T003** in parallel.
