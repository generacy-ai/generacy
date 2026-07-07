# Implementation Plan: Cockpit epic-body parser accepts titled task-list refs

**Feature**: Fix `packages/cockpit/src/resolver/parse-epic-body.ts` so `- [ ] owner/repo#N — title` (and every other accepted ref shape with a trailing title) resolves under the correct phase, and so the rejection warning describes what was actually seen instead of hardcoding "bare '#N' shorthand".
**Branch**: `826-found-during-cockpit-v1`
**Status**: Complete
**Date**: 2026-07-07
**Spec**: [spec.md](./spec.md)
**Input**: Feature specification at `/specs/826-found-during-cockpit-v1/spec.md`

## Summary

Two-line surgical change in a single file, plus regression fixtures. The parser today passes the entire checkbox remainder (`refText`) to `parseRef`, but every accepted shape in `ref-shapes.ts` is `^…$`-anchored, so any line with a trailing title fails all four shapes and returns `null`. The fix extracts the first whitespace-delimited token from the remainder and passes only that token to `parseRef`; the delimiter and title are consumed unparsed. The warning branch is rewritten to describe the actual failure family (bare-`#N`, titled-but-not-ref-shaped, URL-with-wrong-path) via documented marker substrings so tests can assert via `toContain()` without pinning full wording.

`ref-shapes.ts` is untouched — its four regexes already model the accepted set correctly; the bug was entirely in what was fed to it. `resolve.ts`, `heading-match.ts`, `errors.ts`, and `types.ts` are also untouched. `docs/label-protocol.md` is already correct (§ Epic body format documents "the ref is only the first significant token, everything after is a free-form title") — the parser was out of conformance.

Test surface: extend `parse-epic-body.test.ts` with (a) an inline excerpt covering one phase heading with every accepted ref shape × both delimiter styles (em-dash and ASCII hyphen), (b) two verbatim `.md` snapshots at `packages/cockpit/src/resolver/__tests__/fixtures/epic-826-sniplink.md` and `packages/cockpit/src/resolver/__tests__/fixtures/epic-826-tetrad-88.md`, and (c) unit assertions on the three warning-family marker substrings (`bare '#N'`, `titled but not ref-shaped`, `URL path not /(issues|pull)/N`). Fixtures are frozen at PR time — historical evidence, not live mirrors.

Zero CLI changes, zero API changes, zero plugin changes. The public `parseEpicBody(body): { phases, allRefs, warnings }` shape is preserved (Q1→B).

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js >=22 (matches `packages/cockpit` `engines.node`). Compiles to ESM under `dist/`.
**Primary Dependencies**: `vitest` (existing test runner). No new runtime deps. No new dev deps.
**Storage**: None. `parseEpicBody` is a pure function — no I/O, no async, no throws.
**Testing**: `vitest` in `packages/cockpit/src/resolver/__tests__/`. Extension points: `parse-epic-body.test.ts` (unit + inline integration fixture) and a NEW `fixtures/` subdirectory with two verbatim `.md` snapshots imported via `readFileSync`.
**Target Platform**: Any environment where the `@generacy-ai/cockpit` package runs — dev laptop, cluster orchestrator container, CI runner. `parseEpicBody` is a synchronous pure function, so no platform-specific behavior.
**Project Type**: Single-package edit. One source file modified (`parse-epic-body.ts`); one test file extended (`parse-epic-body.test.ts`); one new fixtures subdirectory with two `.md` files.
**Performance Goals**:
- No perf-relevant paths. First-token extraction is a single `split(/\s+/)[0]` per checkbox line; the input is already being iterated per-line.
- Time complexity unchanged: still O(lines × ref-shape-count) in the worst case.
**Constraints**:
- **Contract-preserving fix.** `parseEpicBody` return shape unchanged (`{ phases, allRefs, warnings: string[] }`) — no structured warnings, no new fields (Q1→B; Out-of-Scope).
- **`ref-shapes.ts` not touched.** The four accepted shapes remain exactly as documented. Only the *input* fed to `parseRef` changes (FR-004).
- **Backwards-compatible.** Title-less checkbox lines (`- [ ] owner/repo#N`) continue to parse for all four shapes (FR-003).
- **Silence in the title portion.** Additional ref-shaped tokens after the first token are silently ignored — no warning, no attempt to resolve extra refs (FR-008, Q2→A).
- **First-token-only ref-shape test.** The warning-emission decision runs `REF_SHAPED_RE` against the first token only, not the whole line — prose checkbox lines that mention a ref mid-sentence never warn (FR-007, Q5→A).
- **Warning marker substrings documented in code.** Each rejection family carries a documented marker (`bare '#N'`, `titled but not ref-shaped`, `URL path not /(issues|pull)/N`) so tests can assert via `toContain()` (FR-005, Q1→B).
- **Interim workaround revert is documented, not committed.** The test epic body lives on a GitHub issue in a different repo; the revert is a manual `gh` step called out in the PR description and doubles as live post-merge verification (Q4→C).
**Scale/Scope**: 1 source file edited (~15 net LOC), 1 test file extended (~80 net LOC including inline fixture + snapshot loaders), 2 new `.md` fixture files (verbatim; ~100 lines each depending on real body sizes).

