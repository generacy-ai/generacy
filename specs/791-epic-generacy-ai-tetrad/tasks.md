# Tasks: `generacy cockpit queue <phase>`

**Input**: Design documents from `/specs/791-epic-generacy-ai-tetrad/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/queue.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 only for this verb)

## Phase 1: Adapter Extension

- [X] **T001** [US1] Extend `CockpitGh.fetchIssueState` in `packages/generacy/src/cli/commands/cockpit/gh-ext.ts` to return `assignees: string[]` and `title: string` alongside the existing `state`/`closedAt`/`labels`. Update the `gh issue view` JSON flag list to `state,closedAt,labels,assignees,title`. Extend `IssueStateSchema` (Zod) per data-model.md §7. Normalise `assignees` to `string[]` of logins. Additive change — no existing caller asserts exhaustive shape.

- [X] **T002** [US1] Add `addAssignees(repo: string, number: number, logins: string[]): Promise<void>` to `CockpitGh` in `packages/generacy/src/cli/commands/cockpit/gh-ext.ts`. Implementation: one `gh issue edit <n> --repo <repo> --add-assignee <login>` invocation per login via the shared `CommandRunner`. Delegate failure to the existing `fail()` helper (research.md R8).

## Phase 2: Pure Helpers (queue.ts internals)

- [X] **T010** [US1] Create `packages/generacy/src/cli/commands/cockpit/queue.ts` and declare the public TypeScript types from data-model.md: `QueueOptions`, `ResolvedPhase`, `ResolvePhaseError`, `ParsedIssueRef`, `EligibilityStatus`, `MutationOutcome`, `QueueRow`, `QueueResult`, `QueueCommandDeps`. Add `parseRef(s: string): ParsedIssueRef` (literal regex `/^[^/]+\/[^/]+#(\d+)$/`). No runtime logic yet.

- [X] **T011** [US1] In `queue.ts`, implement the pure helper `resolvePhase(manifests, phaseArg): ResolvedPhase | ResolvePhaseError`. Match rule: `phase.tier === phaseArg` OR `phase.name === phaseArg` (exact, case-sensitive). Cardinality per data-model.md §2: 0 → `not-found`; 1 → `ResolvedPhase`; ≥2 across distinct manifests → `ambiguous`. Walks every input manifest in input order (caller pre-sorts).

- [X] **T012** [US1] In `queue.ts`, implement `groupAndPickTargetRepo(issueRefs, repoFlag): { targetRepo: string } | { error }` (D4). Parse each ref via `parseRef`, group by `owner/repo`, then: 1 repo → use it; >1 repo and no `repoFlag` → error with sorted repo list; `repoFlag` present but not in the phase's repo set → error.

- [X] **T013** [US1] In `queue.ts`, implement `classifyRow(ref, targetRepo, viewResult)`: returns `EligibilityStatus`. `[SKIP: cross-repo]` when `ref.repo !== targetRepo`; `[SKIP: not found]` when `viewResult === null`; `[SKIP: closed]` when `state === 'CLOSED'`; otherwise `eligible` with `workflowLabel` derived as `labels.includes('type:bug') ? 'process:speckit-bugfix' : 'process:speckit-feature'` (D3 / FR-005).

- [X] **T014** [US1] In `queue.ts`, implement `renderPreview(resolvedPhase, targetRepo, assignee, rows): string[]` matching the contract in `contracts/queue.md` §"Stdout — Preview". Deterministic order: eligible rows first (repo-grouped, issue-number-sorted), then SKIP rows in the same order. Header line includes phase arg, resolved name/tier, eligible/skip counts, and target repo.

- [X] **T015** [US1] In `queue.ts`, implement `renderSummary(rows): string[]` matching `contracts/queue.md` §"Stdout — Confirmation outcomes". `Queued ...` for rows where both outcomes are `ok|already`; `FAILED ...` when either outcome is `error`. Both fields shown on every line so partial failures are legible.

## Phase 3: Verb Orchestration

