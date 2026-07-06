# Tasks: Single-source epic discovery (G-S2)

**Input**: Design documents from `/specs/806-epic-generacy-ai-tetrad/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/resolver.md, contracts/cli.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 / US2 / US3), or blank for cross-cutting

## Phase 1: Setup

- [ ] T001 Confirm resolver home is `packages/cockpit/src/resolver/` and CLI adapters live under `packages/generacy/src/cli/commands/cockpit/`; verify the existing `GhWrapper` seam in `packages/cockpit/src/gh/` and note whether `getIssue(repo, number)` already exists or must be added in T012.

## Phase 2: Foundational (blocks all resolver work)

- [ ] T002 [P] Create `packages/cockpit/src/resolver/errors.ts` with `LoudResolverError` class carrying the union `code: 'INVALID_EPIC_REF' | 'GH_FETCH_FAILED' | 'NO_PHASE_HEADINGS' | 'NO_REFS' | 'AMBIGUOUS_PHASE_TOKEN' | 'PHASE_NOT_FOUND'`, optional `details`, and messages that always include the expected-format sentence (`### <phase>` headings + `- [ ] owner/repo#N` bullets) per contracts/resolver.md.
- [ ] T003 [P] [US1] Create `packages/cockpit/src/resolver/ref-shapes.ts` exporting `parseRef(line: string): IssueRef | null` recognising: bare `owner/repo#N`, `[owner/repo#N](…)`, `[#N](https://github.com/owner/repo/(issues|pull)/N)`, and plain `https://github.com/owner/repo/(issues|pull)/N`. Reject bare `#N` shorthand, non-integer/non-positive `N`, and unmatched URL variants (return `null` — caller records the FR-003 warning).
- [ ] T004 [P] [US3] Create `packages/cockpit/src/resolver/heading-match.ts` exporting `firstToken(heading: string): string` (split on `/[\s—\-:,.\/]/`, lowercase, take `[0]`) and `matchPhaseHeading(parsed: ParsedEpicBody, phaseArg: string): ParsedPhase` implementing FR-005: 0 matches → `LoudResolverError('PHASE_NOT_FOUND', { candidateHeadings })`, 1 → return, >1 → `LoudResolverError('AMBIGUOUS_PHASE_TOKEN', { candidateHeadings })`.
- [ ] T005 [P] Add/update shared `IssueRef` type export in `packages/cockpit/src/index.ts` (reuse existing definition per data-model.md) and add `ParsedPhase`, `ParsedEpicBody`, `ResolvedEpic`, `ResolveEpicOptions` interfaces in a new `packages/cockpit/src/resolver/types.ts`.

## Phase 3: US1 — Zero-config epic discovery from the issue body (P1)

**Goal**: `watch`/`status`/`queue` derive the child set from the epic body alone, with no manifest / no `repos` config / no label-search fallback (FR-001, FR-002, FR-006, FR-009; SC-001, SC-002, SC-003).

**Independent test**: run the CLI on a scratch repo with only `gh auth` + a conformant epic body; assert `status --epic <ref>` prints the grouped table for cross-repo refs and that an unparseable body exits non-zero with the expected-format message.

