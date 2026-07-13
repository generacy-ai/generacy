# Implementation Plan: Single-source epic discovery (G-S2)

**Feature**: Replace two-tier manifest+label-search discovery with a single engine resolver that parses the epic issue body
**Branch**: `806-epic-generacy-ai-tetrad`
**Date**: 2026-07-06
**Status**: Complete
**Spec**: [spec.md](./spec.md)

## Summary

Collapse `cockpit watch|status|queue` onto one discovery mechanism: an engine resolver that parses the epic issue body — task-list refs (`- [ ]`/`- [x]`) grouped under `### <phase>` headings — and fails loud with the expected format when nothing parses. Repos derive from the parsed refs (no `--repos`, no `cockpit.repos`, no `MONITORED_REPOS`). `watch` re-resolves the epic body every poll tick so children added mid-epic join automatically. `queue` becomes `queue <epic-ref> <phase>`, with `--label` overriding the default `process:speckit-feature`. Delete the manifest read path, label-search fallback, manifest CLI verbs, and the `repos` config coupling entirely — no fallback path remains.

## Technical Context

**Language/Version**: TypeScript 5.x, ESM, Node >=22
**Primary Dependencies**: `commander`, `zod`, `@clack/prompts`, existing `@generacy-ai/cockpit` GhWrapper (no new runtime deps)
**Storage**: None on disk (the epic body on GitHub is now the sole source of truth for the child set)
**Testing**: Vitest — colocated `__tests__/` in each package (existing convention)
**Target Platform**: Node CLI (invoked as `generacy cockpit …`)
**Project Type**: Two-package feature isolated inside the pnpm workspace (`packages/cockpit`, `packages/generacy`)
**Performance Goals**: One `gh issue view <epic>` per poll tick + existing per-repo listing already performed by `runOnePoll`. Default 30 s tick, floor 15 s (FR-007).
**Constraints**:
- Isolation: only touch `packages/cockpit/src/manifest/**` and `packages/generacy/src/cli/commands/cockpit/{watch*,status*,queue.ts,manifest*,shared/scoping.ts}` (spec "Owns" clause).
- No YAML manifest read/write anywhere in the watch/status/queue paths (SC-005).
- `stdout` in `watch` reserved for the NDJSON event stream; all diagnostics and clamp warnings go to `stderr` (Q4).
- Fail-loud on unparseable body (FR-006 / SC-003); no silent fallback (this is the rev-3 regression target).
**Scale/Scope**: Single-digit repos, tens of child issues per epic, one long-running `watch` process per operator.

## Constitution Check

No `.specify/memory/constitution.md` file exists in this repo. Spec is bound by plan rev 3 principle 1 ("single discovery mechanism") documented in the epic — the design here honours that principle by deleting the second mechanism outright rather than gating it behind a flag.

## Project Structure

### Documentation (this feature)

```text
specs/806-epic-generacy-ai-tetrad/
├── spec.md              # feature spec (read-only)
├── clarifications.md    # Q1–Q5 answers
├── plan.md              # this file
├── research.md          # design decisions (see below)
├── data-model.md        # resolver types
├── quickstart.md        # zero-config bring-up walkthrough
├── contracts/
│   ├── resolver.md      # engine resolver contract
│   └── cli.md           # watch/status/queue CLI contracts
└── conversation-log.jsonl
```

### Source Code (repository root)

Files created:

```text
packages/cockpit/src/resolver/
├── parse-epic-body.ts       # NEW — pure parser: heading walk + ref extraction + normalization
├── ref-shapes.ts            # NEW — bare / markdown-link / URL variant recognizers
├── heading-match.ts         # NEW — case-insensitive first-token phase match (FR-005)
├── resolve.ts               # NEW — top-level resolver: gh issue view → parse → { phases[], refs[] }
└── errors.ts                # NEW — LoudResolverError with expected-format message (FR-006)

packages/cockpit/src/resolver/__tests__/
├── parse-epic-body.test.ts
├── ref-shapes.test.ts
├── heading-match.test.ts
└── resolve.test.ts
```

Files modified:

```text
packages/cockpit/src/index.ts                             # export resolver public API; drop manifest exports
packages/cockpit/src/config/schema.ts                     # drop `repos` field
packages/cockpit/src/config/loader.ts                     # drop MONITORED_REPOS coupling and repos loader
packages/generacy/src/cli/commands/cockpit/watch.ts       # drop --repos; call resolver each tick; interval default 30_000, floor 15_000 clamp+warn
packages/generacy/src/cli/commands/cockpit/status.ts      # drop --repos; call resolver once; --epic required
packages/generacy/src/cli/commands/cockpit/queue.ts       # queue <epic-ref> <phase> [--label]; membership from heading
packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts  # take resolver instead of pre-resolved Scope
packages/generacy/src/cli/commands/cockpit/index.ts       # unregister `manifest` subcommand
```

