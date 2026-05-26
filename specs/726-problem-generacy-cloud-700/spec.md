# Feature Specification: Handle `tier-limit-exceeded` PollResponse Variant

**Branch**: `726-problem-generacy-cloud-700` | **Date**: 2026-05-26 | **Status**: Draft
**Issue**: [generacy-ai/generacy#726](https://github.com/generacy-ai/generacy/issues/726)
**Workflow**: speckit-bugfix

## Summary

The cloud's `pollDeviceCode` endpoint (generacy-cloud#700, merged as #704) returns a new `tier-limit-exceeded` response variant when a cluster activation exceeds the org's tier worker cap. The cluster-side `@generacy-ai/activation-client` package was never updated with the matching discriminated-union variant, so the response fails Zod validation and crashes with an unhelpful `ZodError` instead of the intended "exceeds your <tier> plan limit of <cap>" message.

This is mostly latent because the CLI's `worker-count-resolver` (generacy-cloud#699) blocks over-cap launches before the poll loop starts. The remaining surface is defense-in-depth: older CLIs, tier-change races between launch-config and poll, and custom clients.

## Problem

- `packages/activation-client/src/types.ts` — `PollResponseSchema` is a `z.discriminatedUnion('status', ...)` covering only `authorization_pending | slow_down | expired | approved`. Missing the new `tier-limit-exceeded` variant.
- `packages/activation-client/src/poller.ts` — `switch (response.status)` covers the same four statuses with no `tier-limit-exceeded` case.
- CLI consumer in `packages/generacy/src/cli/commands/launch/` does not branch on `tier-limit-exceeded` to print a user-facing error.

When the cloud returns the new variant, Zod parsing fails before the poller's switch is reached. The user sees a schema-validation crash instead of the clean tier-limit error the cloud was designed to deliver.

## User Stories

### US1: Clean tier-limit error during activation

**As a** Generacy user running `generacy launch` with worker count exceeding my org's tier cap (in the rare case the CLI pre-check is bypassed),
**I want** the CLI to print a clear "Worker count of X exceeds your <tier> plan limit of N" message and exit non-zero,
**So that** I understand exactly why activation failed and what to do (upgrade or reduce workers) without filing a bug report about an unintelligible Zod stacktrace.

**Acceptance Criteria**:
- [ ] When the cloud returns `{ status: 'tier-limit-exceeded', cap, requested, tier }`, the cluster-side Zod parse succeeds.
- [ ] `pollForApproval` returns the response without further polling (treated as terminal, like `approved`/`expired`).
- [ ] CLI prints `Worker count of <requested> exceeds your <tier> plan limit of <cap>. Upgrade your plan or retry with --workers=<cap>.` and exits non-zero.
- [ ] Existing `approved` / `expired` / `authorization_pending` / `slow_down` paths are unchanged.

### US2: Forward-compatible activation client

**As a** maintainer of `@generacy-ai/activation-client`,
**I want** the `PollResponseSchema` discriminated union to mirror every variant the cloud's `pollDeviceCode` returns,
**So that** the contract between cluster and cloud stays explicit and a regression test catches future drift.

**Acceptance Criteria**:
- [ ] A regression test in `packages/activation-client/__tests__/poller.test.ts` covers the `tier-limit-exceeded` variant (parse + return-terminal behavior).
- [ ] The `PollResponse` TS type union includes the new variant with `cap: number`, `requested: number`, `tier: string` metadata fields.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `tier-limit-exceeded` variant to `PollResponseSchema` discriminated union in `packages/activation-client/src/types.ts` with fields `cap: z.number().int().min(0)`, `requested: z.number().int().min(1)`, `tier: z.string()`. | P1 | Mirrors generacy-cloud#700 response shape. |
| FR-002 | Add `case 'tier-limit-exceeded': return response;` to the switch in `packages/activation-client/src/poller.ts`. Terminal state (no further polling). | P1 | Same handling pattern as `approved` and `expired`. |
| FR-003 | CLI consumer of `pollForApproval` (in `packages/generacy/src/cli/commands/launch/`) branches on `result.status === 'tier-limit-exceeded'` and prints the user-facing tier-limit error before exiting non-zero. | P1 | Reuse `worker-count-resolver`'s error formatter if shapes match. |
| FR-004 | Regression test in `packages/activation-client/__tests__/poller.test.ts` covers: (a) Zod parse of the new variant succeeds, (b) `pollForApproval` returns terminal without re-polling, (c) response metadata fields (cap, requested, tier) preserved end-to-end. | P1 | |
| FR-005 | The four pre-existing variants (`authorization_pending`, `slow_down`, `expired`, `approved`) continue to parse and route through their existing code paths with no behavior change. | P1 | Regression guard. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Zod validation of `tier-limit-exceeded` response | 0 ZodError crashes | Unit test parses the variant successfully. |
| SC-002 | CLI exit behavior on tier-limit response | Non-zero exit, single-line user-facing error | Integration test (or manual repro) confirms message + exit code. |
| SC-003 | Regression: existing variant behavior | All four pre-existing poller tests pass unchanged | `pnpm test --filter @generacy-ai/activation-client` green. |
| SC-004 | Schema drift coverage | 1 new test in `poller.test.ts` covering the new variant | Test file diff. |

## Assumptions

- The cloud's `tier-limit-exceeded` response shape matches the issue exactly: `{ status: 'tier-limit-exceeded', cap: number, requested: number, tier: string }`. Confirmed via generacy-cloud#700 / #704.
- The CLI's existing `worker-count-resolver` already has a user-facing error formatter that can be reused (or its message text is the canonical wording for tier-limit errors).
- `tier-limit-exceeded` is a terminal state, not retryable. Bumping the plan or reducing `--workers` requires a fresh launch run, not a continued poll.

## Out of Scope

- Bumping the `@generacy-ai/activation-client` package version or coordinating a release. Versioning handled separately.
- Changes to the cloud-side schema or `pollDeviceCode` endpoint. Already shipped in generacy-cloud#704.
- Modifications to `worker-count-resolver`'s pre-poll gating logic (generacy-cloud#699 / launch-config `tierCap`). This issue only addresses the residual poll-time path.
- Refactoring the CLI launch command structure or activation flow beyond adding the new error branch.

## Related

- [generacy-cloud#700](https://github.com/generacy-ai/generacy-cloud/issues/700) — cloud-side change this completes.
- [generacy-cloud#699](https://github.com/generacy-ai/generacy-cloud/issues/699) — exposes `tierCap` in launch-config so the CLI rejects most over-cap launches *before* the poll path is reached.

---

*Generated by speckit*
