# Implementation Plan: Harden clarification-comment-finder with a content guard for stage-status comments (#962)

**Feature**: Add a body-driven content guard to `findClarificationComment` so it skips `<!-- generacy-stage:{planning,specification,implementation}` (and legacy `speckit-stage:*`) status tables that fall in the at-or-after window, keeps scanning for a legitimate clarification batch, and returns `null` when only stage-status candidates remain. Pin the behaviour with three regression tests (FR-006/FR-007/FR-008) so the finder is no longer indirectly dependent on the upstream #958 fix.
**Branch**: `962-follow-up-from-960`
**Status**: Complete

## Summary

`findClarificationComment` (`packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts`) selects the clarification batch **purely by timing**: it walks the timeline for the most-recent `waiting-for:clarification` label event and returns the first comment whose `createdAt >= labelTs`. There is no content check on the returned comment. #960's symptom (a `<!-- generacy-stage:planning -->` status table being returned as the clarification batch) is only latent today because #958 stopped the engine from self-answering and auto-advancing to `plan` inside the at-or-after window. Any future path that posts a non-clarification comment at-or-after the label event resurfaces the same bug.

This spec adds a **positive-allow-list content guard** so the finder is correct by construction:

1. **Reject** any candidate whose body carries, at column 0 of some line, one of six stage-status prefixes: `<!-- generacy-stage:planning`, `<!-- generacy-stage:specification`, `<!-- generacy-stage:implementation`, or their `<!-- speckit-stage:*` legacy twins.
2. **Override the reject** when the same body also carries, at column 0 of some line, either `<!-- generacy-stage:clarification` or `<!-- generacy-stage:clarification-batch-N`. Mixed-body → accept.
3. On a rejected candidate, **keep scanning** the remaining at-or-after candidates in `createdAt` order (FR-005: prefer the earliest survivor, not the earliest overall).
4. When every at-or-after candidate is rejected, return `null` — the same distinguishable-absent the finder already returns when no timeline label event exists or no at-or-after comment exists.

