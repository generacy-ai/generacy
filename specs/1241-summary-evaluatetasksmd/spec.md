# Feature Specification: tasks.md safety net must match zero-padded spec dirs

**Branch**: `1241-summary-evaluatetasksmd` | **Date**: 2026-11-27 | **Status**: Draft

## Summary

The orchestrator's implement→continue "tasks.md safety net" (`evaluateTasksMd`,
`packages/orchestrator/src/worker/tasks-md-fallback.ts`) resolves a workflow's spec
directory under `specs/` by prefix-matching `${issueNumber}-` against directory names
(`entry.startsWith(\`${issueNumber}-\`)`).

spec-kit names feature directories with a **zero-padded three-digit** number — e.g.
`specs/006-…` for issue 6, `specs/023-…` for issue 23. For any issue below 100 the string
prefix `6-` / `23-` never matches `006-…` / `023-…`, so the function returns
`{ kind: 'unreadable', reason: 'no spec dir for issue 6' }`. The phase loop then logs
"tasks.md safety net: advancing (fallback source unavailable)" and **advances** (fail-open).

Because the safety net is the backstop that catches a partial implement when the
`SPECKIT_IMPLEMENT_PARTIAL` sentinel is missing, this fail-open lets a partial implement
(e.g. 10 of 54 tasks done) be treated as complete — the phase advances with 44 tasks still
unchecked. Combined with the related sentinel-detection issue under stream-json, a
single-/double-digit issue silently ships incomplete work.

Per clarification Q1, the same prefix-match defect at five sibling call sites is in scope:
a single shared numeric spec-dir resolver is extracted into `@generacy-ai/workflow-engine`
and used at all six prefix-match sites — `tasks-md-fallback.ts`,
`packages/orchestrator/src/worker/epic-post-tasks.ts:302`,
`packages/workflow-engine/src/actions/github/preflight.ts:298`,
`packages/workflow-engine/src/actions/github/get-context.ts:123`,
`packages/workflow-engine/src/actions/epic/post-tasks-summary.ts:55`,
`packages/generacy/src/cli/commands/cockpit/context.ts:408` — plus
`clarification-poster.ts` (already numeric, converges on the shared helper). The
branch-name `startsWith` checks (`preflight.ts:199/344`, `epic-post-tasks.ts:330`) match
branches, not spec dirs, and are unchanged.

## Clarifications

### Session 2026-11-27

- Q1 (fix scope): **B** — fix all sites via one shared numeric spec-dir resolver in
  `@generacy-ai/workflow-engine` (no build cycle: both orchestrator and the CLI already
  depend on it); three-package changeset accepted.
- Q2 (legacy-dir collision): **B** — exact non-padded `${issueNumber}-…` match wins
  outright; zero-padded variants are consulted only when no exact match exists. This
  precedence rule replaces the US2 both-exist→`unreadable` guard. Residual legacy-dir
  risk documented in Assumptions.

## User Stories

### US1: Partial implement on a low-numbered issue is caught

**As a** Generacy cluster operator running a speckit feature on an issue numbered below 100,
**I want** the tasks.md safety net to find the zero-padded spec directory,
**So that** a partial implement re-enters instead of advancing as if complete.

**Acceptance Criteria**:
- [ ] For issue 6 with spec dir `specs/006-foo/`, `evaluateTasksMd` resolves `006-foo` and
  reads its `tasks.md`.
- [ ] A `tasks.md` under that dir with unchecked automatable tasks yields `incomplete`
  (not `unreadable`), so the phase re-enters.
- [ ] Non-padded dirs (`specs/6-foo/` for issue 6, `specs/123-foo/` for issue 123) continue
  to resolve exactly as before.

### US2: No false matches across number boundaries

**As a** cluster operator,
**I want** issue 6 to never match `specs/60-foo/` or `specs/006abc-foo/`,
**So that** the wrong spec dir is never read.

**Acceptance Criteria**:
- [ ] Issue 6 does not match `60-…`, `600-…`, or any dir whose leading digits are not
  numerically 6.
- [ ] `006-…` and `6-…` both match issue 6; if both exist, the exact non-padded `6-…`
  dir wins outright (exact-match precedence per clarification Q2 — padded variants are
  consulted only when no exact match exists).
- [ ] When no exact match exists and more than one padded dir resolves to the same issue
  number, the result stays `unreadable` (ambiguous).

