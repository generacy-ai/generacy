# Research: Cockpit epic-body parser accepts titled task-list refs

**Feature**: `826-found-during-cockpit-v1` | **Date**: 2026-07-07

## Decision 1 — Fix the caller, not the ref-shape regexes

**Decision**: Extract the first whitespace-delimited token from the checkbox remainder and pass only that token to `parseRef`. Leave every regex in `ref-shapes.ts` exactly as-is (still `^…$`-anchored).

**Rationale**:
- The four accepted shapes are all *whitespace-free tokens* by design — `owner/repo#N`, `[owner/repo#N](url)`, `[#N](url)`, `https://…`. First-token extraction (`refText.split(/\s+/)[0]`) yields the exact input the regexes were written for.
- The regexes are also used by direct-import consumers via `parseRef` (see `ref-shapes.test.ts`). Loosening them would change the shape contract for every caller, not just the epic-body path.
- The bug is one wrong argument at one call site (`parse-epic-body.ts:71-73`). Fixing that is a smaller, more localised change than a regex rewrite.

**Alternatives considered**:
- **Loosen the regexes in `ref-shapes.ts` to tolerate a trailing title.** Rejected: changes the meaning of `parseRef` for every caller; the "shape" the regexes model is a *token*, not a *line*. Would require every existing test in `ref-shapes.test.ts` to be re-audited for "shape means line now" semantics.
- **Pre-strip everything after the first `—` / `-` / `:` in the caller.** Rejected: delimiter-parsing in the caller re-introduces the same "one more delimiter shape and we're broken again" fragility that motivated leaving delimiters unparsed. Whitespace is a universal boundary in ref shapes — the first `\s+` is safe.

**References**: FR-001, FR-002, FR-003, FR-004; spec §Root cause bullet 1.

---

## Decision 2 — Warning marker substrings vs pinned strings vs structured warnings

**Decision**: Each rejection family carries a documented marker substring. Tests assert via `toContain()` on the family marker. The `warnings: string[]` public contract is unchanged.

**Families and their markers**:
- Bare `#N` shorthand → warning contains `bare '#N'`.
- Titled line whose first token is ref-shaped but does not match any accepted shape → warning contains `titled but not ref-shaped`.
- URL whose path does not match `/(issues|pull)/N` → warning contains `URL path not /(issues|pull)/N`.

**Rationale**:
- Pinning exact strings (Q1→A) makes every wording improvement a spec change and every operator-facing message tweak an approval loop.
- Marker substrings give tests something stable to assert without pinning full wording — same drift-avoidance rule the doc side of the ecosystem already uses (`tetrad-development#90` Q1: content requirements + illustrative example, wording lives with the code).
- Structured warnings (Q1→C — `{ code, line, text }`) are the better long-term shape but change the public `warnings: string[]` contract and every consumer. A bug fix should not smuggle in a contract change. File separately if operator tooling ever needs codes.

**Alternatives considered**:
- **Pin exact strings** (Q1→A). Rejected as above.
- **Structured warnings** (Q1→C). Rejected as above; suitable for a follow-up.

**References**: clarification Q1 → B; FR-005, SC-003.

---

## Decision 3 — Silently ignore additional ref-shaped tokens inside the title

**Decision**: When the first token of a checkbox line is a ref, additional ref-shaped tokens in the title are silently ignored. No warning, no attempt to resolve extra refs.

**Rationale**:
- The contract is "everything after the first whitespace run is title, not parsed." Cross-references in titles are legitimate house style — `- [ ] owner/repo#1 — depends on owner/repo#2` is normal English prose.
- Warning on legitimate house-style writing trains operators to ignore warnings, which kills the signal the warnings exist to carry.
- An accidentally-hidden second ref (e.g. typo `- [ ] owner/repo#1 owner/repo#2`) is immediately visible as a child missing from status output — a loud, diagnosable absence.
- Warning on it (Q2→B) would produce false positives for every legitimate cross-referenced title, i.e. most real epics.
- Treating the whole line as multi-ref (Q2→C) breaks the "first significant token is the ref" contract outright.

**Alternatives considered**:
- **Warn but do not add extra refs** (Q2→B). Rejected as above.
- **Multi-ref per line** (Q2→C). Rejected as above.

**References**: clarification Q2 → A; FR-008.

---

## Decision 4 — Verbatim `.md` snapshot fixtures AND inline shape-coverage excerpt

**Decision**: Both. Check in two verbatim `.md` fixtures at `packages/cockpit/src/resolver/__tests__/fixtures/epic-826-sniplink.md` and `epic-826-tetrad-88.md`, imported via `readFileSync`, AND write one inline excerpt in `parse-epic-body.test.ts` covering one phase heading × every accepted ref shape × both delimiter styles (em-dash and ASCII hyphen). Fixtures are frozen at PR time — historical evidence, not live mirrors.

**Rationale**:
- Verbatim snapshots (Q3→A) prove the exact real-world bodies that triggered the bug. They're the strongest regression guard.
- Inline excerpts (Q3→B) prove *shape coverage* readably — one phase, every accepted form, both delimiter styles — in the file a reader is already reading when they look at parser behavior.
- Both together match the two purposes: shape coverage lives with the shape assertions; production-case coverage lives as literal markdown a reviewer can diff.
- Frozen-at-PR is correct — regression fixtures are historical evidence of the bug, not live mirrors of the epics (which move on with the project).
- The same failure mode as `#800` was "tests codified the shipped bug instead of the documented contract." Belt-and-braces fixtures prevent recurrence.