Files deleted (SC-005 grep check):

```text
packages/cockpit/src/manifest/**                          # schema.ts, io.ts, scoping.ts
packages/generacy/src/cli/commands/cockpit/manifest.ts    # manifest command entry
packages/generacy/src/cli/commands/cockpit/manifest/**    # derive-slug, diff-phases, extract-plan, parse-epic-body, resolve-manifest-path
packages/generacy/src/cli/commands/cockpit/shared/scoping.ts  # replaced by direct resolver call
# tests under packages/cockpit/src/__tests__/manifest/** and packages/generacy/src/cli/commands/cockpit/__tests__/manifest/**
```

**Structure Decision**: Two-package isolation. The resolver lives in `packages/cockpit` (library) so both `watch` and `status` can share it and so it is unit-testable without a Commander harness. The CLI files in `packages/generacy` become thin adapters over the resolver.

## Phase 0 — Research (see research.md)

Decisions locked before implementation:

- Ref shape normalization set (bare / `[owner/repo#N](…)` / plain URL) and the shorthand exclusion (Q3).
- Parser state machine: line-oriented walk, level-3 headings only, first-token match (FR-005).
- Where the resolver reads the epic body (`gh issue view --json body` via existing `GhWrapper`) — deferred from GraphQL to keep the wrapper thin.
- Interval clamping semantics: default 30 s, floor 15 s, below-floor → stderr warn + clamp + continue (Q4).
- Deletion ordering (manifest CLI first, then resolver call sites, then config schema) to keep intermediate commits compiling.

## Phase 1 — Design

### Data model (see data-model.md)

Core types added to `packages/cockpit/src/resolver/`:

- `IssueRef` — reused from existing type; `{ repo: 'owner/repo'; number: number }`.
- `ParsedPhase` — `{ heading: string; token: string; refs: IssueRef[] }`; `token` is the FR-005 first-word key.
- `ParsedEpicBody` — `{ phases: ParsedPhase[]; allRefs: IssueRef[] }`; `allRefs` is the deduped union used by `watch`/`status`.
- `ResolveEpicOptions` / `ResolvedEpic` — output of `resolve.ts`, including the raw body hash for change detection (nice-to-have; not required by spec).

### Contracts (see contracts/)

- `resolver.md` — pure-function contract for `parseEpicBody(body: string): ParsedEpicBody` and `resolveEpic({ epicRef, gh }): Promise<ResolvedEpic>`; loud-failure taxonomy (empty body / no headings / no refs / ambiguous phase token / unresolved ref-shaped line).
- `cli.md` — `watch <epic-ref>`, `status <epic-ref>`, `queue <epic-ref> <phase> [--label]` flag surface and exit codes. `--repos` and `cockpit.repos` are removed and produce loud unknown-option errors (Commander default).

### Wiring changes

- `watch` loop: replace the pre-computed `Scope` with a `resolveEpic()` call at the top of every poll tick. `runOnePoll` accepts the resolved refs instead of a `Scope`. On resolver error, log to stderr and skip the tick (do not exit; a transient GitHub error should not kill a long watch).
- `status`: `--epic` becomes required. Repos derive from the resolver output; no `--repos` flag.
- `queue`: adds required `<phase>` positional. `--label` defaults to `process:speckit-feature` (was hard-coded). Uses `resolveEpic` + `matchPhaseHeading(token)` (FR-005). Ineligible refs (closed / already-labeled) still skipped at preview time (existing eligibility logic reused).
- `interval`: default `30_000`, floor `15_000`. Below-floor → `stderr` warn (`cockpit watch: --interval <N> below floor 15000ms; clamping.`) + clamp + continue (FR-007 / SC-006).

## Complexity Tracking

No constitution violations. One judgement call worth calling out:

| Choice | Why | Alternative rejected |
|---|---|---|
| Put the resolver in `packages/cockpit`, not `packages/generacy` | Shared by all three verbs and unit-testable without Commander; matches the existing GhWrapper library seam. | Duplicating it in the CLI would break the "single mechanism" principle and DRY. |
| Fail-loud on ref-shaped lines the resolver can't parse (FR-003) | Silent drop is the rev-3 failure mode (tetrad-development#86). | Silently skipping unparseable lines — matches historical bug we're fixing. |
| Delete `MONITORED_REPOS` env plumbing in the config loader | Spec explicitly names it (FR-009). Keeping it would leave a dead code path that future engineers would re-wire. | Guard it behind a warn — noisy without value. |