### US3: Sibling resolvers share the fix

**As a** cluster operator,
**I want** every spec-dir resolver in the pipeline to use the same numeric matching rules,
**So that** low-numbered issues behave consistently across the safety net, epic task
posting, preflight, context gathering, and the cockpit CLI.

**Acceptance Criteria**:
- [ ] A shared resolver exported from `@generacy-ai/workflow-engine` implements the
  numeric match and exact-match precedence.
- [ ] All six prefix-match sites plus `clarification-poster.ts` resolve through it.
- [ ] Branch-name `startsWith` checks (`preflight.ts:199/344`, `epic-post-tasks.ts:330`)
  are unchanged.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Spec-dir resolution matches on the **numeric** value of the leading `^(\d+)-` segment, comparing `Number(segment) === issueNumber`, rather than string-prefix on `${issueNumber}-`. | P1 | Core fix |
| FR-002 | Both zero-padded (`006-`) and non-padded (`6-`) directory names resolve for the same issue number. | P1 | |
| FR-002a | Directories whose name does not begin with `^(\d+)-` are ignored (not matched). | P1 | Avoids matching `specs/contracts/` etc. |
| FR-002b | A directory named exactly `${issueNumber}-…` (non-padded) wins outright; zero-padded variants are consulted only when no exact match exists. | P1 | Exact-match precedence (Q2: B) |
| FR-003 | When no exact match exists and more than one padded directory resolves to the same issue number, the result stays `unreadable` with an ambiguous-dirs reason. | P1 | Multi-match guard, now scoped below the precedence rule |
| FR-004 | When no directory resolves, the result stays `unreadable` with the no-spec-dir reason (existing fail-open behavior preserved). | P1 | |
| FR-005 | `countTasks` and all downstream classification (`incomplete`/`manual-only`/`complete`) are unchanged. | P1 | Fix is scoped to directory resolution only |
| FR-006 | The numeric match + precedence logic lives in one shared resolver exported from `@generacy-ai/workflow-engine`. | P1 | Q1: B |
| FR-007 | All six prefix-match sites (`tasks-md-fallback.ts`, `epic-post-tasks.ts:302`, `preflight.ts:298`, `get-context.ts:123`, `post-tasks-summary.ts:55`, `cockpit/context.ts:408`) plus `clarification-poster.ts` resolve spec dirs through the shared resolver. | P1 | Branch-name `startsWith` checks unchanged |
| FR-008 | Changesets cover every package whose non-test `src/` changes: `workflow-engine` (new export → minor), `orchestrator` and `generacy` (patch). | P1 | CI changeset gate |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Low-numbered issues (<100) with zero-padded spec dirs resolve their tasks.md | 100% | Unit test: issue 6 + `006-foo/tasks.md` → non-`unreadable` |
| SC-002 | No cross-boundary false match | 0 false matches | Unit tests: issue 6 vs `60-`, `600-`, `006-` |
| SC-003 | Existing non-padded behavior unchanged | No regressions | Existing `tasks-md-fallback` test suite passes |
| SC-004 | Exact-match precedence | Exact dir wins | Unit test: issue 6 with both `6-foo/` and `006-bar/` resolves `6-foo` |
| SC-005 | All resolver call sites share the helper | 0 remaining `startsWith(\`${issueNumber}-\`)` spec-dir matches | Grep across the three packages |

## Assumptions

- spec-kit emits at most one spec directory per issue number in normal operation; the
  ambiguous-match path remains a defensive guard.
- `issueNumber` on `WorkerContext.item` is a positive integer.
- Directory names use a decimal leading number segment followed by `-` (spec-kit convention).
- Residual risk (accepted per clarification Q2): when only a legacy sequence-numbered
  padded dir exists (e.g. `specs/006-job-scheduler-queue-system`), it can still be read
  for a low-numbered issue with no spec dir of its own — bounded by the no-progress
  guard (roughly one wasted implement cycle). Branch-name resolution stays out of scope.

## Out of Scope

- The related `SPECKIT_IMPLEMENT_PARTIAL` sentinel-detection issue under stream-json.
- Resolving the spec directory from the branch name instead of the issue number (named as an
  alternative in the issue; the numeric-match fix is the chosen approach).
- Any change to task counting, manual classification, or phase-loop re-entry logic.

---

*Generated by speckit*
