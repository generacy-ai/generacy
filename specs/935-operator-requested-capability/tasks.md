# Tasks: Operator-requested capability — cockpit dynamic scope (#935)

**Input**: Design documents from `/specs/935-operator-requested-capability/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/ (cli-verbs, mcp-tools, parser-behavior, scope-writer, scope-retry)
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: All tasks trace to spec Change 1-5 (Live-membership contract, scope add/remove, single-issue queue, non-epic scope, isolation). Marked `[CH#]` where applicable; unmarked tasks are cross-cutting.

## Phase 1: Foundation (parser + resolver + gh wrapper)

**Rationale**: These are the leaf changes every other change depends on. `parseEpicBody` gains `adhocRefs`; `resolveEpic` relaxes on flat bodies; `GhWrapper` gains `updateIssueBody`. No cross-file coupling within this phase — all three can proceed in parallel.

- [ ] **T001** [P] [CH4] Extend `ParsedEpicBody` type in `packages/cockpit/src/resolver/types.ts`
  - Add `adhocRefs: IssueRef[]` field to `ParsedEpicBody` interface.
  - Update JSDoc per data-model.md §Modified types.

- [ ] **T002** [P] [CH4] Extend `parseEpicBody` in `packages/cockpit/src/resolver/parse-epic-body.ts`
  - Add `AD_HOC_HEADING_RE = /^##\s+ad-hoc\s*$/i` regex, placed before `HEADING_L2_RE` check per contracts/parser-behavior.md.
  - Introduce `adhocRefs: IssueRef[]` collection and `globalRefs` dedup map.
  - New branch: when `current == null` and a task-list ref line is encountered, collect into both `adhocRefs` and `allRefs` (dedup-safe).
  - `## Ad-hoc` heading terminates the current phase (sets `current = null`, resets `currentSeen`).
  - Return `{ phases, adhocRefs, allRefs, warnings }`.

- [ ] **T003** [P] [CH4] Extend parser tests in `packages/cockpit/src/resolver/__tests__/parse-epic-body.test.ts`
  - Cover the 6 body-pattern rows from contracts/parser-behavior.md §Semantics table.
  - Invariants I-1 through I-4 asserted per case (dedup, subset, purity, adhoc/phase collision-safe).
  - Warning taxonomy from #826 unchanged — assert regression.

- [ ] **T004** [P] [CH4] Relax `resolveEpic` in `packages/cockpit/src/resolver/resolve.ts`
  - Remove the `NO_PHASE_HEADINGS` throw at line ~57-59.
  - Keep `NO_REFS` throw when `parsed.allRefs.length === 0`.
  - `resolvedEpic.parsed.phases.length === 0` is now a valid successful return (flat-list mode).
  - Retain `NO_PHASE_HEADINGS` in the `LoudResolverErrorCode` union (deprecated, one release cycle) per data-model.md.

- [ ] **T005** [P] [CH4] Extend resolver tests in `packages/cockpit/src/resolver/__tests__/resolve.test.ts`
  - Flat body (no `### ` headings, has task-list refs) → resolves successfully, `phases: []`, `adhocRefs.length > 0`.
  - Empty body (no refs) → still throws `NO_REFS`.
  - Epic body with `## Ad-hoc` mixed in → phases + adhocRefs coexist.
  - Assert `NO_PHASE_HEADINGS` no longer thrown at runtime.

- [ ] **T006** [P] [CH2] Add `updateIssueBody` to `GhWrapper` in `packages/cockpit/src/gh/wrapper.ts`
  - New method `updateIssueBody(repo: string, issue: number, body: string): Promise<void>`.
  - Implementation: `gh issue edit <n> --repo <r> --body-file -` with `body` on stdin (safer than `--body` for large / shell-metachar bodies).
  - Wire through `CommandRunner`'s stdin option (verified pattern per research.md).

## Phase 2: Scope module — pure writer + retry loop + typed error

**Rationale**: Pure/local module — no dependency on Phase 1 code paths beyond the wrapper method from T006. The writer (T007) is pure; retry (T008) depends on writer + gh wrapper; errors (T009) is standalone. Tests parallel-safe with each implementation.

- [ ] **T007** [CH2] Implement `applyScopeMutation` in `packages/generacy/src/cli/commands/cockpit/scope/writer.ts` (NEW)
  - Export `detectShape(body)` returning `'phased' | 'flat'` (matches `parseEpicBody`'s `HEADING_L3_RE`).
  - Export `applyScopeMutation(body, mutation)` returning `{ noop, body, shape }`.
  - `add` for phased: insert under `## Ad-hoc` section (create if missing) per contracts/scope-writer.md §Semantics.
  - `add` for flat: append `- [ ] owner/repo#N\n` at body tail (preserve trailing newline).
  - `remove`: delete first matching task-list line (checked or unchecked); does NOT clean up empty `## Ad-hoc` heading (symmetry).
  - Idempotent both directions (I-2, I-3). Pure function — no I/O.

- [ ] **T008** [P] [CH2] Writer tests in `packages/generacy/src/cli/commands/cockpit/scope/__tests__/writer.test.ts` (NEW)
  - 11 test cases from contracts/scope-writer.md §Test cases table (all four shapes × mutations, idempotency, round-trip, format preservation).
  - Round-trip property: `apply(apply(b, add(r)).body, remove(r)).body ≈ b` (I-5).
  - Shape stability: add on phased never emits `### ` (I-6).

- [ ] **T009** [P] [CH2] Define `ScopeContendedError` in `packages/generacy/src/cli/commands/cockpit/scope/errors.ts` (NEW)
  - Class with fields `code: 'SCOPE_ADD_CONTENDED'`, `attempts: number`, `ref: IssueRef`, `mutation: 'add' | 'remove'`, `scope: { repo, number }`.
  - Same code name for both add and remove per spec Q5.

- [ ] **T010** [CH2] Implement `writeScopeWithRetry` in `packages/generacy/src/cli/commands/cockpit/scope/retry.ts` (NEW)
  - Depends on T006 (`updateIssueBody`), T007 (`applyScopeMutation`), T009 (`ScopeContendedError`).
  - Loop per contracts/scope-retry.md §Algorithm: read → mutate → write → readback → verify or retry.
  - Defaults: `maxAttempts=5`, `backoffMs=[100, 250, 500, 1000, 2000]`, `sleep` injectable (test seam).
  - On terminal verify-mismatch, throw `ScopeContendedError`. Read failures propagate (not retried — I-4).

- [ ] **T011** [P] [CH2] Retry tests in `packages/generacy/src/cli/commands/cockpit/scope/__tests__/retry.test.ts` (NEW)
  - 8 scenarios from contracts/scope-retry.md §Test cases table (single-try, noop, 1-race, 4-race, terminal, mid-race noop, getIssue-throws, SC-005 10-way).
  - Inject fake `sleep` — assert called counts + args match `backoffMs` prefix.
  - Fake `GhWrapper` serialises `updateIssueBody` and interleaves reads.

## Phase 3: CLI verbs — `cockpit scope add|remove`, `cockpit queue --issue`

**Rationale**: All CLI wiring depends on Phase 2 (scope module) and Phase 1 (parser/resolver). Scope verb + queue verb are file-independent; safe to parallel.

- [ ] **T012** [CH2] Implement `scopeCommand()` in `packages/generacy/src/cli/commands/cockpit/scope.ts` (NEW)
  - Two sub-commands via Commander: `add <scope-ref> <issue-ref>` and `remove <scope-ref> <issue-ref>`.
  - Both route both refs through `resolveIssueContext` (matches sibling verbs per #822/#850).
  - Call `writeScopeWithRetry({ mutation, scope, gh })` with the appropriate `kind`.
  - Print success line per contracts/cli-verbs.md §Behavior (shape/attempts/alreadyPresent for add; attempts/alreadyAbsent for remove).
  - Exit codes: `0` success or noop, `1` `SCOPE_ADD_CONTENDED` (print code + remedy), `2` arg-parse errors.

- [ ] **T013** [CH2] Register `scopeCommand()` in `packages/generacy/src/cli/commands/cockpit/index.ts`
  - `command.addCommand(scopeCommand())` after `resumeCommand()` (registration order per contracts/cli-verbs.md).

- [ ] **T014** [P] [CH2] CLI tests in `packages/generacy/src/cli/commands/cockpit/__tests__/scope.test.ts` (NEW)
  - Happy path for `add` and `remove` (deps-injection via runner/gh/loadConfig, matches sibling test style).
  - Contended path → exit 1 + `SCOPE_ADD_CONTENDED` on stderr.
  - Idempotent success (alreadyPresent / alreadyAbsent).
  - Ref-parse failure → exit 2.

- [ ] **T015** [P] [CH3] Add `--issue` form to `packages/generacy/src/cli/commands/cockpit/queue.ts`
  - New option `--issue <ref>`. Mutually exclusive with positional `<epic-ref> <phase>`.
  - Refactor mutation loop from `runQueue` (`queue.ts:505-528`) into `applyQueueMutation(row, assignee, gh)` — shared helper.
  - New `runQueueSingleIssue()` — reuses `classifyRow`, `resolveCockpitIdentity`, mutation pair; bypasses `resolveEpic`.
  - Output: single-row preview + summary line (not table).
  - Preserve `--label`, `--repo`, `--assignee`, `--yes` in single-issue form.
  - Validation errors: exit 2 with strings per contracts/cli-verbs.md §Validation.

- [ ] **T016** [P] [CH3] Extend queue tests in `packages/generacy/src/cli/commands/cockpit/__tests__/queue.test.ts`
  - `--issue` happy path (eligible → assign + label).
  - `--issue` skipped paths: closed / already-labeled / not-found.
  - Mutual exclusivity: `--issue` + `<epic-ref> <phase>` → exit 2 with the exact error string.
  - Neither arg form → exit 2.

## Phase 4: Watch/diff — mid-stream first-sight event

**Rationale**: Isolated change in `computeTransitions` — no coupling to Phases 1-3. Runs alongside them; blocks only the registry-liveness test in Phase 6.

- [ ] **T017** [P] [CH1] Modify `computeTransitions` in `packages/generacy/src/cli/commands/cockpit/watch/diff.ts`
  - Replace the `if (prevSnap == null) continue;` branch (lines ~167-176) with first-sight emission.
  - When `prev.size > 0` and key appears only in `curr`: if `isActionableSnapshot(currSnap)`, emit one `label-change` event with `initial: true`, `from: null`, `to: currSnap.classified.state`.
  - Non-actionable snapshots stay silent (matches `computeInitialSweep` policy).
  - Removal (key in prev but not curr) stays silent — no change (FR-002).

- [ ] **T018** [P] [CH1] Extend diff tests in `packages/generacy/src/cli/commands/cockpit/watch/__tests__/diff.test.ts`
  - Cycle 1 (`prev.size === 0`) unchanged behaviour asserted (regression).
  - Cycle N with new actionable key in curr → one `initial: true` event.
  - Cycle N with new non-actionable key in curr → no event.
  - Cycle N with key removed from curr → no event (removals silent).
  - Assert invariants I-1 through I-3 from contracts/parser-behavior.md §computeTransitions.

## Phase 5: Status — flat-mode render + adhoc group

**Rationale**: Depends on Phase 1 (resolver relaxation). Independent of scope + queue paths.

- [ ] **T019** [P] [CH4] Add flat-mode render to `packages/generacy/src/cli/commands/cockpit/status.ts`
  - When `parsed.phases.length === 0`, render a single ungrouped table.
  - Header format: `Scope: owner/repo#N  (flat, N refs)` or `(phased, N refs)`.
  - When phased with `adhocRefs.length > 0`, render an additional `Ad-hoc` group after phase groups.

- [ ] **T020** [P] [CH4] Add adhoc group to `packages/generacy/src/cli/commands/cockpit/status/group.ts`
  - Include adhoc refs as a distinct group with heading `Ad-hoc` in phased-body responses when non-empty.

- [ ] **T021** [P] [CH4] Extend status tests in `packages/generacy/src/cli/commands/cockpit/__tests__/status.test.ts`
  - Flat body → single ungrouped table, header `(flat, N refs)`.
  - Phased body with `## Ad-hoc` section → phases + Ad-hoc group.
  - Empty adhocRefs on phased body → no Ad-hoc group emitted.

## Phase 6: MCP surface — schemas, tools, server, error class

**Rationale**: Depends on Phase 2 (scope module) and Phase 3 (queue refactor). Schema + errors are foundation; tools depend on schemas; server registration depends on tools.

- [ ] **T022** [CH2] Add scope schemas + modify queue schema in `packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts`
  - `CockpitScopeAddInputSchema = z.object({ scope: EpicRefInputSchema, issue: IssueRefInputSchema }).strict()`.
  - `CockpitScopeRemoveInputSchema` (same shape).
  - Convert `CockpitQueueInputSchema` to `z.union([{ epic, phase }, { issue }])` discriminated union per data-model.md.

- [ ] **T023** [P] [CH2] Add error classes to `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts`
  - `'contended'` (maps to `SCOPE_ADD_CONTENDED`).
  - `'scope-not-found'` (maps to scope-issue 404).
  - Reuse existing classes for `invalid-args` etc.

- [ ] **T024** [CH2] Implement `cockpit_scope_add` handler in `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_scope_add.ts` (NEW)
  - Validate input with `CockpitScopeAddInputSchema` (invalid → `class: 'invalid-args'`).
  - Normalize refs via `normalizeIssueRef({ expects: 'issue' })`.
  - Call `writeScopeWithRetry({ mutation: {kind:'add', ref}, scope, gh })`.
  - Catch `ScopeContendedError` → return `class: 'contended'` with code string in `detail`.
  - Catch `getIssue` 404 on scope → `class: 'scope-not-found'`.
  - Success envelope: `{ scope, ref, shape, alreadyPresent, attempts }`.

- [ ] **T025** [CH2] Implement `cockpit_scope_remove` handler in `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_scope_remove.ts` (NEW)
  - Same shape as T024, inverse mutation.
  - Success envelope: `{ scope, ref, alreadyAbsent, attempts }`.
  - Same error classes; `contended` still emits code `SCOPE_ADD_CONTENDED`.

- [ ] **T026** [CH3] Modify `cockpit_queue` handler in `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_queue.ts`
  - Dispatch on discriminator: `{ epic, phase }` → existing behaviour; `{ issue }` → new single-issue branch.
  - Issue branch shares `classifyRow` + `resolveCockpitIdentity` + mutation pair from the CLI refactor in T015.
  - Result shape: phase form unchanged; issue form returns `CockpitQueueIssueData` per data-model.md.

- [ ] **T027** [CH2] Register scope tools in `packages/generacy/src/cli/commands/cockpit/mcp/server.ts`
  - `server.registerTool('cockpit_scope_add', {...}, handler)` after `cockpit_queue`.
  - `server.registerTool('cockpit_scope_remove', {...}, handler)` after `cockpit_scope_add`.
  - Descriptions per contracts/mcp-tools.md §Registration order.

## Phase 7: MCP parity + registry-level integration tests

**Rationale**: End-to-end tests pinning the load-bearing contracts. All parallel; depend on Phases 4, 5, 6.

- [ ] **T028** [P] [CH2] Parity test in `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-scope-add.test.ts` (NEW)
  - MCP-form `cockpit_scope_add` result parity with CLI `scope add` for equivalent input.
  - Idempotent repeats → `alreadyPresent: true` on 2nd call.
  - Contended path → `class: 'contended'` envelope.

- [ ] **T029** [P] [CH2] Parity test in `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-scope-remove.test.ts` (NEW)
  - MCP-form `cockpit_scope_remove` parity with CLI `scope remove`.
  - Idempotent (already-absent) return.

- [ ] **T030** [P] [CH3] Extend parity test in `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-queue.test.ts`
  - Issue-form call: `{ issue }` input drives the same mutation pair as phase form for one row.
  - Union type validation: passing `{ epic, phase, issue }` fails schema.

- [ ] **T031** [P] [CH5] Registry isolation test in `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/registry-isolation.test.ts` (NEW)
  - Two concurrent `acquireEpicBus` calls with different scope refs (same repo).
  - Publish on bus A → assert bus B receives zero events. Verifies SC-004.

- [ ] **T032** [P] [CH1] Registry liveness test in `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/registry-liveness.test.ts` (NEW)
  - Subscribe to a scope issue; mutate its body mid-subscription to append a ref.
  - Assert an `issue-transition` event with `initial: true` arrives within one poll cycle. Verifies SC-001.

## Dependencies & Execution Order

**Phase order (sequential blockers)**:
- Phase 1 (T001-T006) → Phase 2 (T007-T011) → Phase 3 (T012-T016) → Phase 6 (T022-T027) → Phase 7 (T028-T032)
- Phase 4 (T017-T018) parallel to Phase 1-3 but blocks T032
- Phase 5 (T019-T021) needs T004 (resolver relaxation) only

**Within-phase parallelism**:
- Phase 1: T001-T006 all `[P]` (independent files).
- Phase 2: T007 → T010 (T010 needs writer); T008, T009, T011 `[P]` in parallel with impl.
- Phase 3: T012 → T013 (register after impl); T014, T015, T016 `[P]`.
- Phase 4: T017 + T018 `[P]`.
- Phase 5: T019, T020, T021 `[P]`.
- Phase 6: T022 → T024/T025/T026 → T027. T023 `[P]` throughout.
- Phase 7: T028-T032 all `[P]`.

**Success criteria coverage** (from spec):
- SC-001 (mid-cycle initial event) → T017 + T032.
- SC-002 (queue --issue parity) → T015 + T026 + T030.
- SC-003 (flat-list scope end-to-end) → T004 + T019-T021.
- SC-004 (two-tab isolation) → T031.
- SC-005 (10-way concurrent adds) → T011 (fixture).
- SC-006 (add/remove round-trip) → T008 (property test).

**Total tasks**: 32
**Phases**: 7
**Parallel-eligible tasks**: 24 (75%)

Next step: `/speckit:implement` to begin execution.
