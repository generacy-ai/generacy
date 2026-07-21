# Tasks: Two remaining grammar-brittleness issues in the epic body resolver

**Input**: Design documents from `/specs/1014-summary-two-remaining-grammar/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)

---

## Phase 1: Types (foundation)

- [ ] T001 [US1,US2] Add `ParseEpicBodyOptions` interface in
  `packages/cockpit/src/resolver/types.ts`. Single optional field
  `defaultRepo?: string`, with the JSDoc from `data-model.md §New: ParseEpicBodyOptions`
  (validation pattern documented; malformed → warn + treat as absent; never throws).
  No changes to `IssueRef`, `ParsedPhase`, `ParsedEpicBody`, `ResolvedEpic`,
  `ResolveEpicOptions`.

- [ ] T002 [US1,US2] Re-export `ParseEpicBodyOptions` from
  `packages/cockpit/src/index.ts` next to the existing `parseEpicBody` export
  (per `data-model.md §Modified: parseEpicBody signature`).

---

## Phase 2: Parser core — H4 promotion (US1)

- [ ] T010 [US1] Modify the H4+ heading branch in
  `packages/cockpit/src/resolver/parse-epic-body.ts` (~lines 80–88).
  When a `####+` line's trimmed text matches `PHASE_SHAPED_H4_RE`, **open a phase**
  (push a new `ParsedPhase` onto `phases[]`, reset `currentSeen`, set
  `sawPhaseShapedH4 = true`) — mirrors the existing H3 branch's semantics.
  When it does NOT match, the branch becomes **transparent** — do NOT close
  `current`, do NOT reset `currentSeen`, `continue` without touching phase state.
  Reuse the existing `PHASE_SHAPED_H4_RE` from `parse-epic-body.ts:12` unchanged
  (no widening — per research.md D-1). Reference impl in `research.md §D-4`.
  Satisfies FR-001, FR-002.

- [ ] T011 [US1] In the same file, track `sawH3Phase = true` inside the existing
  H3 branch. After the parse loop finishes, if `sawH3Phase && sawPhaseShapedH4`,
  push exactly ONE warning with the stable marker substring `mixed phase heading levels`
  and wording per `research.md §D-5`
  (`cockpit: body mixes '###' and '####' phase headings; every phase-shaped heading opens a top-level phase (mixed phase heading levels)`).
  Satisfies FR-012.

- [ ] T012 [US1] Preserve the #1006 warning path (`sawPhaseShapedH4` flag +
  all-adhoc-zero-populated-phases loud signal, existing conditions at
  `parse-epic-body.ts` ~lines 167–177). Confirm no regression: the warning
  MUST still fire for bodies whose phase-shaped H4 sits outside any structure
  the new rule can rescue. Satisfies FR-008.

---

## Phase 3: Parser core — bare `#N` in checkboxes (US2)

- [ ] T020 [US2] Change `parseEpicBody` signature in
  `packages/cockpit/src/resolver/parse-epic-body.ts` (~line 64) to
  `parseEpicBody(body: string, options?: ParseEpicBodyOptions): ParsedEpicBody`.
  Additive-only; existing single-arg callers compile unchanged. Import
  `ParseEpicBodyOptions` from `./types`.

- [ ] T021 [US2] At the top of `parseEpicBody`, validate `options?.defaultRepo`:
  add `const DEFAULT_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/` (mirrors
  `OWNER_REPO` character class in `ref-shapes.ts:3`). On mismatch, push warning
  with marker substring `invalid defaultRepo`
  (`cockpit: parseEpicBody: invalid defaultRepo '<raw>' (invalid defaultRepo)`)
  and treat as if the option were absent. NEVER throw. Compute a single
  `effectiveDefaultRepo: string | undefined` and use it downstream. Satisfies FR-003.

- [ ] T022 [US2] At the ref-token resolution site in `parse-epic-body.ts`
  (~line 121, where `parseRef(refToken)` is called from within a `TASK_LIST_RE`
  branch), when `parseRef(refToken) === null` AND `effectiveDefaultRepo` is set
  AND `BARE_HASH_N_RE.test(refToken)`, synthesize `{ repo: effectiveDefaultRepo, number }`
  and use it as the resolved ref. Do NOT push a bare-`#N` warning in this path.
  Reuse the existing `BARE_HASH_N_RE` at `parse-epic-body.ts:28` — do NOT modify
  `ref-shapes.ts` (per research.md D-3 "wrap at the call site"). Applies ONLY
  inside `TASK_LIST_RE` lines — plain bullets / ordered items / prose remain
  unchanged (FR-013). Satisfies FR-004, FR-005 (no options → unchanged),
  FR-007 (bare binds only to `defaultRepo`, never inferred elsewhere).

---

## Phase 4: `resolveEpic` integration (US2)

- [ ] T030 [US2] In `packages/cockpit/src/resolver/resolve.ts` (~line 51),
  change the `parseEpicBody(body)` call site to
  `parseEpicBody(body, { defaultRepo: epic.repo })`. `epic.repo` is the
  canonical `"owner/repo"` string already parsed at ~line 40 via `parseEpicRef`.
  No plumbing changes upstream of `resolveEpic`. Satisfies FR-006.

