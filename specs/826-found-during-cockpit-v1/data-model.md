# Data Model: Cockpit epic-body parser accepts titled task-list refs

**Feature**: `826-found-during-cockpit-v1` | **Date**: 2026-07-07

This bug fix touches one function inside one file. It introduces no new persisted types and no wire-schema changes. The section below documents (a) the internal transformation of the checkbox remainder, (b) the rejection-family taxonomy carried in `warnings: string[]`, and (c) the fixture layout.

## Types touched

### `parseEpicBody` public return — `types.ts`

**Unchanged.** `ParsedEpicBody = { phases: ParsedPhase[]; allRefs: IssueRef[]; warnings: string[] }`. Q1→B rules out structured warnings. `ParsedPhase = { heading: string; token: string; refs: IssueRef[] }` is unchanged. `IssueRef = { repo: string; number: number }` is unchanged.

### `parseRef` public signature — `ref-shapes.ts:34`

**Unchanged.** Continues to accept a single `line: string` and return `IssueRef | null` per the documented "four accepted shapes as whitespace-free tokens" contract. The caller (`parseEpicBody`) now always feeds it a first-token slice, which is what the regexes were designed for.

### Internal caller change — `parse-epic-body.ts:71-73`

**Before**:
```ts
const task = TASK_LIST_RE.exec(line);
if (task == null) continue;
const refText = task[1]!.trim();

const ref = parseRef(refText);
if (ref == null) {
  if (REF_SHAPED_RE.test(refText)) {
    warnings.push(
      `cockpit: ignored ref-shaped task-list line ${lineNumber}: '${refText}' (unrecognised shape — bare '#N' shorthand is not accepted)`,
    );
  }
  continue;
}
```

**After** (illustrative — exact wording per Decision 2 marker-substring rule):
```ts
const task = TASK_LIST_RE.exec(line);
if (task == null) continue;
const refText = task[1]!.trim();
const firstToken = refText.split(/\s+/)[0]!;

const ref = parseRef(firstToken);
if (ref == null) {
  if (REF_SHAPED_RE.test(firstToken)) {
    const reason = classifyRejection(firstToken, refText);
    warnings.push(
      `cockpit: ignored ref-shaped task-list line ${lineNumber}: '${refText}' (${reason})`,
    );
  }
  continue;
}
```

Where `classifyRejection(firstToken, refText)` returns one of three strings, each containing its documented marker substring (see §Rejection-family taxonomy below).

## Rejection-family taxonomy

Each family carries a *marker substring* (documented in code near `classifyRejection`) that tests can assert on via `toContain()`. The full wording is free to evolve; the marker is stable.

| Family                        | Marker substring                          | Fires when                                                                             |
|-------------------------------|-------------------------------------------|----------------------------------------------------------------------------------------|
| Bare-`#N` shorthand           | `bare '#N'`                               | First token matches `^#\d+$` and `parseRef` returns null.                              |
| Titled-but-not-ref-shaped     | `titled but not ref-shaped`               | First token is ref-shaped per `REF_SHAPED_RE` but no `^…$`-anchored shape in `ref-shapes.ts` matches. Typical cause: `- [ ] owner/repo#N — title` failing because `refText` (not first-token) was passed pre-fix. Post-fix, this fires for genuinely malformed first tokens like `owner/repo#`. |
| URL-with-wrong-path           | `URL path not /(issues\|pull)/N`          | First token matches `^https?://` and `parseRef` returns null (e.g. `.../projects/1`, `.../commit/…`). |

**Note**: after the fix, most historical hits of "bare `#N` shorthand" warnings on real epics will actually be the "titled" family for lines like `- [ ] owner/repo#N — title`. The messaging drift is exactly what FR-005 fixes.

**First-token silence contract (FR-007, Q5→A)**: if the *first token* is not ref-shaped per `REF_SHAPED_RE`, no warning is emitted regardless of what appears later on the line. Concretely, `- [ ] Do X, see owner/repo#5` yields `firstToken = 'Do'`, `REF_SHAPED_RE.test('Do')` is `false`, and the warning branch does not fire. The `Do X, see …` text never surfaces as a "ref-shaped task-list line" warning.