## Constitution Check

No `.specify/memory/constitution.md` present in this repo. No gates to evaluate. Constitution check **PASS** (vacuously).

## Project Structure

### Documentation (this feature)

```text
specs/826-found-during-cockpit-v1/
├── spec.md                                          # already authored (Draft)
├── clarifications.md                                # already authored (Batch 1, Q1–Q5)
├── plan.md                                          # THIS FILE
├── research.md                                      # decision rationale (Q1–Q5)
├── data-model.md                                    # interface deltas + rejection-family taxonomy
├── quickstart.md                                    # local repro / validation
└── contracts/
    └── parser-behavior.md                           # documented parser behavior post-fix (grammar, warning families)
```

`tasks.md` is produced by `/speckit:tasks`, not this command.

### Source Code (cockpit package — repository monorepo)

```text
packages/cockpit/src/resolver/
├── parse-epic-body.ts                               # MODIFIED — extract first token from refText; pass only that token to parseRef; rewrite warning branch to describe the actual failure family via marker substrings; keep REF_SHAPED_RE test against the first token only
├── ref-shapes.ts                                    # UNTOUCHED — four accepted shapes remain exactly as documented; only what's fed to parseRef changes
├── resolve.ts                                       # UNTOUCHED
├── heading-match.ts                                 # UNTOUCHED
├── errors.ts                                        # UNTOUCHED
├── types.ts                                         # UNTOUCHED — { phases, allRefs, warnings: string[] } shape preserved
└── __tests__/
    ├── parse-epic-body.test.ts                      # MODIFIED — (a) inline integration excerpt: one phase × all 4 ref shapes × both delimiter styles (em-dash + ASCII hyphen + colon + whitespace-only); (b) snapshot loaders that readFileSync the two .md fixtures and assert full ref lists per phase; (c) three warning-family assertions using toContain() on marker substrings; (d) prose-line-with-late-ref assertion (empty warnings); (e) first-token-is-ref + additional-refs-in-title assertion (silent, one ref)
    ├── ref-shapes.test.ts                           # UNTOUCHED — regexes unchanged
    ├── heading-match.test.ts                        # UNTOUCHED
    ├── resolve.test.ts                              # UNTOUCHED
    └── fixtures/                                    # NEW SUBDIRECTORY
        ├── epic-826-sniplink.md                     # NEW — verbatim body of christrudelpw/sniplink#1 (frozen at PR time)
        └── epic-826-tetrad-88.md                    # NEW — verbatim body of tetrad-development#85 (frozen at PR time; # per finding #4 in tetrad-development#88)
```

**Structure Decision**: Single-package, single-source-file edit. The fix is deliberately narrow — one function (`parseEpicBody`) inside one file. No new modules, no new exports, no new types. The `fixtures/` subdirectory is the only structural addition, and it exists solely under `__tests__/` (not shipped in the package's `dist/`).

**Why the change is contained to `parse-epic-body.ts`**: `ref-shapes.ts` is correct — its four regexes describe the accepted token set exactly. The bug is that the caller passes a whole line to a token-shaped API. Fixing the caller is a smaller, more testable change than loosening the regexes (which would break the shape contract other callers rely on — see Assumptions in the spec).

**Why the fixtures live in a subdirectory instead of inline template literals**: Q3→C. Verbatim `.md` files (a) survive multi-line preservation across YAML/TS interpolation gotchas, (b) are diffable in code review as literal markdown, and (c) frozen-at-PR is correct — they document the exact real-world bodies that triggered the bug. The inline excerpt in the `.test.ts` proves shape/delimiter coverage; the snapshots prove production cases.

**Why `warnings: string[]` is not changed to structured objects**: Q1→C would give operator tooling stable codes, but it changes the public contract of a shared library and every consumer (`packages/cockpit`'s CLI verbs, plugin renderers, any downstream code that reads warnings) would need to adapt. A bug fix should not smuggle in a contract change. Marker substrings (Q1→B) give tests something stable to assert without pinning full wording; a follow-up issue can migrate to `{ code, line, text }` later if operator tooling grows a use case.

**Why the interim workaround is not reverted as code**: Q4→C. The test epic (`tetrad-development#88`) is a GitHub issue body in a different repository. There is nothing to revert *in this repo*. The manual `gh issue edit` step is documented in the PR description and doubles as live post-merge verification — restoring the titled house-style lines proves the parser now handles them.

## Complexity Tracking

> No constitution violations. Table omitted.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _none_   | _n/a_      | _n/a_                                |