The two clarifications (see `clarifications.md`) already fixed the two design axes: **hardcode** the small reject/override lists inside the finder — do not import from `packages/orchestrator/src/worker/clarification-markers.ts` (Q1/B, preserves SC-003); and the guard is **body-driven only**, no `getCurrentUser()` / author lookup (Q2/A, preserves the finder's zero-network-identity invariant).

Three focused regression tests (FR-006/FR-007/FR-008) pin the behaviour. FR-006 (the AC-2 case from parent issue #960) MUST be red before the finder change and green after; that is the load-bearing regression proof.

## Technical Context

- **Language**: TypeScript (strict), ESM, Node ≥22.
- **Package touched**: `@generacy-ai/generacy` only (one production file + one test file). No cross-package imports added.
- **Runtime dependencies**: none new. `IssueComment` already exposes `body` (`{ body, author, createdAt, url }`).
- **Existing constraints observed**:
  - Column-0 match rule (`packages/orchestrator/src/worker/clarification-markers.ts`) — the finder's guard mirrors this exact rule inline (line-anchored, case-sensitive ASCII prefix substring, `> `-quoted lines never match). No import of the helper.
  - SC-003: 0 files changed outside the finder and its test file (plus the mandatory changeset).
- **Changeset**: `.changeset/962-*.md` — `patch` on `@generacy-ai/generacy`. This is a defect fix (`workflow:speckit-bugfix`-style); no new public capability, no new export.

## Project Structure

Changes localize to a single package. One production file modified, one test file extended, one changeset added.

```
packages/generacy/src/cli/commands/cockpit/
├── clarification-comment-finder.ts                        [MODIFY]
│   - Add module-scope const STAGE_STATUS_REJECT_PREFIXES: readonly string[] = [
│       '<!-- generacy-stage:planning',
│       '<!-- generacy-stage:specification',
│       '<!-- generacy-stage:implementation',
│       '<!-- speckit-stage:planning',
│       '<!-- speckit-stage:specification',
│       '<!-- speckit-stage:implementation',
│     ] as const  (FR-002)
│   - Add module-scope const CLARIFICATION_STAGE_OVERRIDE_PREFIXES: readonly string[] = [
│       '<!-- generacy-stage:clarification',
│       '<!-- generacy-stage:clarification-batch-',
│     ] as const  (FR-003)
│     Note the trailing hyphen on `clarification-batch-` — the prefix
│     matches `clarification-batch-1`, `clarification-batch-12`, etc.
│     `<!-- generacy-stage:clarification -->` is already covered by the
│     first entry (`<!-- generacy-stage:clarification` with no trailing
│     hyphen), so the two-entry list covers both spec-named variants.
│   - Add private function isStageStatusComment(body: string): boolean
│       Iterate body.split('\n'):
│         if line startsWith any CLARIFICATION_STAGE_OVERRIDE_PREFIXES → return false
│           (override-wins: presence anywhere in the body vetoes the reject)
│       Iterate body.split('\n'):
│         if line startsWith any STAGE_STATUS_REJECT_PREFIXES → return true
│       return false
│     Two passes because the override MUST short-circuit even if the reject
│     marker appears earlier in the body. Both passes are O(body-lines * 6);
│     comments are small, this is not hot code.
│   - In the existing `for (const c of sorted)` loop (currently returns the
│     first at-or-after `c`): after the timestamp check, add
│       if (isStageStatusComment(c.body)) continue;
│     before `return c;`. Loop naturally falls through to `return null` when
│     every candidate is rejected (FR-004). FR-005 is satisfied for free —
│     `sorted` is already `createdAt`-ascending, and the loop returns the
│     first survivor.
│   - No signature change. No new exports. No import additions.
│
├── __tests__/
│   └── clarification-comment-finder.test.ts               [MODIFY]
│       - Preserve existing 4 tests unchanged.
│       - Add FR-006 regression: only at-or-after candidate is a
│         `<!-- generacy-stage:planning -->` table → finder returns null.
│         MUST be red before the finder change (proves regression coverage).
│       - Add FR-007: at-or-after candidate carries
│         `<!-- generacy-stage:clarification-batch-1 -->` → finder returns
│         that comment. Guards against a naïve `startsWith('<!-- generacy-stage:')`.
│       - Add FR-008: two at-or-after candidates — first is a stage-status
│         table, second is a real clarification batch (createdAt-ordered) →
│         finder returns the second. Documents "skip and keep scanning".
│       - Add FR-002 speckit-legacy coverage: candidate body starts with
│         `<!-- speckit-stage:implementation -->` → finder skips it. One
│         case is enough — the reject list is a flat 6-entry allow-list;
│         one legacy case + one modern case is sufficient parity coverage.
│       - Add FR-003 mixed-body coverage: candidate body has BOTH
│         `<!-- generacy-stage:planning -->` (line 1) AND
│         `<!-- generacy-stage:clarification-batch-2 -->` (line 3) → finder
│         returns the comment (override wins). Locks in the Q1/B decision.
│       - Add quoted-marker safety: candidate body has `> <!-- generacy-stage:planning -->`
│         (leading `> ` quote) → finder returns the comment. Confirms
│         column-0 rule holds inline in the guard.

.changeset/
└── 962-clarification-finder-content-guard.md              [ADD]
    - `patch` bump on `@generacy-ai/generacy`
    - One-line summary: defensive content guard on findClarificationComment
      so stage-status tables never surface as the clarification batch.

specs/962-follow-up-from-960/
├── spec.md                                                [read-only]
├── clarifications.md                                      [read-only]
├── plan.md                                                [THIS FILE]
├── research.md                                            [ADD]
├── data-model.md                                          [ADD]
├── quickstart.md                                          [ADD]
└── contracts/
    └── content-guard.md                                   [ADD]
```

**Files NOT changing (SC-003):**

- `packages/orchestrator/src/worker/clarification-markers.ts` — Q1/B: hardcode the reject/override lists inside the finder; no import.
- `packages/orchestrator/src/worker/types.ts` (`STAGE_MARKERS`) — not imported by the finder. The literal prefixes in the finder are duplicated from the same source of truth; the pair is guarded by tests (FR-006 uses the exact `<!-- generacy-stage:planning -->` string; a drift in either place fails the test).
- `packages/orchestrator/src/worker/clarification-poster.ts` — spec §Out of Scope.
- Any label-timing branch of the finder (timeline walk, latest-label selection, `createdAt >= labelTs` gate) — spec §Out of Scope, unchanged.
- Cockpit MCP tools, `cockpit_context` verb code — the finder's contract widens only in the reject direction; existing callers see the same `IssueComment | null` return shape.

## Design invariants

1. **The guard is a positive allow-list, not a wildcard.** Rejecting a fixed set of 6 stage-status prefixes (not `<!-- generacy-stage:*`) is the whole point of FR-002 — a `<!-- generacy-stage:review` marker introduced tomorrow does NOT auto-reject; the reject list must be explicitly extended. This is what makes FR-003's override rule small (two entries) instead of a general negative-lookahead.
2. **Body-driven, author-agnostic.** No `getCurrentUser()` lookup, no `author` field consulted (Q2/A). The finder does no network identity lookup today and MUST NOT gain one. The rare false-positive (a human deliberately opening a comment with a `<!-- generacy-stage:planning` marker line) is treated as a rejected candidate — they are speaking the engine's marker vocabulary and skipping is arguably correct.
3. **Override-wins on mixed body.** A single candidate carrying BOTH an FR-002 reject marker AND an FR-003 override marker at column 0 is ACCEPTED (Q1/B). Implementation orders the two passes with override-first so the override short-circuits before the reject fires.
4. **Column-0 rule mirrors `commentCarriesQuestionMarker`.** `line.startsWith(prefix)` on `body.split('\n')` — quoted (`> `-prefixed) lines never trigger the guard, in either direction. A human quoting a stage table while writing a real answer still has their comment returned.
5. **Skip-and-keep-scanning, not skip-and-return-null.** FR-005 preserves the "first qualifying comment" contract by advancing the loop past rejects. Only when the loop exhausts does the finder return `null` (FR-004). The reject-then-fall-through pattern is what makes FR-008 correct.
6. **SC-003 by construction.** Hardcoding the reject/override lists inside the finder — instead of importing from `clarification-markers.ts` — means the PR diff shows exactly two source files changed: the finder and its test file. The changeset is the third file per repo policy.

## Constitution check

No `.specify/memory/constitution.md` in this repo. Cross-referenced against the codebase conventions in `CLAUDE.md`:

- ✅ Changeset required on any non-test change under `packages/*/src/` — planned (`.changeset/962-clarification-finder-content-guard.md`, `patch` on `@generacy-ai/generacy`).
- ✅ Defect fix → `patch` bump. No new public capability, no new export, no new callable added. The finder's `(gh, repo, number) => Promise<IssueComment | null>` signature is unchanged.
- ✅ Fail-closed defaults over fail-open. When the guard is uncertain (a genuine clarification batch that also happens to carry a stage-status marker at column 0), the override rule ensures the accept side wins — the finder does not spuriously return `null` on a legitimate batch just because a marker appears elsewhere in the body.
- ✅ No comment placeholders / feature flags / backwards-compat shims. The guard is a straight-line addition; no dark-launch, no config toggle.
- ✅ Single-source-of-truth policy is deliberately relaxed for SC-003. The stage-status prefix literals are duplicated between the finder's hardcoded list and `packages/orchestrator/src/worker/types.ts`'s `STAGE_MARKERS`. Rationale is on file (Q1/B): importing from orchestrator would drag the finder into a cross-package dependency it does not otherwise have, and the paired regression test (FR-006 uses the literal string) makes drift immediately visible. Any future stage marker addition MUST update both places explicitly.

## Phasing

Single PR. The change is:

- one source-file diff (~40 LOC across constants + helper + one `continue` inside an existing loop),
- five new test cases in an existing test file,
- one changeset markdown.

There are no dependent land-order concerns — the finder is the sole caller path this spec touches, and its callers (`cockpit_context` MCP tool + related cockpit verbs) receive a strictly-narrower return set (fewer false-positive stage-status comments). No feature flag, no migration.

## Next step

Run `/speckit:tasks` to break the plan into an ordered task list with dependency markers.
