# Contract: `MACHINE_MARKERS` family match

**Feature**: `993-summary-orchestrator-s`
**Applies to**: `matchMachineMarker`, `commentCarriesMachineMarker` (`packages/orchestrator/src/worker/clarification-markers.ts:137-153`)

## Signature (unchanged)

```ts
export function commentCarriesMachineMarker(body: string): boolean;
export function matchMachineMarker(body: string): string | undefined;
```

## Match semantics

A comment body carries a machine marker iff **any** of the following holds:

1. Some line of `body` (split on `\n`, no trim) starts with a prefix in the new `MACHINE_MARKER_FAMILIES` constant:
   - `'<!-- generacy-stage:'`
   - `'<!-- speckit-stage:'`
2. Some line of `body` starts with a prefix in the enumerated `MACHINE_MARKERS` constant (post-refactor — question-family via `CLARIFICATION_QUESTION_MARKERS`, plus the non-stage engine families).

Both matchers run per-line. First match wins (returns the matched prefix string). Empty body → `undefined`.

### Case sensitivity + whitespace

- **Case-sensitive** ASCII. `<!-- Generacy-Stage:` does NOT match.
- **No trim, no case folding, no unicode normalization**. Line prefix check uses `String.prototype.startsWith`.
- **Line-anchored**. Only fires when the prefix is at column 0 of some line. `> <!-- generacy-stage:` (quoted) does NOT match — this is load-bearing for humans quoting a bot summary while answering.

### Return value semantics

- `matchMachineMarker` returns:
  - The **family prefix** (`'<!-- generacy-stage:'` or `'<!-- speckit-stage:'`) when a family match fires — NOT the full-suffix string.
  - The exact enumerated string when an enumerated match fires.
  - `undefined` when neither fires.

- `commentCarriesMachineMarker(body) === (matchMachineMarker(body) !== undefined)` — implementation delegates.

## Postconditions

### What the family match catches (SC-004)

Every `<!-- generacy-stage:<anything>` and `<!-- speckit-stage:<anything>` prefix, present or future, without a code change. Examples:

- `<!-- generacy-stage:specification` (previously enumerated)
- `<!-- generacy-stage:planning` (previously enumerated)
- `<!-- generacy-stage:implementation` (previously enumerated)
- `<!-- generacy-stage:clarification` (was in `CLARIFICATION_QUESTION_MARKERS`, still there — family match also catches it)
- `<!-- speckit-stage:specification` (previously enumerated)
- `<!-- speckit-stage:planning` (previously enumerated)
- `<!-- speckit-stage:implementation` (previously enumerated)
- `<!-- speckit-stage:clarification` (**newly caught** — the observed bug)
- `<!-- speckit-stage:tasks` (**newly caught** — future-proof)
- `<!-- speckit-stage:validate` (future-proof)
- `<!-- generacy-stage:future-phase-that-does-not-exist-yet` (future-proof — the SC-004 assertion)

### What the family match does NOT catch (preserving FR-004 anchor)

- `<!-- generacy-clarifications:` — starts with `<!-- generacy-clarifications`, not `<!-- generacy-stage:`. Matched only by the enumerated (via `CLARIFICATION_QUESTION_MARKERS` spread).
- `<!-- generacy-clarification:` — same. Enumerated only.
- `<!-- generacy-cockpit:clarifications-batch:` — enumerated only.
- `<!-- generacy-clarification-answers:` — enumerated only.
- `<!-- generacy-cockpit:manual-advance` — enumerated only.
- `<!-- generacy-untrusted-answer:` — enumerated only.
- `<!-- generacy-clarification-parse-failures:` — enumerated only.

The FR-004 anchor lookup uses `matchClarificationQuestionMarker` which reads `CLARIFICATION_QUESTION_MARKERS` directly — completely separate from `MACHINE_MARKERS` matching. Family-match changes to `matchMachineMarker` have no effect on the anchor.

## Non-behavior

- MUST NOT change the `CLARIFICATION_QUESTION_MARKERS` or `CLARIFICATION_ANSWER_MARKERS` registries.
- MUST NOT change the semantics of `commentCarriesQuestionMarker` / `matchClarificationQuestionMarker` / `commentCarriesAnswerMarker` / `matchClarificationAnswerMarker`.
- MUST NOT emit logs — matcher functions are pure.
- MUST NOT allocate beyond the split-lines array (which was already allocated).

## Rejection cases

None. Matchers are total functions on `string` input.

## Test cases (informative — reference for the tasks phase)

### SC-004: future stage marker caught without a code change

```
input: '<!-- speckit-stage:tasks -->\nBody text\n'
expect: commentCarriesMachineMarker(input) === true
        matchMachineMarker(input) === '<!-- speckit-stage:'
```

### Regression: previously-caught marker still caught

```
input: '<!-- generacy-stage:specification -->\nBody\n'
expect: commentCarriesMachineMarker(input) === true
        matchMachineMarker(input) === '<!-- generacy-stage:'
```

### Regression: newly-caught marker (the observed bug)

```
input: '<!-- speckit-stage:clarification -->\nBody\n'
expect: commentCarriesMachineMarker(input) === true
        matchMachineMarker(input) === '<!-- speckit-stage:'
```

### FR-004 anchor not disturbed: question marker still in question-marker set

```
input: '<!-- generacy-clarifications:5 -->\nBody\n'
expect: commentCarriesMachineMarker(input) === true
        matchMachineMarker(input) === '<!-- generacy-clarifications:'
        commentCarriesQuestionMarker(input) === true     // (unchanged)
```

### Question-batch prefix NOT swept up by family match

```
input: '<!-- generacy-clarifications:5 -->\n'
expect: matchMachineMarker(input) === '<!-- generacy-clarifications:'
        // NOT '<!-- generacy-stage:' — because '<!-- generacy-clarifications' does not begin with '<!-- generacy-stage:'
```

### Case sensitivity preserved

```
input: '<!-- Generacy-Stage:foo -->\n'
expect: commentCarriesMachineMarker(input) === false
```

### `> `-quoted marker still not matched

```
input: '> <!-- generacy-stage:specification -->\n'
expect: commentCarriesMachineMarker(input) === false
```

### Empty body

```
input: ''
expect: matchMachineMarker(input) === undefined
```