---

## Phase 5: Writer — `detectShape` mirrors parser (US3)

- [ ] T040 [US3] Modify `detectShape` in
  `packages/generacy/src/cli/commands/cockpit/scope/writer.ts` (~lines 31–37).
  Add local constants `HEADING_L4_PLUS_RE = /^####+\s+/` and
  `PHASE_SHAPED_H4_RE = /^\s*(?:P\d+\b|.*\bphase\b)/i` **immediately above**
  `detectShape` with a comment: `// MUST match parseEpicBody's PHASE_SHAPED_H4_RE byte-for-byte (invariant I-2)`.
  Extend the per-line loop: after the existing `HEADING_L3_RE` check, if
  `HEADING_L4_PLUS_RE.test(line)`, strip the `####+ ` prefix, trim, and if the
  remainder matches `PHASE_SHAPED_H4_RE`, `return 'phased'`. Reference impl in
  `research.md §D-6`. Do NOT auto-normalize `####` → `###` on write — author
  formatting preserved. Satisfies FR-011.

---

## Phase 6: Tests — parser (Verification)
<!-- Depends on Phase 2, 3 -->

- [ ] T050 [US1] Extend
  `packages/cockpit/src/resolver/__tests__/parse-epic-body.test.ts` with cases for
  FR-001 (phase-shaped `#### P1 …` and `#### Phase 1: …` open phases and carry
  refs; `adhocRefs.length === 0`) and FR-002 (non-phase-shaped `#### Notes`
  inside `### Phase 1` — the ref that follows still attributes to Phase 1;
  `#### Notes` outside any open phase is a no-op). Mirror the shape of existing
  H3 tests in the same file.

- [ ] T051 [US1] Add test in the same file for FR-012: body containing both
  `### Phase 1` and `#### Phase 2` produces two flat sibling phases (order
  preserved) and `warnings` contains exactly one entry matching
  `/mixed phase heading levels/`. Assert count is 1 regardless of how many
  phase-shaped headings appear.

- [ ] T052 [US2] Add tests in the same file for FR-004 (positive:
  `parseEpicBody('- [ ] #223 body', { defaultRepo: 'my-org/my-repo' })` produces
  a ref `{repo: 'my-org/my-repo', number: 223}` and no bare-ref warning) and
  FR-005 (negative: same body with no options → today's warning behavior
  preserved; ref dropped from `phases[]`; warning marker substring `bare '#N'`
  present).

- [ ] T053 [US2] Add tests for FR-013 (bare `#N` outside checkbox is NOT
  scanned: `- #99`, `1. #99`, prose `see #99` under `defaultRepo` all
  produce no refs and no warnings) and FR-007 (cross-repo qualified
  `other/other-repo#5` inside a checkbox stays qualified — `defaultRepo` does
  not override).

- [ ] T054 [US2] Add tests for FR-003 (malformed `defaultRepo`): three
  variants — `'not-owner-repo'`, `'owner/repo/extra'`, `''` — each produces
  exactly one warning matching `/invalid defaultRepo/` and behaves as if
  the option were absent (bare `#N` inside checkbox rejected, matches
  no-options behavior byte-for-byte).

---

## Phase 7: Tests — fixtures (Verification)
<!-- Depends on Phase 2, 3 -->

- [ ] T060 [US1] Re-pin snapshot for
  `packages/cockpit/src/resolver/__tests__/fixtures/epic-1006-snappoll.md`.
  Run `pnpm --filter @generacy-ai/cockpit test -u` (or the project's snapshot
  update flag), then verify by inspection: H4-authored phases now populated
  with their child refs; `adhocRefs` is empty for those phases. Reference
  expected behavior in `research.md §D-8` and `spec.md SC-001`. Satisfies SC-001.

- [ ] T061 [US2] Create new fixture
  `packages/cockpit/src/resolver/__tests__/fixtures/epic-1014-bare-refs.md`
  with the content in `research.md §D-8` (bare `#N` checkboxes + one plain
  bullet `- #99` control + one cross-repo qualified ref). Add snapshot
  assertions in `parse-epic-body.test.ts`:
    - positive (with `defaultRepo: 'scope/scope-repo'`): 4 refs in phase 1
      (223/224/225 under `scope/scope-repo`, 226 under `other/other-repo`),
      1 ref in phase 2 (227 under `scope/scope-repo`), `warnings === []`.
    - negative (without `defaultRepo`): warnings contain 4 entries with
      marker `bare '#N'`; refs collapse accordingly. Satisfies FR-009.

- [ ] T062 [US3] Confirm zero snapshot diffs for all non-re-pinned fixtures
  (particularly `epic-826-*` — H3-authored, qualified refs). Run
  `pnpm --filter @generacy-ai/cockpit test` — if any fixture other than
  `epic-1006-snappoll.md` shows a diff, investigate before updating.
  Satisfies SC-004.

---

## Phase 8: Tests — resolveEpic + writer (Verification)
<!-- Depends on Phase 4, 5 -->