**Alternatives considered**:
- **Verbatim only** (Q3→A). Rejected: hides shape coverage inside a wall of markdown; harder to diff mentally against `ref-shapes.ts`.
- **Excerpts only** (Q3→B). Rejected: does not prove the specific production cases; risks drift from the real body when the excerpt author simplifies.

**References**: clarification Q3 → C; FR-006, SC-001.

---

## Decision 5 — Manual `gh` revert of the interim workaround, not a code change

**Decision**: The revert of the title-stripped test epic is documented as a manual `gh issue edit` step in the PR description. No code change in this repo.

**Rationale**:
- The affected epic body lives on a GitHub issue in a *different repo* (`tetrad-development#88`). Nothing in this repo represents it, so there is nothing to revert here as code (Q4→B is not physically possible).
- A whole tracking issue for a one-minute `gh` edit (Q4→A) is process overhead.
- The smoke-test results note on `generacy-ai/tetrad-development#88` will record the revert either way; restoring the titled house-style lines doubles as the fix's live post-merge verification.

**Alternatives considered**:
- **Follow-up tracking issue** (Q4→A). Rejected as above.
- **In-scope code change** (Q4→B). Physically impossible; the target isn't in this repo.

**References**: clarification Q4 → C; spec §Out of Scope.

---

## Decision 6 — `REF_SHAPED_RE` runs against the first token, not the whole line

**Decision**: After first-token extraction, the "was this line trying to be a ref?" test (`REF_SHAPED_RE`) runs against the first token only. Prose checkbox lines that mention a ref elsewhere never warn.

**Rationale**:
- The warning exists to catch "author tried to write a ref and got the shape wrong." That intent lives in the first-token position by contract (Decision 1).
- A prose checkbox line like `- [ ] Do X, see owner/repo#5` is not a failed child ref — it is task-tracking prose that happens to mention an issue for context. Warning on it would be spurious.
- Preserving today's behavior (test against whole line — Q5→B) contradicts SC-002 ("0 warnings against titled house-style lines") — the smoke test that triggered #826 would still warn.
- Testing first token AND emitting a lower-severity warning for later refs (Q5→C) is a subset of Q2→B and rejected for the same reason.

**Alternatives considered**:
- **Test whole line** (Q5→B). Rejected as above.
- **Test first token AND warn on later refs** (Q5→C). Rejected as above.

**References**: clarification Q5 → A; FR-007, SC-004.

---

## Implementation patterns to follow

- **Whitespace tokenisation**: `refText.split(/\s+/)[0]!`. `refText` is already `.trim()`-ed by the existing code, so the first split element is never `''`. `[0]!` non-null assert is safe because `split` on any non-empty string returns at least one element; if `refText` were empty the outer `TASK_LIST_RE` would not have matched.
- **Warning branch shape**: keep the existing `warnings.push(\`cockpit: ignored ref-shaped task-list line ${lineNumber}: '${refText}' (…)\`)` outer shape — only the parenthesised reason changes per family. Preserves line number and full offending text for grepping (FR-005).
- **Family classification** — read `refText` (not just the first token) to decide the family:
  - If the first token matches `^#\d+$` (bare-`#N`) → family: bare-`#N`.
  - Else if the first token matches `^https?://` → family: URL-with-wrong-path.
  - Else if the first token is ref-shaped per `REF_SHAPED_RE` AND `refText` has whitespace (i.e. the caller passed a titled line) → family: titled-but-not-ref-shaped.
  - Else → same fallback wording as titled-but-not-ref-shaped, or fall through without warning (Q5→A boundary — first-token-not-ref-shaped is silent).
- **`REF_SHAPED_RE` on first token only**: the existing regex has `(?:^|[\s(])` alternation; keep it, but call `REF_SHAPED_RE.test(firstToken)` — the leading `\s(` alternative is now redundant for the first-token case but preserving the regex avoids collateral. A follow-up may simplify.
- **`readFileSync` for snapshots**: import via `import { readFileSync } from 'node:fs'; import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path';` and compute paths against `import.meta.url` — same pattern other tests in the monorepo use for fixture loading.

## Key references

- `packages/cockpit/src/resolver/parse-epic-body.ts:71-73` — the two-line bug locus (wrong input to `parseRef`).
- `packages/cockpit/src/resolver/parse-epic-body.ts:75-78` — the hardcoded warning.
- `packages/cockpit/src/resolver/ref-shapes.ts:5-12` — the four `^…$`-anchored shape regexes that assume a whitespace-free token.
- `docs/label-protocol.md` § Epic body format — the documented contract the parser was drifting from.
- `#800` — prior instance of "tests codified the shipped bug instead of the documented contract." Motivates FR-006 (belt-and-braces regression fixtures).
- `tetrad-development#88` — cockpit v1 smoke test; finding #4 is the shipping instance of #826. Restoring house-style lines on that epic is the manual post-merge verification (Decision 5).