- [ ] T006 [US1] Create `packages/cockpit/src/resolver/parse-epic-body.ts` implementing `parseEpicBody(body: string): ParsedEpicBody` — line-oriented walk: level-3 heading regex `^### \s*(.+?)\s*$` opens a phase, level-4+ (`^####+ `) closes it, level-2 (`^## `) is ignored; task-list regex `^\s*-\s*\[[ xX]\]\s+(.+?)\s*$` extracts a ref candidate, delegates to `parseRef` from T003, and either appends to current phase or pushes a `warnings[]` entry naming the line number. Dedup within phase; compute `allRefs` as sorted `(repo, number)` union across phases (Q2 A). Pure — no I/O, no throws.
- [ ] T007 [US1] Create `packages/cockpit/src/resolver/resolve.ts` implementing `resolveEpic(options: ResolveEpicOptions): Promise<ResolvedEpic>` per contracts/resolver.md §resolveEpic — validate `epicRef` against `EPIC_REGEX` (throw `INVALID_EPIC_REF`), call `gh.getIssue(repo, number)` (throw `GH_FETCH_FAILED` on failure), call `parseEpicBody`, forward `warnings[]` to `options.logger?.warn` (FR-003), throw `NO_PHASE_HEADINGS` / `NO_REFS` per FR-006, return `{ epic, parsed, repos, bodyHash }` (sha256 of body).
- [ ] T008 [P] [US1] If T001 shows `GhWrapper.getIssue` is missing, add it in `packages/cockpit/src/gh/gh-wrapper.ts` calling `gh issue view <N> --repo <owner/repo> --json body,title,state` (existing `nodeChildProcessRunner`), and extend `MockGhWrapper` in `packages/cockpit/src/gh/__tests__/mock-gh-wrapper.ts` (or existing test-utils path) with `getIssue`.
- [ ] T009 [P] [US1] Export the resolver public API from `packages/cockpit/src/index.ts`: `parseEpicBody`, `resolveEpic`, `matchPhaseHeading`, `LoudResolverError`, and the four new types from T005. Remove the manifest re-exports (`EpicManifestSchema`, `EpicManifest`, `EpicEntry`, `PhaseEntry`, `PhaseEntrySchema`, `EpicEntrySchema`, `readManifest`, `writeManifest`, `resolveEpicIssues`, `ResolveEpicIssuesOptions`) — leave a compile error at every consumer for T017–T022 to clean up.
- [ ] T010 [P] [US1] Vitest unit tests `packages/cockpit/src/resolver/__tests__/ref-shapes.test.ts` covering: all four accepted shapes normalise to the same `IssueRef`; bare `#N` shorthand returns `null`; `N=0`, `N=-3`, `N=abc` return `null`; URL with fragment/query still parses if path matches; URL with mismatched path (`/tree/`, `/commits/`) returns `null`.
- [ ] T011 [P] [US1] Vitest unit tests `packages/cockpit/src/resolver/__tests__/heading-match.test.ts` covering: `firstToken('S2 — foo')` = `'s2'`; punctuation delimiters (`-`, `:`, `.`, `/`, `,`, em-dash, whitespace); `matchPhaseHeading` for 0/1/many matches with the correct `LoudResolverError` code and `candidateHeadings` payload.
- [ ] T012 [P] [US1] Vitest unit tests `packages/cockpit/src/resolver/__tests__/parse-epic-body.test.ts` covering the quickstart example body (FR-001 mixed `- [ ]`/`- [x]`, all four ref shapes, two phases); dedup within phase and across phases (Q2 A); ignored `## ` and `#### ` boundaries; warning entry emitted for a `- [ ] #8` line; empty body returns `{ phases: [], allRefs: [], warnings: [] }` (parser stays pure — caller throws).
- [ ] T013 [P] [US1] Vitest tests `packages/cockpit/src/resolver/__tests__/resolve.test.ts` using `MockGhWrapper` covering: happy path (returns `ResolvedEpic` with sorted `repos`, body hash present); `INVALID_EPIC_REF` on malformed `--epic`; `GH_FETCH_FAILED` when `getIssue` throws; `NO_PHASE_HEADINGS` and `NO_REFS` fail-loud paths (SC-003 regression); warnings from parser forwarded to `logger.warn`.

**Checkpoint**: US1 is implementable — resolver library is complete and importable; CLI verbs still on the old code path, wired in phases 4/5.

## Phase 4: US2 — Mid-epic children join watch automatically (P1)

**Goal**: `watch --epic <ref>` re-parses the epic body every tick; refs added mid-run join on the next tick, refs removed drop out. Default interval 30 000 ms, floor 15 000 ms with stderr-clamp-continue on below-floor (FR-007, FR-008; SC-004, SC-006).

**Independent test**: run `watch` against a mock `GhWrapper` whose `getIssue` returns body A on tick 1 and body A+one-more-ref on tick 2; assert tick 2 polls the new ref. Separately, run `watch --interval 5000`; assert one stderr line + effective 15 000 ms interval.

