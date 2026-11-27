# Implementation Plan: tasks.md safety net must match zero-padded spec dirs

**Feature**: Shared numeric spec-dir resolver so the implement→continue safety net (and six sibling call sites) resolve zero-padded `specs/NNN-…` directories for issues below 100
**Branch**: `1241-summary-evaluatetasksmd`
**Status**: Complete

## Summary

`evaluateTasksMd` and five sibling call sites resolve a workflow's spec directory by
string-prefix matching `${issueNumber}-` against `specs/` entries. spec-kit zero-pads
directory numbers (`specs/006-…`), so for any issue below 100 the prefix never matches,
the safety net returns `unreadable`, and the phase loop fails open — a partial implement
advances as if complete.

Per clarifications Q1 (**B**) and Q2 (**B**), the fix is a single shared **pure** numeric
spec-dir resolver exported from `@generacy-ai/workflow-engine`, used at all six
prefix-match sites plus the already-numeric `clarification-poster.ts`:

- Match on the numeric value of the leading `^(\d+)-` segment
  (`Number(segment) === issueNumber`), not string prefix.
- **Exact-match precedence**: a dir named exactly `${issueNumber}-…` (non-padded) wins
  outright; padded variants are consulted only when no exact match exists.
- No exact match and >1 padded candidate → ambiguous (safety net stays `unreadable`).
- Entries not matching `^(\d+)-` are ignored.

Task counting, manual classification, and phase-loop re-entry logic are untouched
(FR-005); branch-name `startsWith` checks are untouched (they match branches, not spec
dirs).

## Technical Context

- **Language**: TypeScript (ESM, Node >= 22), pnpm monorepo
- **Packages touched**: `workflow-engine` (new export, minor), `orchestrator` (patch),
  `generacy` CLI (patch)
- **Dependency direction**: `workflow-engine` has no internal deps; both `orchestrator`
  (`workspace:^`) and `generacy` (`workspace:*`) already depend on it — no new build
  cycle. Cross-package imports resolve to built `dist/`, so **rebuild `workflow-engine`
  before typechecking/testing dependents**.
- **Testing**: Vitest unit tests (pure function + existing `tasks-md-fallback.test.ts`
  suite)
- **No new dependencies.**

## Design

### Shared resolver (`@generacy-ai/workflow-engine`)

New module `packages/workflow-engine/src/specs/spec-dir-resolver.ts` (re-exported from
`src/index.ts`). Pure — operates on a pre-read directory listing, no I/O — so both sync
(`readdirSync`) and async (`readdir`) call sites use it unchanged:

```ts
export type SpecDirMatch =
  | { kind: 'match'; dir: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; dirs: string[] };

/** Full result, for call sites that distinguish ambiguity (the safety net). */
export function matchSpecDir(entries: string[], issueNumber: number): SpecDirMatch;

/** Convenience: dir name on unique match, undefined on none/ambiguous. */
export function findSpecDirName(entries: string[], issueNumber: number): string | undefined;
```

Algorithm (FR-001/002/002a/002b/003/004):

1. `candidates` = entries where `^(\d+)-` matches and `Number(digits) === issueNumber`.
2. `exact` = candidates where `digits === String(issueNumber)` (non-padded).
3. One exact → `match`. Multiple exact → `ambiguous(exact)` (defensive; unspecified by
   spec-kit convention, same guard shape as FR-003).
4. No exact: one candidate → `match`; multiple → `ambiguous(candidates)`; zero → `none`.

Notes:
- `^(\d+)-` requires the digits to be immediately followed by `-`, so `006abc-foo` never
  matches issue 6 (US2) and non-numeric dirs (`specs/contracts/`) are ignored (FR-002a).
- Numeric comparison via `Number(...)` per FR-001; `issueNumber` is a positive integer
  per spec Assumptions.

### Call-site changes

