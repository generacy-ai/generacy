# Implementation Plan: Fix double-space in `formatTierLimitError` when tier name is unknown

**Feature**: Make `formatTierLimitError` omit the tier-name segment when `tier` is empty, eliminating the stray double space that surfaces from the resolver-side over-cap error path.
**Branch**: `728-symptom-cli-s-resolver`
**Status**: Complete
**Spec**: [spec.md](./spec.md)
**Issue**: [#728](https://github.com/generacy-ai/generacy/issues/728)

## Summary

The CLI's resolver-side tier-limit gate (`worker-count-resolver.ts`) renders a malformed error message — `"...exceeds your  plan limit..."` — because it passes `tier: ''` into `formatTierLimitError`, which title-cases the empty string and leaves a literal stray space in the template. This is the dominant over-cap error path (~99% of cases; runs before any cloud poll).

The fix is a one-line conditional inside `packages/activation-client/src/format-tier-limit-error.ts`: when `tier` is falsy, emit `"your plan limit of ..."`; otherwise emit `"your <Tier> plan limit of ..."`. No call-site changes anywhere. The empty-tier unit test is updated to assert the well-formed output rather than codifying the bug.

## Technical Context

**Language/Version**: TypeScript 5.x (ESM, Node >=22 at the CLI consumer)
**Primary Dependencies**: None — pure-function string formatting. Tests use `vitest`.
**Storage**: N/A
**Testing**: `vitest` — `packages/activation-client/tests/unit/format-tier-limit-error.test.ts`
**Target Platform**: Cross-platform (Node ≥22). Consumed by the `generacy` CLI (`worker-count-resolver.ts`), the orchestrator's activation flow, and the `deploy` command.
**Project Type**: Library package within a pnpm monorepo (`packages/activation-client`).
**Performance Goals**: N/A (pure function, microsecond-scale, runs at most once per launch).
**Constraints**: Must not change the `TierLimitErrorInput` shape (`tier: string`) — Spec FR-004 forbids call-site changes. Function must remain pure.
**Scale/Scope**: ~3 LOC of source change in one file; one test assertion update; zero new files.

## Constitution Check

No `.specify/memory/constitution.md` file exists in this repository, so there are no constitution gates to evaluate. The change is intrinsically aligned with general repo norms (small surface, no new deps, preserves the existing pure-function contract).

## Project Structure

### Documentation (this feature)

```text
specs/728-symptom-cli-s-resolver/
├── spec.md            # Existing — feature specification
├── plan.md            # This file
├── research.md        # Phase 0 — formatter shape decision + rationale
├── data-model.md      # Phase 1 — TierLimitErrorInput / output contract
├── quickstart.md      # Phase 1 — how to validate the fix locally
└── conversation-log.jsonl  # Existing — clarify-phase log
```

No `contracts/` directory is created: the public interface (`TierLimitErrorInput`, function signature, return type) is unchanged. This is a behavioral fix inside an existing pure function.

### Source Code (repository root)

```text
packages/activation-client/
├── src/
│   └── format-tier-limit-error.ts          # CHANGE: conditional tier-name segment
└── tests/
    └── unit/
        └── format-tier-limit-error.test.ts # CHANGE: update empty-tier assertion
                                            # ADD: regression test asserting no double space
```

Files explicitly NOT changed (per spec FR-004 / Out of Scope):

```text
packages/generacy/src/cli/commands/launch/worker-count-resolver.ts  # caller — unchanged
packages/orchestrator/src/activation/**                              # caller — unchanged
packages/generacy/src/cli/commands/deploy/**                         # caller — unchanged
```

**Structure Decision**: Single-package change inside `packages/activation-client`. The package already houses the shared formatter, its tests, and the relevant `TierLimitErrorInput` type. No new packages, modules, or files are needed.

## Complexity Tracking

No constitution violations; no justified complexity. The fix is strictly subtractive in behavior (removes a stray space) and additive only in a single conditional branch.