- [ ] T014 [US2] Refactor `packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts` to accept a `resolveEpic` callback (or `ResolvedEpic` producer) in place of the pre-computed `Scope`; call it at the top of every tick; on resolver error, log to `stderr` (`cockpit watch: poll error: <msg>`) and skip the tick (do NOT exit, do NOT reuse previous tick's refs).
- [ ] T015 [US2] Update `packages/generacy/src/cli/commands/cockpit/watch.ts`: drop the `--repos` flag (Commander will surface unknown-option error for old invocations); default `--interval` to `30_000`; clamp below-floor with `console.error('cockpit watch: --interval <N> below floor 15000ms; clamping.')` + continue at `15_000` (FR-007); startup resolver error → exit `1` with the FR-006 message; wire `resolveEpic` into the new poll loop from T014.
- [ ] T016 [P] [US2] Integration tests `packages/generacy/src/cli/commands/cockpit/__tests__/watch.test.ts`: (a) mid-epic ref appended between tick 1 and tick 2 appears in tick 2's poll set (SC-004); (b) `--interval 5000` emits one stderr clamp warning and continues at 15 000 ms (SC-006); (c) transient resolver error mid-run logs stderr + skips the tick without exiting; (d) startup `NO_PHASE_HEADINGS` exits `1` with the expected-format message (SC-003).

**Checkpoint**: US2 is fully deliverable — watch loop is complete; status/queue still on the old surface (fixed in Phase 5).

## Phase 5: US3 — Queue by phase heading (P1)

**Goal**: `queue <epic-ref> <phase>` enqueues every ref listed under the matched `### <phase>` heading with `--label` overriding the default `process:speckit-feature` (FR-005; SC-001). `status --epic` mirrors resolver-only scoping.

**Independent test**: run `queue owner/repo#42 s2` against a body with a `### S2 …` heading; assert every listed ref receives the label. Ambiguous token → exit 2 with candidate headings. Malformed `<phase>` → `PHASE_NOT_FOUND`.

- [ ] T017 [US3] Rewrite `packages/generacy/src/cli/commands/cockpit/queue.ts`: change signature to `queue <epic-ref> <phase>` (both positional, required); default `--label` to `process:speckit-feature`; call `resolveEpic` then `matchPhaseHeading(phase)`; enqueue `matchedPhase.refs` (Q2 A — refs under the requested heading, deduped within the heading); reuse existing eligibility filter for closed/already-labeled refs; validate `--label` with the existing GitHub label-name regex; keep `--repo`, `--assignee`, `--yes`; exit `2` on `INVALID_EPIC_REF`/`PHASE_NOT_FOUND`/`AMBIGUOUS_PHASE_TOKEN`.
- [ ] T018 [US3] Rewrite `packages/generacy/src/cli/commands/cockpit/status.ts`: make `--epic` required; drop `--repos`; call `resolveEpic()` once; feed `resolved.repos` into the existing per-repo `gh` listing; preserve grouped-table and `--json` envelope output paths; exit `1` on resolver error, `2` on malformed `--epic`.
- [ ] T019 [P] [US3] Integration tests `packages/generacy/src/cli/commands/cockpit/__tests__/queue.test.ts`: (a) `queue owner/repo#42 s2` labels every ref under `### S2 …`; (b) `--label` overrides the default; (c) ineligible (closed / already-labeled) refs skipped at preview; (d) ambiguous `<phase>` exits 2 and prints candidate headings; (e) unknown `<phase>` exits 2.
- [ ] T020 [P] [US3] Integration tests `packages/generacy/src/cli/commands/cockpit/__tests__/status.test.ts`: (a) grouped-table output for a multi-repo epic body (SC-002 regression); (b) `--json` single-line envelope; (c) unparseable body exits `1` with the expected-format message; (d) passing removed `--repos` flag exits with Commander unknown-option error.

**Checkpoint**: all three user stories are functional against the new resolver. Deletion (Phase 6) can now safely land without breaking green paths.

## Phase 6: Deletion & Config Cleanup (SC-005)

**Goal**: purge the manifest read path, label-search fallback, `repos` config field, `MONITORED_REPOS` env coupling, and stale CLI verbs (FR-009; SC-005). Ordering follows plan.md Phase 0 Decision 5: manifest CLI first, then resolver call sites, then config schema — every intermediate commit compiles.

- [ ] T021 Unregister the `manifest` subcommand in `packages/generacy/src/cli/commands/cockpit/index.ts` (remove `manifest` from the Commander program).
- [ ] T022 [P] Delete `packages/generacy/src/cli/commands/cockpit/manifest.ts` and the entire `packages/generacy/src/cli/commands/cockpit/manifest/` directory (`derive-slug.ts`, `diff-phases.ts`, `extract-plan.ts`, `parse-epic-body.ts`, `resolve-manifest-path.ts`, and any siblings).
- [ ] T023 [P] Delete `packages/generacy/src/cli/commands/cockpit/shared/scoping.ts` (replaced by direct `resolveEpic` calls from T014/T017/T018).
- [ ] T024 [P] Delete `packages/cockpit/src/manifest/` (schema.ts, io.ts, scoping.ts — including `resolveEpicIssues` and its label-search fallback that produced the generacy#801 wrong-repo hits).
- [ ] T025 [P] Delete all manifest tests under `packages/cockpit/src/__tests__/manifest/**` and `packages/generacy/src/cli/commands/cockpit/__tests__/manifest/**`.
- [ ] T026 Update `packages/cockpit/src/config/schema.ts` — drop the `repos` field from `CockpitConfigSchema`; drop `'monitored-repos-env'` variant from `CockpitConfigSource` if present.
- [ ] T027 Update `packages/cockpit/src/config/loader.ts` — remove the `MONITORED_REPOS` env branch and the `repos` loader path entirely (do not gate behind a deprecation warning per Decision 7).
- [ ] T028 Grep-check `rg -n 'manifest/|resolveEpicIssues|MONITORED_REPOS|cockpit\.repos' packages/cockpit/ packages/generacy/src/cli/commands/cockpit/` and confirm zero hits outside deleted files (SC-005 acceptance).

## Phase 7: Polish

- [ ] T029 [P] End-to-end quickstart smoke test (or manual walkthrough recorded in `specs/806-epic-generacy-ai-tetrad/quickstart.md`): fresh checkout with no `.generacy/`, no `MONITORED_REPOS`, only `gh auth`; run `status --epic <cross-repo-body>`, assert grouped table; run `watch --epic` briefly and confirm one NDJSON line + no stdout diagnostics (SC-001).
- [ ] T030 [P] Run `pnpm -w test --filter @generacy-ai/cockpit --filter @generacy-ai/generacy` and `pnpm -w lint` to confirm the deletion left no orphaned imports; fix any residual usage the T009 export-removal surfaced.
- [ ] T031 Update `packages/cockpit/README.md` and `packages/generacy/README.md` (if present) so the cockpit section documents only the resolver-driven surface — remove any lingering `manifest init|sync` / `--repos` / `MONITORED_REPOS` references.

## Dependencies & Execution Order

**Phase order** (sequential):

1. Setup (T001) → 2. Foundational (T002–T005) → 3. US1 core (T006–T013) → 4. US2 (T014–T016) → 5. US3 (T017–T020) → 6. Deletion (T021–T028) → 7. Polish (T029–T031).

**Blocking within phases**:

- T006 (`parseEpicBody`) depends on T003 (`parseRef`) and reads types from T005.
- T007 (`resolveEpic`) depends on T002 (errors), T006 (parser), T008 (`GhWrapper.getIssue`).
- T014 (poll-loop) → T015 (watch.ts) → T016 (watch tests).
- T017 (queue) and T018 (status) both depend on T004 (heading-match) + T007 (resolveEpic) + T009 (public export).
- T026 → T027 (schema must drop `repos` before loader stops loading it).
- T028 (grep check) depends on T021–T027 all landing.

**Parallel opportunities**:

- Phase 2: T002, T003, T004, T005 all touch different files — run in parallel.
- Phase 3 tests: T010, T011, T012, T013 all in `__tests__/` — run in parallel once T003/T004/T006/T007 land.
- Phase 3: T008 (add `getIssue`) and T009 (public re-exports) are independent — run in parallel.
- Phase 5: T019 (queue tests) and T020 (status tests) — parallel.
- Phase 6 deletions T022–T025 touch disjoint directories — parallel after T021 unregisters the CLI verb.
- Phase 7 polish T029–T031 — parallel.

**MVP boundary**: US1 (Phase 3) alone delivers zero-config `status` and unlocks SC-001/SC-002/SC-003. US2 and US3 are additive P1 requirements — each is independently shippable once its phase lands.

---

*Generated by speckit*
