# Contract: Cockpit epic-body parser behavior (post-fix)

**Feature**: `826-found-during-cockpit-v1` | **Date**: 2026-07-07

This document describes the observable behavior of `parseEpicBody` and the caller-side handling of task-list ref extraction after the #826 fix. It is not a wire schema — `parseEpicBody` is a pure function inside `@generacy-ai/cockpit` — but it is the acceptance surface the tests assert against and the doc side (`docs/label-protocol.md § Epic body format`) already describes.

## Function

```ts
parseEpicBody(body: string): ParsedEpicBody
```

Pure, synchronous, no I/O, no throws.

```ts
interface ParsedEpicBody {
  phases: ParsedPhase[];     // in order of appearance
  allRefs: IssueRef[];        // global-dedup'd across phases, sorted by (repo, number)
  warnings: string[];         // rejected-but-ref-shaped lines; see §Warnings
}

interface ParsedPhase {
  heading: string;            // the full `### <text>` trimmed
  token: string;              // firstToken(heading) — the phase token
  refs: IssueRef[];           // within-phase dedup'd, in order of appearance
}

interface IssueRef {
  repo: string;               // e.g. 'owner/repo'
  number: number;             // positive integer
}
```

Type shape is **unchanged by this fix**. Only the *contents* of `warnings` semantics change.

## Grammar (unchanged in structure)

- **Heading level 3** (`^### (.+)$`) opens a phase.
- **Heading level 4+** (`^#### … $`) closes the current phase.
- **Heading level 2** (`^## …$`) is ignored (does not open or close a phase).
- **Task-list item** (`^\s*- \[[ xX]\] (.+?)$`) appends a ref to the current phase (or is silently discarded if outside a phase).

## Task-list ref extraction (this fix)

Given a matched task-list line, let `refText` be the captured remainder (already `.trim()`-ed) and let `firstToken = refText.split(/\s+/)[0]`.

- **`parseRef(firstToken)` is called** — not `parseRef(refText)`. This is the core of the #826 fix (FR-001).
- The four accepted ref shapes (`ref-shapes.ts`) are enumerated as:
  1. Bare: `owner/repo#N`
  2. Markdown link with bare label: `[owner/repo#N](url)`
  3. Markdown link with `#N` label: `[#N](https://github.com/owner/repo/(issues|pull)/N)`
  4. Plain URL: `https://github.com/owner/repo/(issues|pull)/N`
- All four match a **whitespace-free token**. First-token extraction is sufficient.
- **Delimiter and title after the first token are consumed unparsed.** Any of em-dash `—`, ASCII hyphen `-`, colon `:` (with a preceding space), or whitespace-only is accepted (FR-002).

### Line examples (all resolve to `{ owner/repo, 1 }`)

```
- [ ] owner/repo#1
- [x] owner/repo#1
- [ ] owner/repo#1 — title
- [ ] owner/repo#1 - title
- [ ] owner/repo#1 : title
- [ ] owner/repo#1   title
- [ ] [owner/repo#1](https://example.com) — title
- [ ] [#1](https://github.com/owner/repo/issues/1) — title
- [ ] https://github.com/owner/repo/issues/1 — title
- [ ] https://github.com/owner/repo/pull/1 — title
- [ ] owner/repo#1 — depends on owner/repo#2   (only owner/repo#1 is taken)
```

### Line examples (silent — no ref, no warning)

```
- [ ] Do X, see owner/repo#5           (prose; first token 'Do' is not ref-shaped)
- [x] TBD                              (prose)
```

### Line examples (warn — ref-shaped but rejected)

```
- [ ] #8                               → warning contains "bare '#N'"
- [ ] owner/repo#0                     → warning contains "titled but not ref-shaped"
- [ ] https://github.com/o/r/commit/…  → warning contains "URL path not /(issues|pull)/N"
```

## Warnings

`warnings: string[]` — the shape is unchanged; the *contents* now carry documented marker substrings per rejection family.

**Envelope**:
```
cockpit: ignored ref-shaped task-list line <N>: '<refText>' (<reason>)
```

Where `<N>` is 1-indexed line number in the body, `<refText>` is the full checkbox remainder (title included), and `<reason>` contains exactly one of the three documented marker substrings.

**Rejection families**:

| Family                        | Marker substring                          |
|-------------------------------|-------------------------------------------|
| Bare-`#N` shorthand           | `bare '#N'`                               |
| Titled-but-not-ref-shaped     | `titled but not ref-shaped`               |
| URL-with-wrong-path           | `URL path not /(issues\|pull)/N`          |

**First-token silence rule (FR-007)**: if the first token is not ref-shaped per `REF_SHAPED_RE`, no warning is emitted regardless of what appears later on the line. A prose checkbox that mentions a ref mid-sentence does not warn.

**Title-portion silence rule (FR-008)**: if the first token IS a ref, additional ref-shaped tokens later on the line are silently ignored — no warning, no extra refs added to the phase.

## Non-goals of this contract

- No new ref shapes are added. The four shapes in `ref-shapes.ts` remain the complete accepted set.
- No structured-warning object is introduced. `warnings` is still `string[]`. Follow-up work (see Out-of-Scope in spec) can migrate to `{ code, line, text }` if operator tooling grows a use case.
- No revert of the interim workaround on `tetrad-development#88` — that revert is a manual `gh issue edit` step in the PR description (Q4→C), not a code change here.

## Test assertion patterns

Tests assert on marker substrings, not full wording:

```ts
expect(warnings[0]).toContain("bare '#N'");
expect(warnings[0]).toContain('titled but not ref-shaped');
expect(warnings[0]).toContain('URL path not /(issues|pull)/N');
```

Tests also assert on the envelope pieces:

```ts
expect(warnings[0]).toMatch(/ignored ref-shaped task-list line \d+/);
expect(warnings[0]).toContain(`'${offendingText}'`);   // full refText preserved
```

Snapshot fixtures at `packages/cockpit/src/resolver/__tests__/fixtures/epic-826-sniplink.md` and `epic-826-tetrad-88.md` are loaded via `readFileSync` and passed to `parseEpicBody` directly; the assertion is that `warnings` is `[]` and phase-by-phase `refs` equals the ground-truth list.