**Title-portion silence contract (FR-008, Q2→A)**: if the *first token* IS a ref, the line resolves as that single ref. Additional ref-shaped tokens after the first whitespace run are silently ignored — no warning, no attempt to add them to the phase.

## First-token extraction rules

- **Split on `/\s+/`**. Every accepted ref shape is a whitespace-free token by design, so a single split is sufficient.
- **`refText` is already `.trim()`-ed** by the existing code (`task[1]!.trim()`), so `split(/\s+/)[0]` is never `''`.
- **`[0]!` non-null assert is safe**: `String.prototype.split` on any non-empty string returns at least one element. If `refText` were empty, the outer `TASK_LIST_RE` (`/^\s*-\s*\[[ xX]\]\s+(.+?)\s*$/`) would not have matched — the `(.+?)` capture is non-empty.

## Fixture layout

```text
packages/cockpit/src/resolver/__tests__/fixtures/
├── epic-826-sniplink.md         # verbatim body of christrudelpw/sniplink#1 at PR time
└── epic-826-tetrad-88.md        # verbatim body of tetrad-development#85 at PR time (finding #4 in tetrad-development#88)
```

**Frozen at PR time** — these are historical evidence of the bug, not live mirrors. Do not re-sync from the source issues after merge.

**Loading pattern in `parse-epic-body.test.ts`**:
```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNIPLINK_BODY = readFileSync(join(HERE, 'fixtures', 'epic-826-sniplink.md'), 'utf-8');
const TETRAD_88_BODY = readFileSync(join(HERE, 'fixtures', 'epic-826-tetrad-88.md'), 'utf-8');
```

Each snapshot has one integration-shaped assertion: `parseEpicBody(BODY).phases[k].refs` equals the ground-truth ref list for that phase, and `warnings` is empty.

**Assertion form for warnings (SC-003 marker substrings)**:
```ts
expect(warnings[0]).toContain("bare '#N'");                            // bare-#N line
expect(warnings[0]).toContain('titled but not ref-shaped');            // titled malformed line
expect(warnings[0]).toContain('URL path not /(issues|pull)/N');        // bad-URL line
```

## Validation / Invariants

- **Empty body** (`''`): unchanged behavior — `{ phases: [], allRefs: [], warnings: [] }`.
- **Line with title-less checkbox** (`- [ ] owner/repo#N`): `refText = 'owner/repo#N'`, `firstToken = 'owner/repo#N'`, `parseRef` returns the ref. Unchanged behavior (FR-003).
- **Line with em-dash title** (`- [ ] owner/repo#N — title`): `refText = 'owner/repo#N — title'`, `firstToken = 'owner/repo#N'`, `parseRef` returns the ref. New behavior (FR-002 core case).
- **Line with ASCII-hyphen title** (`- [ ] owner/repo#N - title`): same as em-dash (FR-002).
- **Line with colon title** (`- [ ] owner/repo#N: title`): `firstToken = 'owner/repo#N:'` — **note**: the trailing colon binds to the token. See §Edge cases.
- **Line with whitespace-only title** (`- [ ] owner/repo#N   title`): `firstToken = 'owner/repo#N'`, `parseRef` returns the ref (FR-002).
- **Line with markdown-link + title** (`- [ ] [owner/repo#N](url) — title`): `firstToken = '[owner/repo#N](url)'`, `parseRef` returns the ref (all four shapes work).
- **Prose line mentioning a ref** (`- [ ] Do X, see owner/repo#5`): `firstToken = 'Do'`, not ref-shaped, warning branch does not fire (FR-007, SC-004).
- **First token IS a ref, additional refs in title** (`- [ ] owner/repo#1 — depends on owner/repo#2`): `firstToken = 'owner/repo#1'`, ref resolves; the `owner/repo#2` in the title is silently ignored (FR-008).
- **Bare-`#N` line** (`- [ ] #8`): `firstToken = '#8'`, ref-shaped, `parseRef` returns null → warning fires with `bare '#N'` marker (FR-004, FR-005).
- **Bad-URL line** (`- [ ] https://github.com/owner/repo/commit/abc123`): `firstToken` is a URL, `parseRef` returns null → warning fires with `URL path not /(issues|pull)/N` marker (FR-005).
- **Non-positive N** (`- [ ] owner/repo#0`, `- [ ] owner/repo#-1`): `parseRef` returns null via `toRef`'s guard. Warning marker is titled-but-not-ref-shaped or a new `non-positive N` sub-family. **Decision**: reuse `titled but not ref-shaped` — the shape *is* ref-like; the value is invalid. Follow-up may split if operator tooling needs it.