- [X] **T020** [US1] In `queue.ts`, implement `runQueue(phaseArg, opts: QueueOptions, deps: QueueCommandDeps): Promise<QueueResult>` per the Implementation Flow in plan.md §"Implementation Flow". Sequence: validate CLI flags (exit 2 on bad shape) → `loadConfig({})` → glob `.generacy/epics/*.yaml` sorted → `readManifest` each → `resolvePhase` → `groupAndPickTargetRepo` → per-ref `gh.fetchIssueState` → `classifyRow` → resolve assignee (`--assignee` or `gh.getCurrentUser()`) → render preview to `deps.stdout`.

- [X] **T021** [US1] In `queue.ts`, wire the confirm gate (D6). If eligible count is 0: print `cockpit queue: no eligible issues — nothing to do.`, return `{ exitCode: 0, confirmed: false }`, perform zero `gh` writes. If `!opts.yes`: call `deps.prompt('Proceed?')`; decline / cancel → print `Cancelled. No mutations made.`, return `exitCode: 0, confirmed: false`, zero writes (SC-002 invariant).

- [X] **T022** [US1] In `queue.ts`, implement the mutation loop (D7). Iterate eligible rows in preview order, serial. Per row: if assignee not already in `row.assignees`, call `gh.addAssignees(repo, n, [assignee])`; if `workflowLabel` not already in `row.labels`, call `gh.addLabel(repo, n, workflowLabel)`. Capture each outcome as `MutationOutcome`. A failure in assign does NOT skip the label call (mutations are independent). A failure on row N does NOT abort row N+1 (FR-006 / Q4).

- [X] **T023** [US1] In `queue.ts`, compute and return the final `exitCode` per `contracts/queue.md` §"Exit codes" / research.md R9: `2` for usage errors (already returned by earlier branches), `1` if any row recorded `error`, else `0`. Print `renderSummary` lines via `deps.stdout` after the mutation loop.

- [X] **T024** [US1] In `queue.ts`, implement the Commander factory `queueCommand(deps?: QueueCommandDeps): Command`. Declare `<phase>` positional, `--repo <owner/repo>`, `--assignee <login>`, `--yes`. Action handler: `const result = await runQueue(phaseArg, opts, deps ?? {}); process.exit(result.exitCode);`. Default `deps` to a record that resolves `runner`, `gh`, `loadConfig`, `prompt`, `stdout`, `stderr`, `manifestRoot` from real implementations.

- [X] **T025** [US1] Wire into the CLI tree: add one `command.addCommand(queueCommand());` line in `packages/generacy/src/cli/commands/cockpit/index.ts` (D10).

## Phase 4: Tests

- [X] **T030** [US1] Create `packages/generacy/src/cli/commands/cockpit/__tests__/queue.test.ts`. Set up shared fixtures: a `tmpdir` helper that writes an inline epic-manifest YAML (single-phase, multi-phase, multi-repo, single-repo, mixed-type variants) and returns `manifestRoot`. Set up a stubbed `CockpitGh` whose `fetchIssueState` / `addAssignees` / `addLabel` / `getCurrentUser` calls are recorded and replayable. Mirror the seam used by `__tests__/advance.test.ts` and `__tests__/state.test.ts`.

- [X] **T031** [P] [US1] In `queue.test.ts`, add coverage for **phase resolution by `tier`** (R10 case 1) and **by `name`** (R10 case 2). Assert `result.resolvedPhase.name` and `tier`, and that `runQueue('P3', ...)` and `runQueue('foundation', ...)` resolve the same phase from the same manifest.

- [X] **T032** [P] [US1] In `queue.test.ts`, add coverage for **unknown phase → exit 2 with hint** (R10 case 3). Assert `result.exitCode === 2` and that the captured stderr contains the literal error message from `contracts/queue.md` §"Stderr — error envelopes" for `no matching phase`.

- [X] **T033** [P] [US1] In `queue.test.ts`, add coverage for **multi-repo phase without `--repo` → exit 2 with repo list** (R10 case 4) and **`--repo` outside phase's repos → exit 2** (R10 case 5). Assert exact stderr lines per contracts.md.

