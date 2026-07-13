# Implementation Plan: Cockpit CLI identity resolution for App-credentialed clusters

**Feature**: Add a single `resolveCockpitIdentity()` helper that mirrors `packages/orchestrator/src/services/identity.ts` (flag → config → `CLUSTER_GITHUB_USERNAME` → `GH_USERNAME` → `gh api user`), route `cockpit queue` through it in "required" mode and `cockpit advance` in "optional" mode, and add `assignee?: string` to `CockpitConfigSchema` so `.generacy/config.yaml`'s `cockpit:` block can pin the identity.
**Branch**: `830-found-during-cockpit-v1`
**Status**: Complete
**Date**: 2026-07-07
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md) (Batch 1, Q1–Q4)
**Input**: Feature specification at `/specs/830-found-during-cockpit-v1/spec.md`

## Summary

Four coordinated edits + one new file eliminate the `gh api user` 403 on GitHub App-credentialed clusters:

1. **`packages/generacy/src/cli/commands/cockpit/shared/identity.ts`** — NEW. `resolveCockpitIdentity({ flag, configAssignee, gh, logger, mode })` with precedence identical to `orchestrator/services/identity.ts` (Q1→A): (1a) `--assignee` flag → (1b) `cockpit.assignee` config → (2a) `CLUSTER_GITHUB_USERNAME` → (2b) `GH_USERNAME` → (3) `gh api user`. Two modes: `'required'` throws `LoudIdentityError` when all sources fail; `'optional'` logs a warning and returns `undefined`. Both error paths name all four knobs (`--assignee`, `cockpit.assignee`, `CLUSTER_GITHUB_USERNAME`, `GH_USERNAME`) — Q1→A, precise-over-short.
2. **`packages/cockpit/src/config/schema.ts`** — MODIFIED. Add `assignee: z.string().min(1).optional()` to `CockpitConfigSchema`. Loader (`config/loader.ts`) already reads the whole `cockpit:` block through the schema — no loader change needed. `LoadedCockpitConfig.config.assignee` becomes readable by all cockpit callers (Q2→A, FR-007).
3. **`packages/generacy/src/cli/commands/cockpit/queue.ts`** — MODIFIED. Delete the direct `cockpitGh.getCurrentUser()` block at lines 297–309. Replace with `resolveCockpitIdentity({ flag: opts.assignee, configAssignee: config.assignee, gh: cockpitGh, logger: ..., mode: 'required' })`. Ensure `loadCockpitConfig()` is called ahead of the resolution (queue does not currently load config — add the load at command entry, near the existing `resolveIssueContext` call).
4. **`packages/generacy/src/cli/commands/cockpit/advance.ts`** — MODIFIED. Delete the direct `gh.getCurrentUser()` block at lines 135–141. Replace with `resolveCockpitIdentity({ flag: undefined, configAssignee: config.assignee, gh, logger: ..., mode: 'optional' })`. When the return is `undefined`, pass `actor: undefined` into `formatManualAdvanceComment(...)`; that formatter must gain an "omit actor line if undefined" branch. Label + gate transition happen unconditionally (FR-003).
5. **`packages/generacy/src/cli/commands/cockpit/manual-advance-marker.ts`** — MODIFIED. `formatManualAdvanceComment({ gate, actor?: string, ts })`: when `actor` is `undefined` or empty, the rendered comment omits the `actor:` line entirely (no `actor: unknown` placeholder). Contract in `contracts/manual-advance-marker.md`.

Zero changes to `packages/orchestrator/src/services/identity.ts` (already correct — we mirror it, do not touch it). Zero changes to non-cockpit CLI subcommands (Out of Scope).

