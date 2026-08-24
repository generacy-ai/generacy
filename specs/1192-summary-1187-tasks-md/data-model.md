# Data Model: tasks.md safety net misses the heading task grammar (#1192)

No new types, no schema changes, no persisted state. The existing
`TasksMdEvaluation` discriminated union and the `{unchecked, checked, total}`
tally are unchanged. This document records the grammar rules and the counting
truth table.

## Types (unchanged)

```ts
type TasksMdEvaluation =
  | { kind: 'incomplete'; unchecked: number; checked: number; total: number }
  | { kind: 'complete';   unchecked: 0;      checked: number; total: number }
  | { kind: 'unreadable'; reason: string };

function countTasks(content: string): { unchecked: number; checked: number; total: number };
```

## Grammar rules

| Grammar | Detect | Checked when | Unchecked when |
|---------|--------|--------------|----------------|
| Checkbox (existing) | `^[ \t]*[-*+] \[( \|x\|X)\]` | capture is `x` / `X` | capture is a single space |
| Heading (new) | `^#{1,6}[ \t]+T\d+(?![-–—]\s*T?\d)\b` | `^#{1,6}[ \t]+T\d+[ \t]+\[DONE\]` matches | heading task matches but `[DONE]` does not immediately follow the ID |

- Both grammars increment the **same** `unchecked` / `checked` counters
  (FR-003 — mixed files sum).
- Checkbox is tested first; on a checkbox match the line is counted and skipped
  (heading detection never runs on it) — FR-004 byte-identical.
- `[DONE]` is case-sensitive (matches the prompt's literal `[DONE]`).

## Counting truth table (SC-002)

| Line | Grammar | Result |
|------|---------|--------|
| `- [ ] T001 do a thing` | checkbox | unchecked |
| `- [x] T001 done` / `- [X] T001` | checkbox | checked |
| `### T001 Description` | heading | unchecked |
| `### T001 [DONE] Description` | heading | checked |
| `### T001 Description [DONE]` | heading | **unchecked** (Q2=B — marker not immediately after ID) |
| `### T001-T026 remaining` | heading (rejected) | **0 tasks** (Q3=A boundary) |
| `### T001–T026 remaining` (en-dash) | heading (rejected) | **0 tasks** |
| `### T001—T026 remaining` (em-dash) | heading (rejected) | **0 tasks** |
| `### Phase 3.1: T012` | not anchored | 0 tasks |
| `### Task T001` | not anchored | 0 tasks |
| `## Phase 1: Setup` (no ID) | not a task | 0 tasks |
| mixed checkbox + heading file | both | summed |

## Classification flow (unchanged)

`countTasks` → `evaluateTasksMd`:
- `unchecked > 0` → `incomplete` → phase-loop synthesizes `implementResult` → re-enter implement.
- `unchecked === 0` → `complete` → advance.
  - `total === 0` → additionally emit the FR-006 distinct log line (Q1=A, phase-loop only).
  - `total > 0` (all checked) → silent, as today.
- I/O / resolution failure → `unreadable` → advance + existing log (FR-007, unchanged).
