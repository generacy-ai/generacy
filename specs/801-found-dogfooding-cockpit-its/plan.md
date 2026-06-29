# Implementation Plan: Cockpit `resolveEpicIssues` honors cross-repo epic children

**Feature**: Found by dogfooding the cockpit on its own epic (`generacy-ai/tetrad-development#85`) after #800
**Branch**: `801-found-dogfooding-cockpit-its`
**Status**: Complete
**Date**: 2026-06-29
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md)
**Input**: Feature specification at `/specs/801-found-dogfooding-cockpit-its/spec.md`

## Summary

Two coupled changes to `@generacy-ai/cockpit` so that `generacy cockpit status --epic` and `... watch --epic` work for cross-repo epics:

1. **Manifest path**: `resolveEpicIssues` returns repo-qualified refs (`Array<{ repo: string; number: number }>`) instead of a bare `number[]`, preserving each child's repo identity. Cross-repo entries in `phases[].issues` are no longer filtered out.
2. **Fallback path**: When no manifest matches, the function iterates `cockpit.repos ∪ epic's own repo` (deduped) and per repo runs both `label:epic-child <epic>` and `<epic> in:body` queries, with the epic ref fully qualified so cross-repo `#N` collisions can't slip in.

Downstream callers (`shared/scoping.ts`'s `Scope.issues`, `status.ts`, `watch.ts`, `watch/poll-loop.ts`) update to the new shape in the same PR; `@generacy-ai/cockpit` is bumped 0.1.0 → 0.2.0 (pre-1.0 minor for breaking change). New `cockpit.repos` plumbing flows into `resolveEpicIssues` via a new option.

## Technical Context

**Language/Version**: TypeScript 5.4 (ESM), Node >=22
**Primary Dependencies**: `zod` (manifest schema, no change), `yaml` (manifest IO, no change), no new deps
**Storage**: N/A — purely an in-memory transformation over manifest YAML + `gh` CLI output
**Testing**: `vitest` in `packages/cockpit` and `packages/generacy`; existing tests at `packages/cockpit/src/__tests__/manifest-scoping.test.ts` and `packages/generacy/src/cli/commands/cockpit/__tests__/shared.scoping.test.ts`
**Target Platform**: CLI (`@generacy-ai/generacy`) on developer workstations + CI; library (`@generacy-ai/cockpit`) consumed by the CLI only
**Project Type**: Library + CLI consumer in the same monorepo (pnpm workspaces)
**Performance Goals**: Per-epic resolution stays bounded by `|cockpit.repos ∪ {epicRepo}| × 2` `gh search` calls (worst case). For the configured cockpit (~5 repos), that's ≤ 10 calls — same order as today's 2.
**Constraints**: Public API change to `@generacy-ai/cockpit` — all in-repo consumers updated in the same PR (FR-007). No out-of-repo consumers exist.
**Scale/Scope**: One epic's children resolved at a time; typical N ≤ ~30 child issues. The change does not affect `cockpit watch`'s poll cadence or `gh` rate envelope per poll.

## Constitution Check

No `.specify/memory/constitution.md` is present in this repository — no constitutional gates apply. Project-level conventions observed:

- **Pre-1.0 minor bump for breaking package API**: Q5 explicitly endorses `0.1.0 → 0.2.0`. Consistent with prior cockpit changes in this repo.
- **In-repo consumers updated in same PR**: All four consumers of `resolveEpicIssues` (`shared/scoping.ts`, `status.ts`, `watch.ts`, `watch/poll-loop.ts`) ship in the same PR. No deprecation period needed.
- **No new dependencies**: Implementation stays inside existing `zod`/`yaml`/`gh` surface area.

No violations to track in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/801-found-dogfooding-cockpit-its/
├── spec.md              # Existing (do not modify)
├── clarifications.md    # Existing (Q1–Q5 answered)
├── plan.md              # This file
├── research.md          # Phase 0 — decisions + rationale
├── data-model.md        # Phase 1 — IssueRef type, Scope shape
├── quickstart.md        # Phase 1 — repro + verification commands
├── contracts/
│   ├── resolveEpicIssues.ts    # Phase 1 — new function signature
│   └── scope.ts                # Phase 1 — updated Scope discriminated union
├── checklists/                  # Reserved for /speckit:checklist
└── tasks.md             # Phase 2 — /speckit:tasks output (not in this command)
```

### Source Code (repository root)

Affected files only (no new files in `src/`; tests added):

```text
packages/cockpit/
├── package.json                                   # version 0.1.0 → 0.2.0
├── src/
│   ├── index.ts                                   # export IssueRef type
│   ├── manifest/
│   │   └── scoping.ts                             # core change: new signature + cross-repo fallback
│   └── __tests__/
│       └── manifest-scoping.test.ts               # updated to new shape + new cases (FR-008)

packages/generacy/
└── src/cli/commands/cockpit/
    ├── shared/scoping.ts                          # Scope.issues: number[] → IssueRef[]
    ├── status.ts                                  # iterate per-issue-ref, repo from ref
    ├── watch.ts                                   # unchanged wiring, scope shape change flows through
    ├── watch/poll-loop.ts                         # repos = unique(scope.issues.map(r → r.repo))
    └── __tests__/
        ├── shared.scoping.test.ts                 # updated to new shape
        └── watch.epic-walk.test.ts                # add cross-repo case
```

**Structure Decision**: Library + single in-repo consumer (the CLI). No new top-level directories. All edits are local to `packages/cockpit/` and `packages/generacy/src/cli/commands/cockpit/`. Public API surface change is confined to one function (`resolveEpicIssues`) and one type export (`IssueRef`).

## Phase Outline

(Detailed task list lives in `tasks.md` after `/speckit:tasks` runs.)

- **Phase 0 — Research** (`research.md`): Pin the cross-repo query construction (Q4-A), fallback scope semantics (Q3-A), and return shape (Q1-A). Confirm no test fixture changes are needed beyond the new cases.
- **Phase 1 — Design** (`data-model.md`, `contracts/`, `quickstart.md`): Fix the `IssueRef` type shape, the new `resolveEpicIssues` signature accepting an optional `repos: string[]` and emitting `IssueRef[]`, and the consumer-side `Scope` update.
- **Phase 2 — Tasks** (`tasks.md`, produced by `/speckit:tasks`): Ordered task list covering library change → consumer updates → tests → version bump → manual verification (SC-001 / SC-002).

## Complexity Tracking

> No Constitution Check violations to justify.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| _(none)_  | _(n/a)_    | _(n/a)_                              |

---

*Generated by speckit*