| Site | Change |
|---|---|
| `packages/orchestrator/src/worker/tasks-md-fallback.ts` (`evaluateTasksMd`) | Replace the `startsWith` filter + `matches.length > 1` guard with `matchSpecDir(entries, issueNumber)`. Map `none` → `unreadable` "no spec dir for issue N"; `ambiguous` → `unreadable` "ambiguous spec dirs for issue N: …" (reasons preserved). All downstream logic unchanged. |
| `packages/orchestrator/src/worker/epic-post-tasks.ts:302` (`resolveFeatureDir`) | `dirs.find(startsWith)` → `findSpecDirName(dirs, issueNumber)`. Existing fallback (`specs/${issueNumber}`) unchanged. Line ~330 branch check untouched. |
| `packages/orchestrator/src/worker/clarification-poster.ts` (`findSpecDir`) | Replace the local numeric `find` body with `findSpecDirName` (converges on the shared helper; gains exact-precedence + ambiguity→undefined). |
| `packages/workflow-engine/src/actions/github/preflight.ts:298` (`checkSpeckitStatus`) | `dirs.find(startsWith)` → `findSpecDirName`. Lines 199/344 branch checks untouched. |
| `packages/workflow-engine/src/actions/github/get-context.ts:123` (`findFeatureDir`) | `dirs.find(startsWith)` → `findSpecDirName`. |
| `packages/workflow-engine/src/actions/epic/post-tasks-summary.ts:55` | `dirs.find(startsWith)` → `findSpecDirName`; existing "No spec directory found" failure path covers none/ambiguous. |
| `packages/generacy/src/cli/commands/cockpit/context.ts:408` (`findSpecDir`) | Keep the branch-named-dir fast path (`specs/<branch>` exists → use it); replace the prefix loop with `findSpecDirName(entries, issueNumber)`. |

For the five `find`-style sites, `ambiguous` maps to "not found" (undefined/null), which
preserves each site's existing not-found behavior; only the safety net reports the
ambiguous reason distinctly, per FR-003.

## Project Structure

```
packages/workflow-engine/src/specs/spec-dir-resolver.ts          # new: matchSpecDir, findSpecDirName, SpecDirMatch
packages/workflow-engine/src/specs/index.ts                      # new: barrel
packages/workflow-engine/src/index.ts                            # + export from './specs/index.js'
packages/workflow-engine/src/specs/__tests__/spec-dir-resolver.test.ts  # new unit tests
packages/workflow-engine/src/actions/github/preflight.ts         # use findSpecDirName
packages/workflow-engine/src/actions/github/get-context.ts       # use findSpecDirName
packages/workflow-engine/src/actions/epic/post-tasks-summary.ts  # use findSpecDirName
packages/orchestrator/src/worker/tasks-md-fallback.ts            # use matchSpecDir
packages/orchestrator/src/worker/epic-post-tasks.ts              # use findSpecDirName
packages/orchestrator/src/worker/clarification-poster.ts         # use findSpecDirName
packages/orchestrator/src/worker/__tests__/tasks-md-fallback.test.ts  # extend
packages/generacy/src/cli/commands/cockpit/context.ts            # use findSpecDirName
.changeset/1241-spec-dir-numeric-resolver.md                     # new changeset (3 packages)
```

## Testing

- **workflow-engine** (`spec-dir-resolver.test.ts`): padded match (issue 6 ↔ `006-foo`),
  non-padded match (issue 6 ↔ `6-foo`, issue 123 ↔ `123-foo`), exact-precedence (both
  `6-foo` and `006-bar` → `6-foo`, SC-004), cross-boundary non-matches (issue 6 vs
  `60-…`, `600-…`, SC-002), `006abc-foo` ignored, non-numeric entries ignored,
  multi-padded ambiguity, empty listing → none.
- **orchestrator** (`tasks-md-fallback.test.ts`): existing suite must pass unchanged
  (SC-003); add issue-6 + `specs/006-foo/tasks.md` → `incomplete` (SC-001), exact
  precedence through `evaluateTasksMd`, ambiguous padded dirs → `unreadable`.
- **SC-005 grep check**: after the change,
  `` rg "startsWith(\`\${issueNumber}-\`)" packages/*/src `` matches only the branch-name
  checks (`preflight.ts` branch check, `epic-post-tasks.ts` branch check).

## Changeset (CI gate)

One new `.changeset/1241-spec-dir-numeric-resolver.md` listing all three packages:
`@generacy-ai/workflow-engine: minor` (new public export), `@generacy-ai/orchestrator:
patch`, `@generacy-ai/generacy: patch` (FR-008).

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo — N/A. Repo-level invariants
(CLAUDE.md) respected: no agent-context files touched, changeset included, no new
cross-package dependency edges, tasks.md-fallback semantics (`unreadable` fail-open,
no-progress guard) preserved.

## Risks / Notes

- **Legacy sequence-numbered dirs** (accepted residual risk, Q2): when only a legacy
  padded dir exists (e.g. `specs/006-job-scheduler-queue-system`) it can be read for a
  low-numbered issue with no spec dir of its own; bounded by the no-progress guard.
- `clarification-poster.ts` behavior shifts slightly (first-numeric-match → exact-
  precedence + ambiguity→undefined); this is the intended convergence per FR-007.
- Build order: `pnpm --filter @generacy-ai/workflow-engine build` before typechecking
  orchestrator/generacy, or dependents report missing exports.
