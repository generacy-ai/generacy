# Feature Specification: Cockpit epic-body parser accepts titled task-list refs

**Branch**: `826-found-during-cockpit-v1` | **Date**: 2026-07-07 | **Status**: Draft
**Issue**: [#826](https://github.com/generacy-ai/generacy/issues/826) — Found during cockpit v1 integration smoke test ([tetrad-development#88](https://github.com/generacy-ai/tetrad-development/issues/88) finding #4)

## Summary

The cockpit epic-body parser (`packages/cockpit/src/resolver/parse-epic-body.ts`) rejects every task-list item that follows the house style used by real epics — `- [ ] owner/repo#N — title` — even though the documented contract (`docs/label-protocol.md § Epic body format`) says the ref is only the first significant token and everything after is a free-form title.

**Symptom** — a correctly-formatted epic body produces:

```
cockpit: ignored ref-shaped task-list line 28: 'christrudelpw/sniplink#2 — Scaffold Next.js + Tailwind app' (unrecognised shape — bare '#N' shorthand is not accepted)
...
cockpit status: cockpit: epic body has no task-list refs under any '### <phase>' heading.
```

**Root cause** (two independent bugs):

1. **Wrong input to `parseRef`** — `parse-epic-body.ts:71-73` passes the ENTIRE checkbox remainder (`ref + delimiter + title`) to `parseRef`, but every regex in `ref-shapes.ts` is `^…$`-anchored. Any line with a trailing title fails all four accepted shapes and returns `null`.
2. **Misleading warning text** — `parse-epic-body.ts:77` hardcodes `(unrecognised shape — bare '#N' shorthand is not accepted)` regardless of what was actually seen. When a fully-qualified `owner/repo#N — title` line is rejected, the operator is told it looks like bare-`#N` shorthand — actively unhelpful.

**Why tests didn't catch it** — the unit fixtures for `parse-epic-body.test.ts` must use title-less checkbox lines (`- [ ] owner/repo#N`), which parse fine. Same failure mode as #800: tests codified the shipped bug instead of the documented contract.

**Interim workaround** applied on the test epic: strip titles from checkbox lines. The real fix restores conformance to the documented contract.

## Clarifications

Resolved in [`clarifications.md`](./clarifications.md) — Batch 1, 2026-07-07:

- **Q1 — Warning taxonomy (B)**: Each rejection family carries a documented marker substring; tests assert via `toContain()`. `warnings: string[]` public contract unchanged. See FR-005, SC-003.
- **Q2 — Additional ref-shaped tokens in title (A)**: Silently ignore. Cross-references in titles are legitimate house style; warning would train operators to ignore warnings. Accidental hidden second refs surface as loud, diagnosable absence in status output. See FR-008.
- **Q3 — Regression-fixture strategy (C)**: Both — inline excerpt covers shape/delimiter coverage; verbatim `.md` snapshots prove the exact production cases. Frozen at PR time. See FR-006.
- **Q4 — Interim workaround revert (C)**: Out-of-scope for this PR as code; documented in the PR description as a manual `gh` post-merge step. The restored titled epic doubles as live verification. See Out of Scope.
- **Q5 — `REF_SHAPED_RE` scope after first-token extraction (A)**: Test the first token only. Prose lines that happen to mention a ref elsewhere never warn. See FR-007, SC-004.

## User Stories

### US1: Epic author writes house-style task lists and cockpit resolves them

**As an** epic author writing an epic body in the documented house style,
**I want** cockpit to recognise `- [ ] owner/repo#N — title` (and every other accepted ref shape) with a trailing title,
**So that** I do not have to strip titles from every checkbox line to get cockpit to see the refs.

**Acceptance Criteria**:
- [ ] The exact `christrudelpw/sniplink#1` epic body (as shipped in real-world use) resolves all refs under the correct phases.
- [ ] The `tetrad-development#85` epic body (`- [ ] owner/repo#N — title` with em-dash delimiter, the house style) resolves all refs.
- [ ] All four accepted ref shapes documented in `ref-shapes.ts` (bare, md-link-bare-label, md-link-hash-label, plain URL) parse correctly with a trailing title.
- [ ] Title-less checkbox lines continue to parse (backwards compatible with the interim workaround).

### US2: Operator sees an accurate warning for genuinely-unrecognised refs

**As an** operator debugging why a task-list line was ignored,
**I want** the warning to describe what the parser actually saw,
**So that** I can fix my epic body without being misled by a hardcoded reason that does not match the input.

**Acceptance Criteria**:
- [ ] A bare-`#N` line still gets a warning that identifies bare-`#N` as the problem.
- [ ] A titled but otherwise ref-shaped line that fails to parse gets a warning that describes the actual shape, not bare-`#N`.
- [ ] The warning always includes the offending text so operators can grep for it.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `parse-epic-body.ts` MUST extract the leading whitespace-delimited token from the checkbox remainder and pass only that token to `parseRef`; everything after the first whitespace run is treated as free-form title and not parsed. | P1 | All four accepted shapes are whitespace-free tokens, so first-token extraction (`refText.split(/\s+/)[0]`) is sufficient. |
| FR-002 | The parser MUST accept `- [ ] owner/repo#N — title` (em-dash), `- [ ] owner/repo#N - title` (ASCII hyphen), `- [ ] owner/repo#N: title`, and `- [ ] owner/repo#N   title` (whitespace-only delimiter). | P1 | Delimiter not parsed; whitespace + title consumed unparsed. |
| FR-003 | The parser MUST continue to accept title-less checkbox lines (`- [ ] owner/repo#N`) for all four ref shapes. | P1 | Backwards compatibility with existing epics and the interim workaround. |
| FR-004 | The parser MUST continue to reject bare-`#N` shorthand, non-positive `N`, and non-`/(issues\|pull)/N` URLs — matching the current `ref-shapes.ts` contract. | P1 | Only the "line has a title" failure mode changes. |
| FR-005 | When a task-list line is ref-shaped but rejected by `parseRef`, the warning text MUST describe the shape actually observed rather than hardcoding "bare '#N' shorthand". Each rejection family MUST carry a documented marker substring — `bare '#N'` for bare-`#N`, `titled but not ref-shaped` for the failed-shape-with-title case, and `URL path not /(issues\|pull)/N` for the failed-URL case — so tests can assert via `toContain()` without pinning full wording. | P1 | Fix `parse-epic-body.ts:77`. Warning still includes line number and offending text. `warnings: string[]` public contract unchanged (see clarify Q1). |
| FR-006 | Regression fixtures MUST use a hybrid strategy: (a) an inline excerpt in `parse-epic-body.test.ts` covering one phase heading with every accepted ref shape and both delimiter styles (em-dash and ASCII hyphen), AND (b) verbatim `.md` snapshots at `packages/cockpit/src/resolver/__tests__/fixtures/epic-826-sniplink.md` and `packages/cockpit/src/resolver/__tests__/fixtures/epic-826-tetrad-88.md` imported via `readFileSync`. Snapshots are frozen at time of PR — historical evidence of the bug, not live mirrors. | P1 | Prevents recurrence of the tests-codify-bug pattern from #800 (see clarify Q3). |
| FR-007 | When a task-list line's first whitespace-delimited token is not ref-shaped, the parser MUST NOT emit a warning even if a ref-shaped token appears later on the line (e.g. `- [ ] Do X, see owner/repo#5`). `REF_SHAPED_RE` is tested against the first token only. | P1 | Aligns with the "first significant token is the ref" contract (see clarify Q5). |
| FR-008 | When the first token IS a ref and additional ref-shaped tokens appear inside the title portion, the parser MUST silently take only the first token — no warning, no attempt to resolve extra refs. | P1 | Cross-references in titles are legitimate house style; warning on them trains operators to ignore warnings (see clarify Q2). |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Real-world epic bodies (`christrudelpw/sniplink#1`, `tetrad-development#85`) resolve their refs without warnings when passed to `parseEpicBody`. | 100% of refs resolved under the correct phase | New integration-shaped fixtures in `parse-epic-body.test.ts` assert full ref lists per phase. |
| SC-002 | Cockpit v1 integration smoke test (`tetrad-development#88`) no longer emits `cockpit: ignored ref-shaped task-list line …` warnings against a house-style epic. | 0 warnings against titled house-style lines | Re-run smoke test after fix ships. |
| SC-003 | Warning text for a genuinely-rejected line matches the actual failure mode. | Each rejection family carries its documented marker substring per FR-005: `bare '#N'`, `titled but not ref-shaped`, `URL path not /(issues\|pull)/N`. | Unit assertions use `toContain()` on the family marker substring — not equality on full wording. |
| SC-004 | Prose checkbox lines that mention a ref outside the first-token position do not warn. | 0 warnings against `- [ ] Do X, see owner/repo#5`-shaped lines. | Unit fixture with prose + trailing ref asserts empty `warnings` array (see FR-007). |

## Assumptions

- The four ref shapes enumerated in `ref-shapes.ts` are the complete accepted set. This bug fix does not add new shapes.
- The `TASK_LIST_RE` in `parse-epic-body.ts` (`/^\s*-\s*\[[ xX]\]\s+(.+?)\s*$/`) correctly captures the entire checkbox remainder — first-token extraction happens against `task[1]`.
- No consumer of `parseRef` outside `parse-epic-body.ts` expects it to accept a full line with a title; the fix is contained to `parse-epic-body.ts` and does not change `ref-shapes.ts` regexes.

## Out of Scope

- Adding new ref shapes (e.g. bare-`#N` with phase-scoped repo context, cross-org shortcuts).
- Changing the phase-heading grammar (`### <phase>`).
- Structured warning objects (`{ code, line, text }`) — deferred to a follow-up if operator tooling ever needs stable codes; keeps the public `warnings: string[]` contract unchanged in this bugfix (see clarify Q1).
- Reverting the interim workaround on the test epic (`tetrad-development#88`) as a code change — the epic body lives on a GitHub issue in a different repo. The revert is a documented manual `gh` edit called out in the PR description and doubles as live post-merge verification (see clarify Q4).
- Documentation edits to `docs/label-protocol.md` — the contract there is already correct; the parser is what's out of conformance.

---

*Generated by speckit*