FR-006 investigation is a **runtime deliverable**, not a code change: the implementer greps `webhooks.ts` for its no-assignee guard, compares against `smee-receiver`'s skip path, and posts a comment on issue #830 tagged `"FR-006 investigation"` recording the finding (Q4→B). If divergence is found, the comment additionally links a filed follow-up issue.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js >=22 (matches `packages/generacy` `engines.node`). ESM output under `dist/`.
**Primary Dependencies**: Existing `@generacy-ai/cockpit` (`GhCliWrapper`, `loadCockpitConfig`, `CockpitConfigSchema`), `zod` (schema extension), `commander` (already wired for `--assignee`). No new runtime deps.
**Storage**: None. `resolveCockpitIdentity` is a pure async function whose only side effect is (tier 3) invoking `gh api user` via `GhWrapper.getCurrentUser()`.
**Testing**: `vitest` in `packages/generacy/src/cli/commands/cockpit/__tests__/`. New `__tests__/shared/identity.test.ts` for the helper (each precedence tier + each failure mode, per FR-005/SC-004). `queue.test.ts` and `advance.test.ts` gain scenarios covering the App-credentialed + env-driven happy path (SC-001, SC-002). `packages/cockpit/src/__tests__/config/loader.test.ts` extends for `assignee` field round-trip through YAML.
**Target Platform**: Any environment where the `generacy` CLI runs — dev laptop, cluster orchestrator container, CI runner. On staging/production clusters (v1.5 wizard flow) `CLUSTER_GITHUB_USERNAME` and/or `GH_USERNAME` are exported by cluster-base (existing assumption — no new env plumbing).
**Project Type**: Cross-package edit, two packages. `packages/cockpit` gains one Zod field. `packages/generacy` gains one shared helper module + wires two verbs (queue, advance) + updates one formatter (manual-advance-marker).
**Performance Goals**:
- No perf-relevant paths. Tier 3 (`gh api user`) fires at most once per verb invocation, only when tiers 1a/1b/2a/2b all miss.
- On App-credentialed clusters where tier 2a or 2b hits, zero `gh` subprocess is spawned for identity — the 403 latency (~500ms remote round-trip + connection setup) is eliminated on the happy path (SC-001).
**Constraints**:
- **Behavioral parity with orchestrator.** SC-006 requires the helper to resolve the same identity `services/identity.ts` would, given the same inputs — verified by a table-driven test. Q1→A.
- **Precise-over-short error copy.** Error and warning messages must name **all four** knobs (`--assignee`, `cockpit.assignee`, `CLUSTER_GITHUB_USERNAME`, `GH_USERNAME`). SC-004. An operator who set `GH_USERNAME` and gets an error naming only `CLUSTER_GITHUB_USERNAME` will conclude the mechanism is broken.
- **Flag beats config within tier 1.** Standard CLI convention (Q3→A). The whole chain stays monotonic in explicitness.
- **Field-and-reader together.** `cockpit.assignee` in the schema AND used by the helper land in the same PR — no dead surface (Q2→A).
- **No direct `gh api user` in cockpit subcommands.** SC-003: `rg 'getCurrentUser|gh api user' packages/generacy/src/cli/commands/cockpit/` must count 1 (the helper's tier-3 call). All other call sites route through the helper.
- **Advance never blocks on identity.** FR-003 / SC-002: label + transition complete even when the actor line is omitted. Cosmetic degradation, not fatal.
- **Untouched: orchestrator.** The behavioral copy target (`services/identity.ts`) stays byte-identical. Out of Scope explicitly forbids the extract-to-shared-package refactor here.
**Scale/Scope**: 1 new file (~120 LOC helper), 4 modified files (~40 net LOC across queue/advance/marker/schema), ~150 LOC of new tests. Two packages touched: `packages/cockpit` (schema only) and `packages/generacy` (helper + verbs + marker + tests).

## Constitution Check

No `.specify/memory/constitution.md` present in this repo. No gates to evaluate. Constitution check **PASS** (vacuously).

## Project Structure

### Documentation (this feature)

```text
specs/830-found-during-cockpit-v1/
├── spec.md                                             # already authored
├── clarifications.md                                   # already authored (Batch 1, Q1–Q4)
├── plan.md                                             # THIS FILE
├── research.md                                         # decision rationale
├── data-model.md                                       # interface deltas + call graph
├── quickstart.md                                       # local repro / validation
└── contracts/
    ├── resolve-cockpit-identity.md                     # helper contract (signature, precedence, error semantics)
    └── manual-advance-marker.md                        # updated formatter contract (optional actor)
```

`tasks.md` is produced by `/speckit:tasks`, not this command.

### Source Code (repository monorepo)

```text
packages/cockpit/src/config/
├── schema.ts                                           # MODIFIED — add `assignee: z.string().min(1).optional()` to CockpitConfigSchema
└── loader.ts                                           # UNCHANGED — already round-trips the whole cockpit block through the schema
packages/cockpit/src/__tests__/config/
└── loader.test.ts                                      # MODIFIED — add coverage for `assignee` key round-trip

packages/generacy/src/cli/commands/cockpit/
├── shared/
│   └── identity.ts                                     # NEW — resolveCockpitIdentity() + LoudIdentityError, mirrors orchestrator/services/identity.ts precedence
├── queue.ts                                            # MODIFIED — call loadCockpitConfig once; delete direct getCurrentUser block; call resolveCockpitIdentity mode:'required'
├── advance.ts                                          # MODIFIED — delete direct getCurrentUser block; call resolveCockpitIdentity mode:'optional'; pass optional actor to formatter
├── manual-advance-marker.ts                            # MODIFIED — actor param becomes optional; omit "actor:" line when undefined
└── __tests__/
    ├── shared/
    │   └── identity.test.ts                            # NEW — precedence table (matches services/identity.ts), each failure mode, message content per SC-004/SC-006
    ├── queue.test.ts                                   # MODIFIED — App-cred cluster happy path (env only), missing-all failure with SC-004 message
    ├── advance.test.ts                                 # MODIFIED — App-cred cluster happy path (env only), missing-all warn+degrade (label still applied, actor line omitted)
    └── manual-advance-marker.test.ts                   # MODIFIED (may need to create) — optional actor rendering

# UNTOUCHED
packages/orchestrator/src/services/identity.ts          # behavioral source of truth — mirrored, not touched (Out of Scope)
```

### Runtime deliverable (not a code change)

```text
issue #830 comment                                      # FR-006 investigation writeup, tagged "FR-006 investigation"
                                                        # Both branches: "no divergence found" AND "divergence + follow-up filed"
                                                        # Location per Q4→A
```

## Implementation Phases

Rough order — tasks.md will enumerate concrete steps.

1. **Schema first.** Add `assignee` to `CockpitConfigSchema`. Extend loader test to prove the field round-trips through `.generacy/config.yaml`. This unblocks tier-1b in the helper.
2. **Build the helper in isolation.** Create `shared/identity.ts` + `shared/identity.test.ts`. Test table copied from `services/identity.ts` per SC-006. Table exercises: flag-only, config-only, flag-beats-config, CLUSTER_GITHUB_USERNAME-only, GH_USERNAME-only, CLUSTER_GITHUB_USERNAME-beats-GH_USERNAME, gh-api-fallback, all-missing (required → throws with 4-knob message; optional → warns and returns undefined).
3. **Wire `queue.ts`.** Add `loadCockpitConfig` call, replace the direct `getCurrentUser` block with `resolveCockpitIdentity(..., mode: 'required')`. Extend `queue.test.ts` with the two App-cred scenarios.
4. **Wire `advance.ts` + `manual-advance-marker.ts`.** Make `actor` optional in the formatter (add a test), then replace the direct `getCurrentUser` block in `advance.ts` with `resolveCockpitIdentity(..., mode: 'optional')`. Extend `advance.test.ts` with the two App-cred scenarios (env-set happy path + missing-all degrade).
5. **SC-003 grep guard.** Confirm `rg 'getCurrentUser|gh api user' packages/generacy/src/cli/commands/cockpit/` returns exactly one match (the helper's tier-3 call). Fix any escapes before opening the PR.
6. **FR-006 investigation deliverable.** During or after the code work, grep `webhooks.ts` for the no-assignee guard, compare with `smee-receiver`'s skip path, and post the finding as a comment on issue #830 tagged `"FR-006 investigation"`. File a follow-up issue only if divergence is found; the comment links it if so.

## Complexity Tracking

| Concern | Notes |
|---|---|
| Cross-package touch | Two packages modified: `packages/cockpit` (schema field) and `packages/generacy` (helper + verbs). Necessary because tier-1b requires the config key to be readable via the shared config loader. Loader is untouched — only the schema field is added — so the blast radius on `@generacy-ai/cockpit` is one Zod field. |
| Duplication of orchestrator precedence | Deliberate. SC-006 gives us a mechanical check (table copied from `identity.ts`). The shared-package extraction is documented Out of Scope; behavioral identity is the requirement now. Two implementations with subtly different precedence is exactly the drift bug this issue exposes — SC-006's table guards against re-introducing it. |
| Optional actor in marker | The formatter change is small (~5 LOC) but has to be its own tested unit because `advance.ts` is the only caller today; making `actor` optional here is a public-shape change for the formatter. Contract in `contracts/manual-advance-marker.md`. |
| Loading cockpit config in `queue.ts` | `queue` does not currently call `loadCockpitConfig`. Adding it introduces an on-startup YAML parse. This is the same cost `advance` already pays — no observable perf hit. |
