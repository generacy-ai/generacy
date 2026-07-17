# Tasks: Harden clarification-comment-finder with a content guard for stage-status comments (#962)

**Input**: Design documents from `/specs/962-follow-up-from-960/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/content-guard.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 is the only story)

---

## Phase 1: Regression Pin (write RED tests first)

Per SC-001, FR-006 must be RED before the finder change and GREEN after. Writing the test cases first proves the regression coverage and enforces the plan's TDD-style pin.

- [X] T001 [US1] Add FR-006 regression test to `packages/generacy/src/cli/commands/cockpit/__tests__/clarification-comment-finder.test.ts` — single at-or-after candidate whose body is `<!-- generacy-stage:planning -->\n\n<status table>`; assert `findClarificationComment` returns `null`. Run once now against the pre-guard finder to confirm RED (per quickstart.md §"Prove the FR-006 regression pin"). This is the load-bearing SC-001 pin.
- [X] T002 [P] [US1] Add FR-007 regression test to the same test file — single at-or-after candidate with `<!-- generacy-stage:clarification-batch-1 -->\n\n## Clarifications\n\n### Q1: …`; assert finder returns that comment (guards against a naïve `startsWith('<!-- generacy-stage:')` regression).
- [X] T003 [P] [US1] Add FR-008 regression test to the same test file — two at-or-after candidates at `T+1min` (stage-status planning table) and `T+2min` (real `<!-- generacy-stage:clarification-batch-1 -->` batch); assert finder returns the second (documents "skip and keep scanning" from FR-005).
- [X] T004 [P] [US1] Add FR-003 mixed-body test to the same test file — one at-or-after candidate whose body has `<!-- generacy-stage:planning -->` on line 1 AND `<!-- generacy-stage:clarification-batch-2 -->` on line 3; assert finder returns that comment (locks in Q1/B override-wins).
- [X] T005 [P] [US1] Add FR-002 speckit-legacy parity test to the same test file — one at-or-after candidate with `<!-- speckit-stage:implementation -->\n\n<status table>`; assert finder returns `null` (confirms all six FR-002 prefixes are honoured, including the three archived `speckit-stage:*` twins).
- [X] T006 [P] [US1] Add D7 quoted-marker safety test to the same test file — one at-or-after candidate with `> <!-- generacy-stage:planning -->\n\nQ1: my answer` (leading `> ` quote); assert finder returns that comment (confirms column-0 rule mirrors `commentCarriesQuestionMarker` and quoted markers never trigger the guard).

---

## Phase 2: Implement the content guard

Depends on Phase 1 (T001–T006). Tests T001–T006 must exist before the implementation lands, so the FR-006 RED→GREEN transition is observable (SC-001).

- [X] T007 [US1] In `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts`, add module-scope constant `STAGE_STATUS_REJECT_PREFIXES: readonly string[]` with the six FR-002 entries verbatim: `<!-- generacy-stage:planning`, `<!-- generacy-stage:specification`, `<!-- generacy-stage:implementation`, `<!-- speckit-stage:planning`, `<!-- speckit-stage:specification`, `<!-- speckit-stage:implementation` (as `const` assertion, no `-->` closer). See data-model.md §STAGE_STATUS_REJECT_PREFIXES.
- [X] T008 [US1] In the same file, add module-scope constant `CLARIFICATION_STAGE_OVERRIDE_PREFIXES: readonly string[]` with the two FR-003 entries verbatim: `<!-- generacy-stage:clarification`, `<!-- generacy-stage:clarification-batch-` (as `const` assertion; note the trailing hyphen on the second entry). See data-model.md §CLARIFICATION_STAGE_OVERRIDE_PREFIXES.
- [X] T009 [US1] In the same file, add private helper `isStageStatusComment(body: string): boolean` per data-model.md §Private helper — two passes, override-first: (1) iterate `body.split('\n')` and return `false` on any line startsWith an override prefix; (2) iterate again and return `true` on any line startsWith a reject prefix; (3) return `false`. Not exported.
- [X] T010 [US1] In the same file, in the existing `for (const c of sorted)` loop that returns the first at-or-after comment, insert `if (isStageStatusComment(c.body)) continue;` after the `createdAt >= labelTs` check and before `return c;`. The loop naturally falls through to `return null` when every candidate is rejected (FR-004). No signature change; no new export; no new import.

---

## Phase 3: Verify RED→GREEN and finish

- [X] T011 [US1] Re-run `pnpm --filter @generacy-ai/generacy test clarification-comment-finder` and confirm all 4 pre-existing tests + all 6 new tests (T001–T006) pass. Confirm the FR-006 case flipped from RED (pre-T007–T010) to GREEN (post-T007–T010) — this is the SC-001 pin proof.
- [X] T012 [US1] Run `pnpm --filter @generacy-ai/generacy typecheck` and `pnpm --filter @generacy-ai/generacy lint`; fix any new errors (there should be none — see quickstart.md §"Type-check + lint").
- [X] T013 [US1] Add `.changeset/962-clarification-finder-content-guard.md` with `patch` bump on `@generacy-ai/generacy` and a one-line summary (defensive content guard on `findClarificationComment` so stage-status tables never surface as the clarification batch). Rationale: defect fix, no new public capability, no new export. See CLAUDE.md §Changesets and plan.md §Constitution check.
- [X] T014 [US1] Verify SC-003 with `git diff --stat origin/develop...HEAD -- packages/ .changeset/` — expected diff, exactly three lines: `.changeset/962-clarification-finder-content-guard.md`, `packages/generacy/src/cli/commands/cockpit/__tests__/clarification-comment-finder.test.ts`, `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts`. Grep the finder for `clarification-markers` — expect no output (SC-003 hardcode-not-import rule). Any other file under `packages/` in the diff violates SC-003.

---

## Dependencies & Execution Order

**Phase order (strict, sequential):**
- Phase 1 → Phase 2 → Phase 3.
- Phase 1 tests must be written first so the FR-006 RED→GREEN transition in Phase 3 is observable (SC-001 pin).

**Within Phase 1 (parallel opportunities):**
- T001 through T006 all edit the same test file — they can be *authored* in parallel (independent test cases), but must be *committed* sequentially to avoid merge conflicts. Recommended: author all six in one editing pass. Marked `[P]` on T002–T006 to signal cognitive independence, but the file-level constraint applies.
- T001 is the load-bearing SC-001 pin; run it against the pre-guard finder to confirm RED before writing the guard.

**Within Phase 2 (strict order):**
- T007 → T008 → T009 → T010, all in the same file. T008 uses the same const style as T007; T009 references both constants; T010 calls T009's helper.

**Within Phase 3 (strict order):**
- T011 (test run) → T012 (typecheck/lint) → T013 (changeset) → T014 (SC-003 verify).

**Cross-file summary:**
- Files touched: 3 (finder, test, changeset). No cross-package edits (Q1/B).
- No dependent land-order concerns with other branches — the finder is the sole caller path this spec touches.

---

## Post-Command Note

- Total tasks: 14.
- Phase breakdown: Phase 1 (6 test tasks) / Phase 2 (4 implementation tasks) / Phase 3 (4 verification + changeset tasks).
- Parallel opportunities: T002–T006 are cognitively parallel within Phase 1 (same file, so serialize commits).
- Mode used: **Standard** (fine-grained).
- Suggested next step: `/speckit:implement` to begin execution.