- [ ] T070 [P] [US2] Extend
  `packages/cockpit/src/resolver/__tests__/resolve.test.ts` with a case for
  FR-006: mock `gh.getIssue` to return a body containing `- [ ] #223`; call
  `resolveEpic({ epicRef: 'my-org/my-repo#1', gh })`; assert
  `r.parsed.allRefs[0]` has `repo === 'my-org/my-repo'` and `number === 223`,
  and `r.parsed.warnings.length === 0` (i.e. `defaultRepo` was passed
  through). Reference the recipe in `quickstart.md §Recipe 3`. Satisfies SC-002.

- [ ] T071 [P] [US3] Extend
  `packages/generacy/src/cli/commands/cockpit/scope/__tests__/writer.test.ts`
  with `detectShape` cases:
    - H4-phased body (`#### P1 — Scaffold\n- [ ] owner/repo#1`) → `'phased'`.
    - H4-phased body with `#### Phase 2: Foundation` → `'phased'`.
    - Existing `L4 headings do not make body phased` test at
      `writer.test.ts:24-26` (`#### notes` — not phase-shaped) MUST still
      classify as `'flat'` (regression). Also add an `applyScopeMutation`
      round-trip test on the H4-phased body: `scope add` places the new
      ad-hoc ref under a `## Ad-hoc` section at the tail, not appended at EOF
      (per `quickstart.md §Recipe 7`). Verifies FR-011 downstream effect.

- [ ] T072 [P] [US3] Confirm SC-005: direct `parseEpicBody(body)` (no options)
  behavior is byte-identical to today. Add a single regression test in
  `parse-epic-body.test.ts` that runs a canonical body through both signatures
  (`parseEpicBody(body)` and `parseEpicBody(body, undefined)`) and asserts
  `deepEqual` results.

---

## Phase 9: Changeset & CI gate

- [ ] T080 [US1,US2,US3] Add `.changeset/1014-h4-phase-and-bare-refs.md`
  with the content in `quickstart.md §CI gate`:

  ```
  ---
  "@generacy-ai/cockpit": minor
  "@generacy-ai/generacy": patch
  ---

  Resolver: phase-shaped `####` headings open phases; bare `#N` refs in checkboxes resolve to scope repo (#1014).
  ```

  Newly-added file (not editing an existing one) — required by CI gate.
  `@generacy-ai/cockpit` bump is `minor` because `parseEpicBody` gains new
  capability (additive options bag + new exported `ParseEpicBodyOptions` type
  from `index.ts`). `@generacy-ai/generacy` bump is `patch` because
  `detectShape` is internal-surface (not re-exported from any public entry).
  Satisfies FR-010, SC-006.

---

## Dependencies & Execution Order

**Sequential**:
- Phase 1 (T001–T002) blocks Phases 2, 3 (import path must exist).
- Phase 2 (T010–T012) is independent of Phase 3 (T020–T022) — different
  code branches inside `parse-epic-body.ts` — but both live in the same
  file, so they run sequentially by default (single-file merge conflict avoidance).
- Phase 4 (T030) depends on Phase 3 (T020 completes the signature change
  `resolveEpic` calls into).
- Phase 5 (T040) is independent of Phases 2–4 (different package). Can
  run in parallel with Phase 3 or Phase 4.
- Phase 6 (T050–T054) depends on Phases 2 and 3.
- Phase 7 (T060–T062) depends on Phases 2 and 3.
- Phase 8 (T070–T072) depends on Phases 4 (T070) and 5 (T071); T072
  depends on Phase 3 (T020).
- Phase 9 (T080) can start any time — no code dependency, but must be
  present when CI runs.

**Parallel opportunities**:
- T001 and T002 (marked no [P] — same-line-adjacent edits in the two
  `types.ts`/`index.ts` files, but small; run sequentially for review clarity).
- Phase 5 (T040) can run in parallel with the parser work in Phases 2/3
  — different package, no shared file.
- T070 / T071 / T072 all marked [P] — independent test files.
- Phase 7 fixture updates (T060, T061) touch different fixture files;
  can run in parallel.

**Manual quickstart verification** (before opening the PR): run the seven
recipes in `quickstart.md` against the built cockpit package. Especially
Recipes 1, 2, 3, 5, 7 map directly to US1 / US2 / US3 acceptance criteria.
SC-003 (`/cockpit:auto` advances) is optional live-rerun verification —
not blocking for merge if the fixture-driven SC-001 passes.

---

## Summary

- **Total tasks**: 22 (T001, T002, T010–T012, T020–T022, T030, T040,
  T050–T054, T060–T062, T070–T072, T080).
- **Mode**: Standard (fine-grained).
- **User stories covered**: US1 (H4 promotion + mixed-heading warning),
  US2 (bare `#N` under `defaultRepo`), US3 (backward compatibility +
  writer mirror).
- **Parallel opportunities**: Phase 5 with Phase 3/4; T060 with T061;
  T070/T071/T072 together.
- **Next step**: `/speckit:implement` to begin execution.