- [X] **T034** [P] [US1] In `queue.test.ts`, add coverage for **mixed `type:bug` + feature issues → correct per-issue workflow labels** (R10 case 6, SC-004). Assert each eligible row's `workflowLabel` and that the recorded `addLabel` calls use the right label per issue.

- [X] **T035** [P] [US1] In `queue.test.ts`, add coverage for **closed issue in phase → `[SKIP: closed]` row, not mutated** (R10 case 7). Assert no `addAssignees` / `addLabel` call against the closed issue's number.

- [X] **T036** [P] [US1] In `queue.test.ts`, add coverage for **confirm decline → zero `gh` write calls** (R10 case 8, SC-002). Inject a `prompt` stub returning `false`; assert `result.confirmed === false`, `result.exitCode === 0`, captured stdout contains `Cancelled. No mutations made.`, and the gh stub recorded zero `addAssignees` / `addLabel` calls.

- [X] **T037** [P] [US1] In `queue.test.ts`, add coverage for **`--yes` skips prompt and mutates eligible only** (R10 case 9). Inject a `prompt` stub that throws if called; assert `result.confirmed === true` and recorded mutations match the eligible row count.

- [X] **T038** [P] [US1] In `queue.test.ts`, add coverage for **rerun on already-queued phase → all `already`, exit 0, zero writes** (R10 case 10, SC-003). Seed the gh stub so `fetchIssueState` already returns the target assignee + workflow label. Assert every row's `assignResult.kind === 'already'` and `labelResult.kind === 'already'`, `exitCode === 0`, zero recorded write calls.

- [X] **T039** [P] [US1] In `queue.test.ts`, add coverage for **best-effort partial failure** (R10 case 11, Q4). Seed `addLabel` to throw for one issue; assert other issues still mutated, summary contains `FAILED ...` for the failing row, `exitCode === 1`.

- [X] **T040** [P] [US1] In `queue.test.ts`, add coverage for **`--assignee custom-bot` override** (R10 case 12). Inject a gh stub whose `getCurrentUser` throws if called; pass `--assignee custom-bot`; assert the recorded `addAssignees` call uses `custom-bot`.

- [X] **T041** [US1] Extend `packages/generacy/src/cli/commands/cockpit/__tests__/index.test.ts` to include `'queue'` in the expected verb-names array (D10).

## Phase 5: Polish

- [X] **T050** [US1] Run `pnpm --filter @generacy-ai/generacy test -- queue` and confirm all new cases pass. Run `pnpm --filter @generacy-ai/generacy typecheck` and `pnpm --filter @generacy-ai/generacy lint`.

## Dependencies & Execution Order

**Sequential within Phase 1**: T002 may depend on T001's updated `IssueStateSchema` if the test setup re-uses the schema; otherwise independent (still both in the same file).

**Phase 1 → Phase 2**: T010–T015 can begin as soon as T001 + T002 land (they reference the extended adapter via DI types only).

**Sequential within Phase 2 (queue.ts)**: T010 → T011 → T012 → T013 → T014 → T015. Same file; one author at a time.

**Phase 2 → Phase 3**: T020 depends on T010–T015 (composes them). T021–T024 are sequential continuations of T020 in the same file. T025 (`index.ts` wiring) requires T024 (the factory exists).

**Phase 3 → Phase 4**: T030 (test scaffolding) depends on T020+ (imports `runQueue` and the types). T031–T040 are marked `[P]` because they can be written in parallel — each owns an independent `describe` block within the same test file. T041 (index.test.ts extension) is independent of the queue.test.ts cases.

**Phase 5**: T050 runs last.

**Parallel opportunities**:
- T031–T040 within Phase 4 (per-case test authoring once T030 lands).
- T025 (`index.ts` one-liner) and T041 (`index.test.ts` extension) can land together as a small wiring commit, parallel with T031–T040.

**Critical path**: T001 → T002 → T010 → T011 → T012 → T013 → T014 → T015 → T020 → T021 → T022 → T023 → T024 → T030 → (T031–T040 in parallel) → T050.
