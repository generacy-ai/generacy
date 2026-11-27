# Research: Numeric spec-dir resolution

## Decision 1 — Where the shared resolver lives

**Decision**: New module `packages/workflow-engine/src/specs/spec-dir-resolver.ts`,
re-exported from the package's public `index.ts`.

**Rationale**: Clarification Q1 (B) mandates `@generacy-ai/workflow-engine` as the home.
Verified dependency edges: `workflow-engine` has no internal workspace deps;
`orchestrator` depends on it via `workspace:^` and `generacy` via `workspace:*` — so all
seven call sites can import it with no new build cycle. Existing `src/` layout has no
`utils/` catch-all; a dedicated `specs/` module keeps the export discoverable.

**Alternatives considered**:
- `@generacy-ai/config` or a new shared package — rejected: `workflow-engine` is the only
  package all three consumers already depend on; a new package is overhead for one
  function.
- Duplicate the fix at each site — rejected by Q1 (seven drifting copies of the
  precedence rule).

## Decision 2 — Pure function over directory listing, not an FS-reading helper

**Decision**: The resolver takes `entries: string[]` (a pre-read directory listing) and
an `issueNumber`, returning a discriminated result. No I/O.

**Rationale**: Call sites are split between sync `readdirSync` (safety net,
epic-post-tasks, preflight, get-context, post-tasks-summary, clarification-poster) and
async `readdir` (cockpit `context.ts`), with differing error handling (unreadable-reason
strings vs silent undefined vs branch-dir fast path). A pure matcher composes with all of
them and is trivially unit-testable; an FS-reading helper would need both sync/async
variants plus per-site error-shape options.

**Alternatives considered**: FS-backed `resolveSpecDir(specsPath, issueNumber)` —
rejected; it would force error-handling policy into the shared helper and need dual
sync/async APIs.

## Decision 3 — Matching algorithm and exact-match precedence

**Decision**: `^(\d+)-` anchored regex per entry; candidate iff
`Number(digits) === issueNumber`. Exact (non-padded, `digits === String(issueNumber)`)
wins outright; padded candidates are consulted only when no exact match exists; multiple
surviving candidates → `ambiguous`; zero → `none`.

**Rationale**: Directly implements FR-001/FR-002/FR-002a/FR-002b/FR-003/FR-004 and
clarification Q2 (B). The anchored `-` after the digit group rejects `006abc-foo` (US2)
and non-numeric dirs like `specs/contracts/` (FR-002a). Numeric compare makes `006-` and
`6-` equivalent while `60-`/`600-` never match issue 6. This is the same regex
`clarification-poster.ts` already used — that site converges on the shared helper and
additionally gains the precedence rule.

**Alternatives considered**:
- Both-exist → always `unreadable` (original US2 draft) — superseded by Q2 (B): in this
  repo, legacy sequence-numbered padded dirs (e.g. `specs/006-job-scheduler-queue-system`)
  coexist with issue-keyed non-padded dirs, and the exact dir is the right answer.
- Resolve from branch name instead of issue number — explicitly out of scope (spec).

## Decision 4 — Two export shapes: `matchSpecDir` + `findSpecDirName`

**Decision**: Export the full discriminated-union matcher plus a `string | undefined`
convenience wrapper (undefined on none **and** ambiguous).

**Rationale**: Only the safety net distinguishes ambiguity (FR-003, distinct `unreadable`
reason including the dir list). The other five sites previously took `.find()`'s first
hit with no ambiguity concept; mapping ambiguous → not-found preserves each site's
existing failure path (preflight's all-false status, post-tasks-summary's failureResult,
cockpit's null, epic-post-tasks' `specs/${issueNumber}` fallback) without inventing new
error handling there.

## Decision 5 — Changeset shape

**Decision**: Single new changeset file listing `workflow-engine: minor` (new export on
the public `index.ts`), `orchestrator: patch`, `generacy: patch`.

**Rationale**: CLAUDE.md changeset rules — new public capability → minor; behavior fix in
dependents → patch; every package with non-test `src/` changes must be listed. FR-008
restates this. Gate: `.github/workflows/changeset-bot.yml` (requires a newly **added**
file).

## Key sources

- `packages/orchestrator/src/worker/tasks-md-fallback.ts` — defect site; `unreadable`
  fail-open contract (#1187, #1214).
- `packages/orchestrator/src/worker/clarification-poster.ts` (`findSpecDir`) — existing
  numeric-match reference implementation.
- Clarifications: `specs/1241-summary-evaluatetasksmd/clarifications.md` (Q1=B, Q2=B).
- CLAUDE.md "tasks.md fallback" invariant: sentinel stays authoritative; `unreadable`
  advances; no-progress guard is the only backstop — this change touches only directory
  resolution.
