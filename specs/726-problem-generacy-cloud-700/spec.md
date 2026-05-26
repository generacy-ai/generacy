# Feature Specification: Handle `tier-limit-exceeded` PollResponse Variant

**Branch**: `726-problem-generacy-cloud-700` | **Date**: 2026-05-26 | **Status**: Draft

## Summary

The cluster-side activation poller does not recognize the `tier-limit-exceeded` PollResponse variant introduced by [generacy-cloud#700](https://github.com/generacy-ai/generacy-cloud/issues/700). When the cloud emits this terminal status (org's worker request exceeds tier cap), `PollResponseSchema.parse()` throws `ZodError` before the poller's switch reaches a meaningful branch, surfacing as a schema-validation crash instead of the intended user-friendly error.

This change adds the variant to the Zod union, adds a terminal switch case in the poller (silent passthrough, like `approved`/`expired`), and surfaces the error at both real consumers of `pollForApproval`: the orchestrator activation path and the `generacy deploy` command. A shared `formatTierLimitError` util applies the same friendly wording at both the new cloud-reject surface and the pre-existing CLI pre-poll gate in `worker-count-resolver`, with title-cased tier names.

## Problem

[generacy-cloud#700](https://github.com/generacy-ai/generacy-cloud/issues/700) (merged as [#704](https://github.com/generacy-ai/generacy-cloud/pull/704)) extended the cloud's \`pollDeviceCode\` to reject activations that exceed the org's tier worker cap. The new response variant is:

\`\`\`ts
{ status: 'tier-limit-exceeded', cap: number, requested: number, tier: string }
\`\`\`

The Q1=A answer on that issue explicitly noted the cluster-side cluster-side activation poller needs a corresponding union variant added. That companion change didn't land. The current cluster-side state:

- [\`packages/activation-client/src/types.ts:20-32\`](https://github.com/generacy-ai/generacy/blob/develop/packages/activation-client/src/types.ts#L20-L32) — \`PollResponseSchema\` is \`z.discriminatedUnion('status', ...)\` covering only \`authorization_pending | slow_down | expired | approved\`. The new \`tier-limit-exceeded\` variant is missing.
- [\`packages/activation-client/src/poller.ts:40-52\`](https://github.com/generacy-ai/generacy/blob/develop/packages/activation-client/src/poller.ts#L40-L52) — \`switch (response.status)\` covers the same four statuses, no \`tier-limit-exceeded\` case.

When the cloud returns the new variant, the cluster-side Zod parse throws \`ZodError\` before the poller's switch is reached. The user sees a confusing schema-validation crash instead of the clean "exceeds your Basic plan limit of N" error #700 was meant to deliver.

## How latent

Mostly. [generacy-cloud#699](https://github.com/generacy-ai/generacy-cloud/issues/699) (merged as [#702](https://github.com/generacy-ai/generacy-cloud/pull/702)) now exposes \`tierCap\` in launch-config, so the CLI's \`worker-count-resolver\` rejects \`--workers > tierCap\` before the poll loop starts. The cloud's #700 reject path is the defense-in-depth that only fires when the CLI gate is bypassed — older CLIs, race conditions on tier change between launch-config and poll, or custom clients. None are the common path, but all surface as a Zod crash today.

## Fix

Two files, both small.

### \`packages/activation-client/src/types.ts\`

Add the new variant to the discriminated union and re-export the metadata fields:

\`\`\`ts
export const PollResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('authorization_pending') }),
  z.object({ status: z.literal('slow_down') }),
  z.object({ status: z.literal('expired') }),
  z.object({
    status: z.literal('approved'),
    // ...existing approved fields
  }),
  // NEW:
  z.object({
    status: z.literal('tier-limit-exceeded'),
    cap: z.number().int().min(0),
    requested: z.number().int().min(1),
    tier: z.string(),
  }),
]);
\`\`\`

### \`packages/activation-client/src/poller.ts\`

Add a switch case that returns the response without re-polling (it's a terminal state, like \`approved\` and \`expired\`):

\`\`\`ts
switch (response.status) {
  case 'approved':
    return response;
  case 'expired':
    return response;
  case 'tier-limit-exceeded':       // NEW
    return response;
  case 'slow_down':
    intervalMs = Math.min(intervalMs + SLOW_DOWN_INCREMENT_MS, MAX_INTERVAL_MS);
    logger.info(\`Poll interval increased to \${intervalMs / 1000}s\`);
    break;
  case 'authorization_pending':
    break;
}
\`\`\`

### Consumer-side surfacing

\`pollForApproval\` has two real callers, both of which must branch on \`tier-limit-exceeded\`:

1. **Orchestrator boot** — \`packages/orchestrator/src/activation/index.ts:79\` (primary path; runs inside the orchestrator container during \`docker compose up\`).
2. **Deploy command** — \`packages/generacy/src/cli/commands/deploy/activation.ts:59\` (\`generacy deploy <ssh-url>\` BYO-VM path; runs on the user's host).

(Note: the \`launch\` CLI in \`packages/generacy/src/cli/commands/launch/\` does **not** call \`pollForApproval\` directly — it runs \`docker compose up\` and tails logs. Its surface is the orchestrator log stream, which inherits the orchestrator branch automatically.)

**Orchestrator branch** (\`activation/index.ts\`):

\`\`\`ts
if (pollResult.status === 'tier-limit-exceeded') {
  const message = formatTierLimitError({
    requested: pollResult.requested,
    cap: pollResult.cap,
    tier: pollResult.tier,
  });
  throw new ActivationError(message, 'TIER_LIMIT_EXCEEDED');
}
\`\`\`

\`ActivationError\` is the existing error class already used for \`'DEVICE_CODE_EXPIRED'\`. \`'TIER_LIMIT_EXCEEDED'\` is a new code on the same union. The existing try/catch around \`activate()\` in \`server.ts\` catches it and pushes an \`error\` status via the relay (same flow as \`CONTROL_PLANE_WAIT_TIMEOUT\`).

**Deploy branch** (\`deploy/activation.ts\`):

\`\`\`ts
if (pollResult.status === 'tier-limit-exceeded') {
  console.error(formatTierLimitError({
    requested: pollResult.requested,
    cap: pollResult.cap,
    tier: pollResult.tier,
  }));
  process.exit(1);
}
\`\`\`

### Shared error formatter

Both surfaces — and the existing pre-poll gate in \`packages/generacy/src/cli/commands/launch/worker-count-resolver.ts:47-52\` — use a single util:

\`\`\`ts
// packages/activation-client/src/format-tier-limit-error.ts
export function formatTierLimitError({
  requested,
  cap,
  tier,
}: {
  requested: number;
  cap: number;
  tier: string;
}): string {
  const tierTitle = tier.charAt(0).toUpperCase() + tier.slice(1);
  return (
    \`Worker count of \${requested} exceeds your \${tierTitle} plan limit of \${cap}. \` +
    \`Upgrade your plan or retry with --workers=\${cap}.\`
  );
}
\`\`\`

Exported from \`@generacy-ai/activation-client\` (the orchestrator already consumes the package; the CLI gains it as a dep — same workspace).

The inline \`throw new Error(...)\` in \`worker-count-resolver.ts:47-52\` is refactored to call \`formatTierLimitError(...)\` in the same PR, eliminating wording drift between the pre-poll gate and the cloud-side reject.

### Poller-level logging

\`pollForApproval\` stays silent on \`tier-limit-exceeded\` (matches the existing convention — \`approved\` and \`expired\` also return without logging). The JSDoc on \`pollForApproval\` is updated to enumerate \`'tier-limit-exceeded'\` alongside \`'approved'\` and \`'expired'\` as terminal statuses.

## Acceptance

- Cluster receiving \`{ status: 'tier-limit-exceeded', cap, requested, tier }\` from the activation poll parses successfully (no Zod error).
- \`pollForApproval\` returns the response without further polling, and does not emit a log line for the terminal status.
- Orchestrator path: \`activate()\` throws \`ActivationError(formatTierLimitError(...), 'TIER_LIMIT_EXCEEDED')\`. The existing try/catch in \`server.ts\` catches it and pushes an \`error\` status via the relay.
- Deploy path: \`generacy deploy\` prints the formatted message via \`console.error\` and exits with code 1.
- Both surfaces emit identical wording: \`Worker count of <N> exceeds your <Tier> plan limit of <M>. Upgrade your plan or retry with --workers=<M>.\` (tier name title-cased on the cluster side).
- The pre-poll gate in \`worker-count-resolver.ts\` is refactored to call the same \`formatTierLimitError\` util — the resolver and the poll-time reject produce identical user-facing strings.
- Existing \`approved\` / \`expired\` / \`authorization_pending\` / \`slow_down\` paths unchanged.
- Regression test in \`packages/activation-client/__tests__/poller.test.ts\` covers the new variant (schema parse + poller returns without re-polling).
- Unit test covers \`formatTierLimitError\` (title-casing, message body).

## Related

- [generacy-cloud#700](https://github.com/generacy-ai/generacy-cloud/issues/700) — the cloud-side change this completes.
- [generacy-cloud#699](https://github.com/generacy-ai/generacy-cloud/issues/699) — exposes \`tierCap\` in launch-config so the CLI rejects most over-cap launches *before* the poll path is reached. This issue covers the residual cases where #699's gate is bypassed.

## User Stories

### US1: User on an older CLI hits tier cap during cloud activation

**As a** user running an older \`generacy\` CLI (without the launch-config \`tierCap\` gate from #699),
**I want** a clear error explaining that my worker request exceeds my plan's limit,
**So that** I can either lower \`--workers\` or upgrade my plan instead of seeing an opaque schema-validation crash.

**Acceptance Criteria**:
- [ ] When the cloud returns \`tier-limit-exceeded\` during activation polling, the user sees \`Worker count of <N> exceeds your <Tier> plan limit of <M>. Upgrade your plan or retry with --workers=<M>.\`
- [ ] No \`ZodError\` stack trace appears in orchestrator logs or deploy CLI output.
- [ ] The activation flow terminates with a non-zero exit (deploy) or an error relay status (orchestrator) — it does not retry or hang.

### US2: User running \`generacy deploy\` to a BYO VM hits tier cap

**As a** user provisioning a cluster via \`generacy deploy ssh://...\`,
**I want** the same friendly tier-limit message that the local \`launch\` flow produces,
**So that** the deploy flow doesn't feel less polished than the local flow.

**Acceptance Criteria**:
- [ ] The deploy command's activation-polling code branches on \`tier-limit-exceeded\` and prints the formatted message to stderr.
- [ ] Process exits with code 1.

### US3: Wording is consistent across the two CLI surfaces that can reject a worker count

**As a** user who configured \`--workers\` higher than the tier cap,
**I want** to see the same message whether the rejection comes from the local pre-poll gate (#699's \`worker-count-resolver\`) or from the cloud during polling (#700),
**So that** the same misconfiguration doesn't produce two visibly different error texts.

**Acceptance Criteria**:
- [ ] Both rejection paths call \`formatTierLimitError({ requested, cap, tier })\`.
- [ ] No inline interpolation of "tier cap" / "plan limit" wording remains in either site.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | \`PollResponseSchema\` includes a \`tier-limit-exceeded\` variant with \`cap: number (int, ≥0)\`, \`requested: number (int, ≥1)\`, and \`tier: string\` fields. | P1 | \`packages/activation-client/src/types.ts\` |
| FR-002 | \`pollForApproval\`'s switch returns the response on \`tier-limit-exceeded\` without logging and without further polling. | P1 | \`packages/activation-client/src/poller.ts\` |
| FR-003 | \`pollForApproval\` JSDoc enumerates \`'tier-limit-exceeded'\` alongside \`'approved'\` and \`'expired'\` as terminal statuses. | P2 | Doc-only |
| FR-004 | The orchestrator (\`packages/orchestrator/src/activation/index.ts\`) branches on \`tier-limit-exceeded\` and throws \`new ActivationError(formatTierLimitError(...), 'TIER_LIMIT_EXCEEDED')\`. | P1 | New \`ActivationError\` code |
| FR-005 | The deploy command (\`packages/generacy/src/cli/commands/deploy/activation.ts\`) branches on \`tier-limit-exceeded\`, emits \`console.error(formatTierLimitError(...))\`, and exits with code 1. | P1 | |
| FR-006 | A shared \`formatTierLimitError({ requested, cap, tier })\` util is exported from \`@generacy-ai/activation-client\`. | P1 | Title-cases tier name internally |
| FR-007 | \`packages/generacy/src/cli/commands/launch/worker-count-resolver.ts\` is refactored to call \`formatTierLimitError\` instead of inline string interpolation. | P1 | Eliminates wording drift |
| FR-008 | Regression test in \`packages/activation-client/__tests__/poller.test.ts\` covers \`tier-limit-exceeded\`: schema parses, poller returns immediately, no extra log lines. | P1 | |
| FR-009 | Unit test for \`formatTierLimitError\`: covers title-casing and exact message body. | P2 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Cluster correctly handles cloud-side tier-limit reject. | 0 \`ZodError\` crashes when cloud returns \`{ status: 'tier-limit-exceeded', ... }\` | Regression test in \`poller.test.ts\` |
| SC-002 | Identical user-facing wording at both rejection sites. | 1 string template across pre-poll gate and poll-time reject | Grep: only \`formatTierLimitError\` callers produce the message; no inline "plan limit" / "tier cap" strings remain |
| SC-003 | Orchestrator failure mode is programmatically discriminable. | \`ActivationError.code === 'TIER_LIMIT_EXCEEDED'\` is set when the cloud rejects on tier. | Inspect thrown error in orchestrator integration test |
| SC-004 | Existing happy paths unaffected. | All four pre-existing PollResponse statuses (\`approved\`, \`expired\`, \`slow_down\`, \`authorization_pending\`) continue to be handled. | Existing \`poller.test.ts\` cases pass unchanged |

## Assumptions

- The cloud's \`tier\` field is a lowercase identifier (\`basic\`, \`pro\`, \`enterprise\`, etc.). Title-casing the first character on the cluster side produces an acceptable display form for all current tier values.
- The orchestrator's existing \`ActivationError\` error class can accept a new code (\`'TIER_LIMIT_EXCEEDED'\`) without breaking other call sites (additive union member only).
- The existing try/catch around \`activate()\` in \`server.ts\` already pushes an \`error\` status via the relay for any thrown \`ActivationError\`. The new code surfaces through that same path without bespoke handling.
- The \`generacy\` CLI workspace package can depend on \`@generacy-ai/activation-client\` (no circular-dep concerns).
- No backwards-compat shim is needed for clusters running against a cloud version that does not yet emit \`tier-limit-exceeded\` — the new union variant is additive and unobserved on older clouds.

## Out of Scope

- Adding a launch-side surface (\`launch\` CLI scanning \`docker compose logs\` for a structured marker line and exiting early). The sibling #699 gate handles the common case; the residual is narrow enough to defer to a follow-up if reported.
- Changing the existing \`'DEVICE_CODE_EXPIRED'\` flow or any other \`PollResponse\` variant.
- Restructuring \`ActivationResult\` to a discriminated union (rejected in Q2: too much blast radius for one new failure mode).
- A tier-name mapping table (rejected in Q3: title-casing handles current and likely-future tiers).
- Cloud-side changes — generacy-cloud#700 has already shipped (PR #704).

---

*Generated by speckit*
