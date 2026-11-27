# Data Model: Numeric spec-dir resolver

## New types (`@generacy-ai/workflow-engine`)

### `SpecDirMatch`

Discriminated union — the result of matching a `specs/` directory listing against an
issue number.

```ts
export type SpecDirMatch =
  | { kind: 'match'; dir: string }        // unique resolution; dir is the entry name (not a path)
  | { kind: 'none' }                      // no entry's numeric prefix equals issueNumber
  | { kind: 'ambiguous'; dirs: string[] } // >1 surviving candidate after precedence; dirs sorted as listed
```

### Functions

```ts
/** Pure. entries = raw readdir listing of specs/; issueNumber = positive integer. */
export function matchSpecDir(entries: string[], issueNumber: number): SpecDirMatch;

/** matchSpecDir convenience: entry name on 'match', undefined on 'none' | 'ambiguous'. */
export function findSpecDirName(entries: string[], issueNumber: number): string | undefined;
```

## Matching rules (validation)

| Rule | Behavior |
|---|---|
| Candidate filter | Entry must match `^(\d+)-`; candidate iff `Number(digits) === issueNumber` (FR-001) |
| Non-conforming entries | No `^(\d+)-` prefix (e.g. `contracts`, `006abc-foo`) → ignored (FR-002a) |
| Padding equivalence | `006-foo` and `6-foo` both candidates for issue 6 (FR-002) |
| Exact precedence | `digits === String(issueNumber)` (non-padded) wins outright over padded (FR-002b, Q2=B) |
| Ambiguity | No exact match and >1 padded candidate → `ambiguous` (FR-003); >1 exact match → `ambiguous` (defensive) |
| No match | Zero candidates → `none` (FR-004) |
| Cross-boundary | Issue 6 never matches `60-…` / `600-…` (US2) |

## Existing types (unchanged)

### `TasksMdEvaluation` (`packages/orchestrator/src/worker/tasks-md-fallback.ts`)

Shape unchanged (`incomplete` / `manual-only` / `complete` / `unreadable`). Only the
internal resolution of `specDir` changes; `SpecDirMatch.none` → `unreadable` with the
existing `no spec dir for issue N` reason, `SpecDirMatch.ambiguous` → `unreadable` with
the existing `ambiguous spec dirs for issue N: …` reason.

### `countTasks` return shape

Untouched (FR-005): `{ unchecked, checked, total, manual }`.

## Relationships

```
@generacy-ai/workflow-engine
  └── specs/spec-dir-resolver (new, pure)
        ▲ used by (same package):
        │   actions/github/preflight.ts        (checkSpeckitStatus)
        │   actions/github/get-context.ts      (findFeatureDir)
        │   actions/epic/post-tasks-summary.ts
        ▲ used by @generacy-ai/orchestrator:
        │   worker/tasks-md-fallback.ts        (evaluateTasksMd — matchSpecDir, full union)
        │   worker/epic-post-tasks.ts          (resolveFeatureDir)
        │   worker/clarification-poster.ts     (findSpecDir)
        ▲ used by @generacy-ai/generacy (CLI):
            cli/commands/cockpit/context.ts    (findSpecDir — after branch-dir fast path)
```

Branch-name matchers (`preflight.ts:199/344`, `epic-post-tasks.ts:330`,
`pr-linker.ts`, `claude-cli-worker.ts`) do **not** use the resolver — they match
branches, not spec dirs.
