# Implementation Plan: Handle `tier-limit-exceeded` PollResponse Variant

**Feature**: Add the cloud's `tier-limit-exceeded` activation-poll response variant to `@generacy-ai/activation-client`, surface it cleanly at the two real `pollForApproval` consumers (orchestrator boot and `generacy deploy`), and share one `formatTierLimitError` util with the pre-poll `worker-count-resolver` gate so both rejection sites emit identical wording.
**Branch**: `726-problem-generacy-cloud-700`
**Date**: 2026-05-26
**Status**: Complete
**Spec**: [spec.md](./spec.md)
**Issue**: [#726](https://github.com/generacy-ai/generacy/issues/726)
**Companion (already shipped)**: [generacy-cloud#700](https://github.com/generacy-ai/generacy-cloud/issues/700) (merged as [PR #704](https://github.com/generacy-ai/generacy-cloud/pull/704)) — the cloud-side change that introduced this response variant.
**Sibling**: [generacy-cloud#699 / PR #702](https://github.com/generacy-ai/generacy-cloud/pull/702) — exposes `tierCap` in launch-config so the CLI's `worker-count-resolver` rejects most over-cap launches *before* the poll path is reached. This issue closes the residual where #699's gate is bypassed.

## Summary

When the cloud rejects an activation because the org's worker request exceeds its tier cap, it now returns `{ status: 'tier-limit-exceeded', cap, requested, tier }`. The cluster-side poller doesn't know this variant: `PollResponseSchema.parse()` throws `ZodError` before the poller's switch reaches a meaningful branch, so the user sees a schema-validation stack trace instead of the intended "exceeds your Basic plan limit" error.

The fix is small and entirely additive:

1. **Schema** (`packages/activation-client/src/types.ts`): add the new variant to the `PollResponseSchema` discriminated union with `cap: number (int, ≥0)`, `requested: number (int, ≥1)`, `tier: string`.
2. **Poller** (`packages/activation-client/src/poller.ts`): add a `case 'tier-limit-exceeded': return response;` branch alongside `approved` and `expired` — terminal pass-through, no logging (matches existing convention; clarification Q5/A).
3. **Shared formatter** (`packages/activation-client/src/format-tier-limit-error.ts`, new): `formatTierLimitError({ requested, cap, tier })` returns `Worker count of <N> exceeds your <Tier> plan limit of <M>. Upgrade your plan or retry with --workers=<M>.` with title-cased tier name internally (clarification Q3/B, Q4/C).
4. **New `ActivationError` code** (`packages/activation-client/src/errors.ts`): add `'TIER_LIMIT_EXCEEDED'` to the `ActivationErrorCode` union (clarification Q2/A).
5. **Orchestrator caller** (`packages/orchestrator/src/activation/index.ts`): branch on `pollResult.status === 'tier-limit-exceeded'` after `pollForApproval`, throw `new ActivationError(formatTierLimitError(...), 'TIER_LIMIT_EXCEEDED')`. The existing try/catch in `server.ts` catches it and pushes an `error` status via the relay (same flow as `CONTROL_PLANE_WAIT_TIMEOUT`).
6. **Deploy caller** (`packages/generacy/src/cli/commands/deploy/activation.ts`): branch on the same status, `console.error(formatTierLimitError(...))`, `process.exit(1)`.
7. **Pre-poll gate refactor** (`packages/generacy/src/cli/commands/launch/worker-count-resolver.ts`): the existing inline `throw new Error('--workers=N exceeds tier cap of M…')` becomes `throw new Error(formatTierLimitError(...))` so the resolver and the poll-time reject produce identical user-facing strings (clarification Q4/C; eliminates wording drift).

Net diff: ~2 schema fields, ~1 switch case, ~1 new util file, ~3 new branches at consumers, ~1 refactor at the existing CLI gate, plus tests. No new packages; the CLI already has access to `@generacy-ai/activation-client` via the existing workspace (orchestrator consumes it; CLI gains a thin dep edge).

## Technical Context

**Language/Version**: TypeScript (Node >=22, ESM)
**Primary Dependencies**:
- `zod` (extend `PollResponseSchema` discriminated union)
- `@generacy-ai/activation-client` (the schema/poller/error class are all here; orchestrator and CLI both consume it)
- No new runtime deps. The `generacy` CLI workspace package gains `@generacy-ai/activation-client` as a `dependencies` entry — same monorepo workspace, no circular concern.

**Storage**: N/A — purely in-memory wire-format handling.

**Testing**: Vitest. Existing test files:
- `packages/activation-client/tests/unit/poller.test.ts` — extend with `tier-limit-exceeded` cases (schema parse + poller returns without re-polling + no log line).
- `packages/activation-client/tests/unit/types.test.ts` — extend with schema parse case for the new variant.
- New: `packages/activation-client/tests/unit/format-tier-limit-error.test.ts` — title-casing + exact message body.
- `packages/generacy/src/cli/commands/launch/__tests__/worker-count-resolver.test.ts` — update existing over-cap assertions to expect the new shared message.

> **Note**: Spec FR-008 says `packages/activation-client/__tests__/poller.test.ts`; the existing convention in this package is `tests/unit/poller.test.ts`. The test extension lands in the existing location to avoid a parallel test root.

**Target Platform**: Orchestrator container (Node >=22 inside Docker) and developer host running `generacy deploy`. Wire-format consumers only — no UI surface.

**Project Type**: Single monorepo, three packages touched (`activation-client` for schema/poller/formatter/error code; `orchestrator` for the activate() branch; `generacy` for the deploy branch + worker-count-resolver refactor).

**Performance Goals**: N/A — one-shot activation poll, terminal branch.

**Constraints**:
- The new union variant is purely additive on the wire. Older clouds never emit it; the poller works unchanged against pre-#700 clouds. No backwards-compat shim.
- The orchestrator must propagate `ActivationError.code === 'TIER_LIMIT_EXCEEDED'` discriminably so future relay handlers can branch on it (SC-003); this means re-using the existing class with a new code rather than throwing a generic `Error`.
- Tier-name display uses `tier.charAt(0).toUpperCase() + tier.slice(1)`. Mapping table explicitly rejected (clarification Q3/C).
- Wording is the spec's friendlier text (`Worker count of N exceeds your <Tier> plan limit of M. Upgrade your plan or retry with --workers=M.`), which **changes** the existing `worker-count-resolver` over-cap message; that's the explicit goal of refactoring to the shared formatter (clarification Q4/C). Existing test assertions on the old message text update in the same PR.

**Scale/Scope**: ~7 files edited, ~2 new files (formatter + its test). Net diff ~150 LOC including tests.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

No `.specify/memory/constitution.md` exists. CLAUDE.md governs:

- ✅ **Edits existing files**: Schema (`types.ts`), poller (`poller.ts`), errors (`errors.ts`), index re-exports (`index.ts`), orchestrator activate (`activation/index.ts`), deploy activation (`deploy/activation.ts`), CLI gate (`worker-count-resolver.ts`). One new util file (`format-tier-limit-error.ts`) co-located with the schema. One new test file (`format-tier-limit-error.test.ts`) in the existing test root.
- ✅ **No speculative abstractions**: The formatter is a single 6-line pure function; the orchestrator branch is one `if` block + one throw; the deploy branch is one `if` block + `console.error` + `process.exit(1)`. No "error policy" / strategy pattern.
- ✅ **No error handling for impossible states**: Every new branch handles a real boundary (cloud-returned reject status, user-input over-cap). No defensive null checks beyond Zod schema validation.
- ✅ **No backwards-compat shims**: The new union variant is additive; older clouds simply never emit it. No version-gated parsing.
- ✅ **No documentation files unless needed**: This plan + research + data-model + contracts + quickstart are produced by the speckit workflow itself, not ad-hoc docs.
- ✅ **Single bundled change**: One PR covers the schema, the poller, the formatter, the orchestrator branch, the deploy branch, and the CLI gate refactor. Wording-drift elimination only works if all three callsites land together.

## Project Structure

### Documentation (this feature)

```text
specs/726-problem-generacy-cloud-700/
├── spec.md              # Feature spec (read-only)
├── clarifications.md    # Q1–Q5 resolutions
├── plan.md              # This file
├── research.md          # Phase 0 decisions (Q1–Q5 → implementation choices)
├── data-model.md        # Entities: PollResponseSchema (+variant), ActivationErrorCode (+code), TierLimitErrorInput
├── quickstart.md        # End-to-end verification: schema parse → poller → orchestrator throw / deploy exit
├── contracts/
│   ├── poll-response-schema.md         # Extended discriminated union with tier-limit-exceeded variant
│   ├── format-tier-limit-error.md      # Shared formatter signature, output spec, title-casing rule
│   └── activation-error-code.md        # New TIER_LIMIT_EXCEEDED code on the existing class
├── checklists/          # (empty; not populated by /plan)
└── tasks.md             # Generated by /speckit:tasks
```

### Source Code (repository root)

```text
packages/
├── activation-client/                                          # @generacy-ai/activation-client
│   └── src/
│       ├── types.ts                                           # MODIFIED — add tier-limit-exceeded variant to PollResponseSchema
│       ├── poller.ts                                          # MODIFIED — add case 'tier-limit-exceeded': return response; update JSDoc
│       ├── errors.ts                                          # MODIFIED — extend ActivationErrorCode union with 'TIER_LIMIT_EXCEEDED'
│       ├── format-tier-limit-error.ts                         # NEW — formatTierLimitError({ requested, cap, tier }) → string
│       ├── index.ts                                           # MODIFIED — re-export formatTierLimitError
│       └── tests/unit/
│           ├── poller.test.ts                                 # MODIFIED — add tier-limit-exceeded variant case
│           ├── types.test.ts                                  # MODIFIED — add schema parse case for the variant
│           └── format-tier-limit-error.test.ts                # NEW — title-casing + message body
├── orchestrator/                                              # @generacy-ai/orchestrator
│   └── src/activation/
│       └── index.ts                                           # MODIFIED — branch on pollResult.status === 'tier-limit-exceeded' before approved
└── generacy/                                                  # @generacy-ai/generacy (CLI)
    ├── package.json                                           # MODIFIED — add @generacy-ai/activation-client to dependencies
    └── src/cli/commands/
        ├── deploy/
        │   └── activation.ts                                  # MODIFIED — branch on tier-limit-exceeded before approved; console.error + exit(1)
        └── launch/
            ├── worker-count-resolver.ts                       # MODIFIED — replace inline tier-cap throw with formatTierLimitError
            └── __tests__/
                └── worker-count-resolver.test.ts              # MODIFIED — update assertion to match shared message text
```

**Structure Decision**: All shared logic (schema variant, formatter, new error code) lives in `activation-client` — the existing protocol boundary already consumed by both orchestrator and (newly) CLI. Per-caller branches live at each call site, mirroring the existing `approved` / `expired` handling pattern. The `worker-count-resolver` refactor closes the wording-drift gap between the pre-poll gate (host-side, `generacy launch`) and the poll-time reject (cloud-side, fires only when the gate is bypassed).

### Out-of-repo (no changes needed)

```text
generacy-cloud/                                                # GitHub: generacy-ai/generacy-cloud
└── (already shipped #700 / PR #704)                           # Cloud emits the new variant; this issue catches it on the cluster side.
```

## Complexity Tracking

No constitution violations to justify. The change is additive-only at the protocol layer and re-uses the existing `ActivationError` class for consumer-side surfacing.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| (none) | — | — |
