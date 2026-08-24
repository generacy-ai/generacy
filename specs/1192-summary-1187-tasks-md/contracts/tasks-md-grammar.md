# Contract: tasks.md grammar for `countTasks` (#1192)

This contract fixes the two task grammars `countTasks` recognizes and how each
contributes to the `{unchecked, checked, total}` tally. It is the source of truth
for the `tasks-md-fallback.test.ts` matrix. No public export changes — this is an
internal `worker/` contract.

## Regexes (module-level)

```ts
const CHECKBOX_LINE = /^[ \t]*[-*+] \[( |x|X)\]/;            // existing (FR-004) — unchanged
const HEADING_TASK  = /^#{1,6}[ \t]+T\d+(?![-–—]\s*T?\d)\b/; // new (FR-001, Q3=A)
const HEADING_DONE  = /^#{1,6}[ \t]+T\d+[ \t]+\[DONE\]/;     // new (FR-002, Q2=B strict)
```

## Per-line algorithm (order is normative)

1. Test `CHECKBOX_LINE`.
   - On match: capture group 1 is `x`/`X` → `checked++`; single space → `unchecked++`.
     Then **skip the line** (`continue`) — heading detection never runs on it. This
     guarantees FR-004 byte-identical checkbox behavior and makes a checkbox+heading
     collision on one line impossible.
2. Otherwise test `HEADING_TASK`.
   - On no match: the line is not a task; ignore it (FR-007).
   - On match: test `HEADING_DONE` on the same line.
     - Matches → `checked++`.
     - Does not match → `unchecked++`.
3. `total = unchecked + checked`.

Both grammars increment the **same** counters, so mixed-grammar files sum (FR-003).

## Input → output truth table (SC-002)

| Input line | Grammar | Effect |
|------------|---------|--------|
| `- [ ] T001 do a thing` | checkbox | `unchecked++` |
| `- [x] T001 done` | checkbox | `checked++` |
| `- [X] T001 done` | checkbox | `checked++` |
| `* [ ] item` / `+ [ ] item` | checkbox | `unchecked++` |
| `### T001 Description` | heading | `unchecked++` |
| `### T001 [DONE] Description` | heading | `checked++` |
| `## T001 [DONE]` (any level 1–6) | heading | `checked++` |
| `### T001 Description [DONE]` | heading | `unchecked++` (Q2=B — `[DONE]` not immediately after ID) |
| `### T005 Verify [DONE] rendering` | heading | `unchecked++` (Q2=B — title mentions marker) |
| `### T001-T026 remaining` | heading (rejected) | no counter change (Q3=A boundary) |
| `### T001–T026 remaining` (en-dash) | heading (rejected) | no counter change |
| `### T001—T026 remaining` (em-dash) | heading (rejected) | no counter change |
| `### Phase 3.1: T012` | not anchored | no counter change |
| `### Task T001` | not anchored | no counter change |
| `### Notes on T001` | not anchored | no counter change |
| `## Phase 1: Setup` | not a task | no counter change |
| `Regular prose about T001.` | not a heading | no counter change |

## Classification contract (`evaluateTasksMd` — unchanged)

`countTasks` output routes through the existing classifier:

- `unchecked > 0` → `{ kind: 'incomplete', unchecked, checked, total }`.
- `unchecked === 0` → `{ kind: 'complete', unchecked: 0, checked, total }`
  (covers both all-checked and `total === 0` task-less files — FR-005 fail-open).
- I/O / spec-dir resolution failure → `{ kind: 'unreadable', reason }` (FR-007).

## FR-006 log-only signal (phase-loop, not the evaluator)

The evaluator stays pure/loggerless and `TasksMdEvaluation` is unchanged. The
phase-loop `complete` branch gains one `info` line keyed on `evalResult.total === 0`
so an operator can distinguish "no task lines recognized in either grammar" from a
legitimate all-checked advance. `complete` with `total > 0` stays silent.