### Edge cases

**Colon delimiter binds to the token**: `- [ ] owner/repo#5: description` yields `firstToken = 'owner/repo#5:'` (whitespace splits, colon does not). `parseRef` will reject `owner/repo#5:` because `BARE_RE`'s trailing `$` prohibits it. This warns as `titled but not ref-shaped`.

**Is this a bug?** No — per the spec's ambient contract and FR-002's non-parsed delimiters, the accepted delimiters are em-dash, ASCII hyphen, colon, whitespace-only. But the colon-with-no-space case is a discoverable failure — you'd hit it, get a clear "titled but not ref-shaped" warning, and add a space (`owner/repo#5 : description` or `owner/repo#5: description`). The 2nd form is the affected one — FR-002 lists it as accepted, but only when the caller uses a whitespace-preceding-colon or the whole `:` is on its own.

**Resolution**: extend the tokeniser to split on `[\s:]+` when the trailing character is a `:` immediately after the ref shape. **Chosen path**: keep the split at `\s+` and document the space-before-colon requirement (`- [ ] owner/repo#5 : description`). Adding delimiter-parsing in the caller re-introduces the "one more delimiter shape and we're broken" fragility (Decision 1 alternative rejected). Real-world epics use em-dash and ASCII hyphen, both of which are whitespace-separated; colon is an FR-002 nice-to-have. **This decision is captured here rather than in the spec because the spec-level accepted-delimiters list already includes colon; the tokeniser rule is a pure implementation detail.**

If a future epic body genuinely uses `owner/repo#N: title` without a space and it becomes a real problem, the follow-up is to change the split to `[\s:]+` or add a specific post-split trim rule. Cheap, non-breaking.

## Backward-compat / migration

- **Title-less checkbox lines** (`- [ ] owner/repo#N`): unchanged behavior (FR-003).
- **Bare-`#N` rejection** (`- [ ] #N`): still rejected, still warns — only the warning text now has a stable `bare '#N'` marker substring (FR-004, FR-005).
- **`parseRef` direct callers** (`ref-shapes.test.ts`, any downstream consumer): completely unaffected — the exported `parseRef` shape and behavior are unchanged.
- **`warnings: string[]` shape**: unchanged. Any downstream consumer that reads warnings continues to see strings; the leading `cockpit: ignored ref-shaped task-list line N: '<text>'` prefix is preserved.
- **`ParsedEpicBody` type**: unchanged.

## Test surface

Extension points, all under `packages/cockpit/src/resolver/__tests__/`:

- `parse-epic-body.test.ts` — add:
  - Inline integration excerpt: one phase heading × 4 accepted ref shapes × 2 delimiter styles (em-dash + ASCII hyphen). Assert `refs` equals the expected 8-entry list and `warnings` is empty.
  - Two snapshot-loader assertions: `readFileSync` each `.md` fixture, `parseEpicBody(body)`, assert phase-by-phase `refs` equals the ground-truth list and `warnings` is empty (SC-001, SC-002).
  - Three warning-family assertions using `toContain()` on the marker substrings: `bare '#N'`, `titled but not ref-shaped`, `URL path not /(issues|pull)/N` (SC-003).
  - Prose-line-with-late-ref assertion: `- [ ] Do X, see owner/repo#5` → empty `warnings` (SC-004).
  - First-token-is-ref + additional-refs-in-title assertion: `- [ ] owner/repo#1 — depends on owner/repo#2` → one ref `{ owner/repo, 1 }`, empty `warnings` (FR-008).
- `fixtures/epic-826-sniplink.md` (NEW) — verbatim body.
- `fixtures/epic-826-tetrad-88.md` (NEW) — verbatim body.

No new test files. `ref-shapes.test.ts`, `heading-match.test.ts`, and `resolve.test.ts` are untouched.
