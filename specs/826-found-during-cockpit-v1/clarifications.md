# Clarifications: Cockpit epic-body parser accepts titled task-list refs

**Issue**: [#826](https://github.com/generacy-ai/generacy/issues/826)
**Branch**: `826-found-during-cockpit-v1`

## Batch 1 — 2026-07-07

### Q1: Warning taxonomy — exact strings vs shape families
**Context**: FR-005 and SC-003 require distinct warning strings for at least (a) bare-`#N`, (b) failed-shape-with-title, (c) failed-URL. But the spec does not fix the exact wording. Two implementers would produce different strings, so unit assertions in SC-003 need a reference wording — or an explicit "any string that unambiguously identifies the family" rule.
**Question**: Should the spec pin exact warning strings for each rejection family, or is "distinguishable substring per family (e.g., contains `bare '#N'`, contains `titled but not ref-shaped`, contains `URL path not /(issues|pull)/N`) — asserted via `toContain()` in tests" acceptable?
**Options**:
- A: Pin exact strings (spec lists the three canonical warning messages verbatim; tests assert equality).
- B: Distinguishable-substring rule only — each family carries a documented marker substring, tests use `toContain()`.
- C: Structured warning object — replace the string with `{ code: 'BARE_HASH_N' | 'TITLED_BAD_SHAPE' | 'BAD_URL_PATH', line, text }` and adjust the `warnings: string[]` field shape.

**Answer**: *Pending*

### Q2: Additional ref-shaped tokens inside the title
**Context**: With first-token extraction, `- [ ] owner/repo#1 — depends on owner/repo#2` cleanly resolves as `owner/repo#1` and leaves the rest as unparsed title. But it is now silently possible to hide additional refs (or a typo like `- [ ] owner/repo#1 owner/repo#2`) inside the title. FR-001 says "everything after the first whitespace run is treated as free-form title and not parsed" — that answers most cases, but SC-002's "0 warnings against titled house-style lines" may want an exception for accidental double-refs.
**Question**: When the title portion of a task-list line contains additional ref-shaped tokens (bare `owner/repo#N`, `#N`, or GitHub URLs), what should the parser do?
**Options**:
- A: Silently ignore. Only the first token is a ref; the rest is prose by definition. No warning.
- B: Warn (but do not add extra refs). Emit a `cockpit: task-list line N has additional ref-shaped tokens in title` warning; still take only the first token.
- C: Add every ref-shaped token from the line to the phase. Treat the line as multi-ref. (Breaks "first significant token" contract.)

**Answer**: *Pending*

### Q3: Regression-fixture strategy for the two real-world epics
**Context**: FR-006 requires regression fixtures for "the exact `christrudelpw/sniplink#1` and `tetrad-development#85` epic body patterns". "Exact" is ambiguous — verbatim (bodies embedded as multi-KB template literals or checked-in `.md` fixtures) or "representative excerpts of the shape". Verbatim gives strong regression protection but ages with the live epic; excerpts stay small but risk drift from the real body.
**Question**: How should the two real-world epic-body regressions be fixtured?
**Options**:
- A: Verbatim snapshots — check in `packages/cockpit/src/resolver/__tests__/fixtures/epic-826-sniplink.md` and `epic-826-tetrad-88.md`, imported via `readFileSync`. Frozen at time of PR; not re-synced with the live issues.
- B: Representative excerpts inline in the `.test.ts` — one phase heading + 4-6 task lines per epic, in every accepted ref shape, matching the delimiter styles observed.
- C: Both — a small inline fixture proves the shapes; a verbatim `.md` fixture proves the specific real-world cases.

**Answer**: *Pending*

### Q4: Fate of the interim workaround on the test epic
**Context**: The spec's Summary says the interim workaround (stripping titles from checkbox lines) was applied on the test epic to unblock the cockpit v1 smoke test. Once this fix ships, that workaround is no longer needed, but the spec does not say who reverts it or when. If revert is part of this PR, it becomes a cross-repo change (the test epic lives outside this repo).
**Question**: Does this PR need to revert the interim workaround on the test epic, or is revert out of scope?
**Options**:
- A: Out of scope. This PR fixes the parser + tests only; the test epic is restored to house style in a follow-up (tracked in a new issue).
- B: In scope, this PR only. The revert lives with the parser fix so the smoke test re-runs green on merge.
- C: In scope, but as a documented manual step in the PR description (no code change here since the epic body lives on a GitHub issue, not in the repo).

**Answer**: *Pending*

### Q5: Behavior when the first token is not ref-shaped at all
**Context**: With first-token extraction, `- [ ] Some free-form prose` yields first token `Some`, which is not ref-shaped and not a URL. Today, `REF_SHAPED_RE` is tested against the whole `refText`, so a line like `- [ ] Do X, see owner/repo#5` currently warns (ref-shaped anywhere on the line). After the fix, the "ref-shaped" check should arguably run against the first token only — otherwise prose lines that happen to mention a ref would generate spurious warnings.
**Question**: After first-token extraction, what should `REF_SHAPED_RE` be tested against for the warning-emission decision?
**Options**:
- A: Test the first token only. Prose lines that happen to mention a ref elsewhere never warn. (Aligns with "first significant token is the ref" contract.)
- B: Test the whole `refText`. Preserves today's warning behavior for lines that mention a ref anywhere.
- C: Test the first token AND emit a separate low-severity warning when a non-first-token ref appears (subset of Q2 option B).

**Answer**: *Pending*
