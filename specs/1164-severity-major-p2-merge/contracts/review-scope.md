# Contract: Extended `ReviewScope` + conflicted-path allowlist semantics

**FRs**: FR-003, FR-004
**Type home**: `packages/orchestrator/src/worker/handler-outcome.ts`
**Consumers**: `merge-conflict-handler.ts` (producer), `review-executor.ts`,
`review-charter.ts`

---

## Type shape

```ts
export interface ReviewScope {
  readonly baseSha: string;
  readonly headSha: string;
  readonly conflictedPaths?: readonly string[]; // FR-003
}
```

## Producer contract — `getResolutionScope(..., conflictedPaths)`

- Input: the live `conflictedPaths` local threaded from the re-arm call site
  (`merge-conflict-handler.ts:389`), enumerated at `:275-291` via
  `git diff --name-only --diff-filter=U`.
- Output `ReviewScope`:
  - `baseSha` = `git rev-parse --short HEAD^1` (pre-merge branch tip), unchanged.
  - `headSha` = branch tip SHA (merge commit), unchanged.
  - `conflictedPaths` = the passed allowlist when non-empty; omitted otherwise.
- No-op merge path (`isNoOp`): `{ baseSha: head, headSha: head }`, `conflictedPaths`
  omitted.
- Clean-merge path (no conflicts): `conflictedPaths` empty/omitted.

**Invariant**: `conflictedPaths` is populated **only** on the post-conflict-resolution
success path. On every other success path it is absent.

## Consumer contract — charter (`review-charter.ts`)

When `diffWindow` (the `ReviewScope`) is present:
- If `diffWindow.conflictedPaths` is non-empty → the charter names the allowlist as the
  review target: "Inspect ONLY these conflicted paths … Ignore all other files" and lists
  each path. It MUST NOT instruct the agent to review the raw `baseSha..headSha` range
  (that range contains the full base-branch delta — Defect 2).
- If `diffWindow.conflictedPaths` is empty/absent → fall back to the existing
  `baseSha..headSha` range description (pre-#1164 behavior — preserves FR-009 for any
  scope without an allowlist).
- The "Empty or trivial diff → blocking finding" paragraph MUST NOT be emitted whenever
  `diffWindow` is present (FR-004), regardless of `conflictedPaths`.

## Consumer contract — executor (`review-executor.ts`)

- `reviewScope` (hence its `conflictedPaths`) is honored only on round 1 (`!priorRound`).
  See `scoped-review-lifecycle.md`.

## Test assertions

- SC-002: a merge with a large base delta yields a charter whose review surface is exactly
  the conflicted paths; 0 base-only files appear.
- SC-003: a windowed (scoped) charter string omits the trivial-diff paragraph.
- FR-009: a `ReviewScope` without `conflictedPaths` produces the pre-#1164 range charter
  byte-for-byte.
