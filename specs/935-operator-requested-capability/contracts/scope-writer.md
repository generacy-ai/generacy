# Contract: `applyScopeMutation` (pure body writer)

**Module**: `packages/generacy/src/cli/commands/cockpit/scope/writer.ts`

## Signature

```typescript
type BodyShape = 'phased' | 'flat';

interface IssueRef {
  repo: string;    // 'owner/name'
  number: number;
}

type ScopeMutation =
  | { kind: 'add'; ref: IssueRef }
  | { kind: 'remove'; ref: IssueRef };

interface ScopeWriteResult {
  noop: boolean;   // true if input body already satisfies the mutation
  body: string;    // resulting body
  shape: BodyShape;
}

export function applyScopeMutation(
  body: string,
  mutation: ScopeMutation,
): ScopeWriteResult;

export function detectShape(body: string): BodyShape;
```

## Semantics

### `detectShape`

- Returns `'phased'` iff `body` contains at least one line matching `/^###\s+/`.
- Otherwise returns `'flat'`.
- The regex is byte-exact against `parseEpicBody`'s `HEADING_L3_RE` — parser parity is invariant I-1.

### `applyScopeMutation({ kind: 'add', ref })`

**Idempotency invariant (I-2)**: if the body already contains a task-list line whose ref matches (checked or unchecked), returns `{ noop: true, body, shape }` — input body unchanged.

**Phased shape**:
- If body contains `^##\s+Ad-hoc\s*$/im` (case-insensitive) heading:
  - Find the last task-list line under that heading (before the next `^##` heading of same/higher level or end-of-body).
  - Insert `- [ ] <repo>#<number>\n` immediately after that line.
  - If the heading exists but has no task-list lines under it yet, insert the new line immediately after the heading (with one blank line between if the heading is followed by non-list content).
- Else (no Ad-hoc section):
  - Append `\n## Ad-hoc\n\n- [ ] <repo>#<number>\n` at body tail. Preserves trailing newline if present, otherwise adds one first.

**Flat shape**:
- Append `- [ ] <repo>#<number>\n` at body tail. Ensures a trailing newline before appending if the body doesn't end with `\n`.

### `applyScopeMutation({ kind: 'remove', ref })`

**Idempotency invariant (I-3)**: if no task-list line matches, returns `{ noop: true, body, shape }`.

**Both shapes**:
- Delete the *first* task-list line whose parsed ref matches. Deletes the entire line including trailing newline.
- Does NOT delete an empty `## Ad-hoc` heading, even if the deletion leaves the section refless. (Symmetry with `add`: verb writes/deletes at line granularity only.)
- Ignores nested contexts — a matching line in any section is removed. In practice `parseEpicBody` dedupes across phases, so the first match is the canonical one.

### Ref formatting

- Output form: `- [ ] owner/name#N` — unchecked, one space padding, no title suffix. Parser accepts either `- [ ]` or `- [x]` on input (case-insensitive x).
- Input matching: `parseRef(refToken)` from `packages/cockpit/src/resolver/ref-shapes.ts` — accepts all four canonical shapes; the writer uses the qualified `owner/name#N` shape for output.

## Invariants

- **I-1** — Shape detection matches `parseEpicBody` phase-heading grammar. Regressions in either must break tests.
- **I-2** — `add` is idempotent w.r.t. ref presence.
- **I-3** — `remove` is idempotent w.r.t. ref absence.
- **I-4** — `applyScopeMutation` is pure: no I/O, no throws for well-formed input. Malformed body (non-string) is a type error caught at boundary, not runtime.
- **I-5** — Round-trip: `applyScopeMutation(applyScopeMutation(body, {add, ref}).body, {remove, ref}).body` is content-equivalent to `body` after re-normalisation (trailing newline preservation), for both shapes, for any body that doesn't already contain the ref.
- **I-6** — Shape stability: `add` on a phased body never converts it to flat and vice versa (unless the input was a flat body with no `### ` headings — writer never adds phase headings).

## Test cases (writer.test.ts)

| # | Input shape | Body condition | Mutation | Expected |
|---|-------------|----------------|----------|----------|
| 1 | phased | no Ad-hoc | `add owner/repo#5` | new Ad-hoc section at tail, one entry |
| 2 | phased | Ad-hoc exists, 1 entry | `add owner/repo#7` | entry appended under Ad-hoc |
| 3 | phased | Ad-hoc exists, 0 entries | `add owner/repo#5` | first entry under existing heading |
| 4 | phased | ref already in Phase 1 | `add same ref` | noop |
| 5 | phased | ref in Ad-hoc | `remove ref` | line deleted, Ad-hoc heading kept |
| 6 | flat | body has one ref line | `add owner/repo#9` | ref appended at tail |
| 7 | flat | empty body | `add owner/repo#1` | body becomes `- [ ] owner/repo#1\n` |
| 8 | flat | ref present | `remove ref` | line deleted |
| 9 | flat | no matching line | `remove` | noop |
| 10 | phased | trailing whitespace/no-newline | `add` | preserves format |
| 11 | any | round-trip add→remove | | content-equivalent to original |
