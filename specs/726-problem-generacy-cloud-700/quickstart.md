# Quickstart: Verifying `tier-limit-exceeded` handling

**Issue**: [#726](https://github.com/generacy-ai/generacy/issues/726)
**Branch**: `726-problem-generacy-cloud-700`

## Prerequisites

- Node.js >= 22.
- `pnpm install` at the repo root.
- (Optional, for end-to-end) Docker + Docker Compose v2, plus a test cloud cluster on a paid tier with a low worker cap.

```bash
pnpm install
pnpm --filter @generacy-ai/activation-client build
pnpm --filter @generacy-ai/orchestrator build
pnpm --filter @generacy-ai/generacy build
```

## Run the unit tests

```bash
pnpm --filter @generacy-ai/activation-client test
pnpm --filter @generacy-ai/generacy test -- worker-count-resolver
pnpm --filter @generacy-ai/orchestrator test -- activation
```

Expected: all green. Key new assertions:
- `PollResponseSchema.parse({ status: 'tier-limit-exceeded', cap, requested, tier })` succeeds.
- `pollForApproval` returns the new variant immediately without re-polling or extra log lines.
- `formatTierLimitError` title-cases the first character of `tier` and produces the exact expected message body for sample inputs.
- `worker-count-resolver`'s over-cap rejection's `Error.message` matches the output of `formatTierLimitError`.
- The orchestrator's `activate()` throws `new ActivationError(message, 'TIER_LIMIT_EXCEEDED')` when the poll returns the variant.

## Manual verification — schema parse (offline)

```bash
node --eval "
  const { PollResponseSchema } = require('./packages/activation-client/dist/types.js');
  console.log(PollResponseSchema.parse({ status: 'tier-limit-exceeded', cap: 4, requested: 8, tier: 'basic' }));
"
# → { status: 'tier-limit-exceeded', cap: 4, requested: 8, tier: 'basic' }
```

Pre-fix, the same invocation would throw `ZodError: Invalid discriminator value`.

## Manual verification — formatter output

```bash
node --eval "
  const { formatTierLimitError } = require('./packages/activation-client/dist/format-tier-limit-error.js');
  console.log(formatTierLimitError({ requested: 8, cap: 4, tier: 'basic' }));
"
# → Worker count of 8 exceeds your Basic plan limit of 4. Upgrade your plan or retry with --workers=4.
```

## Manual verification — CLI gate uses the shared formatter

The pre-poll gate in `worker-count-resolver.ts` should now produce the same wording as the cloud-side reject.

```bash
GENERACY_LAUNCH_STUB=1 node /workspaces/generacy/packages/generacy/bin/generacy.js launch \
  --claim=claim_stub --dir=/tmp/demo-726-cap --workers=100
```

Expected stderr:

```
Worker count of 100 exceeds your Basic plan limit of 8. Upgrade your plan or retry with --workers=8.
```

(The exact `<Tier>` and `<cap>` reflect the launch-config's `tier` and `tierCap` for the stub. If the stub doesn't set `tier`, expect a degenerate value — see the formatter contract.)

Pre-fix, the same invocation would print:

```
--workers=100 exceeds tier cap of 8 (CLI fallback cap; real cap will be available after the cloud companion ships).
```

## Manual verification — orchestrator throws on `tier-limit-exceeded` (integration)

This requires mocking the HTTP client or running against a cloud configured to reject the activation. The unit-level coverage in `packages/orchestrator/tests/unit/activation/index.test.ts` simulates the response via the injected `httpClient`:

```ts
// Pseudo — actual test will be added in tasks.md
const mockClient = {
  post: async () => ({
    status: 200,
    data: { status: 'tier-limit-exceeded', cap: 4, requested: 8, tier: 'basic' },
  }),
};

await expect(activate({ /* ... */ httpClient: mockClient })).rejects.toMatchObject({
  message: 'Worker count of 8 exceeds your Basic plan limit of 4. Upgrade your plan or retry with --workers=4.',
  code: 'TIER_LIMIT_EXCEEDED',
});
```

## Manual verification — deploy command exits cleanly

`generacy deploy ssh://...` with a worker count above the tier cap (and the launch-config gate bypassed) should print the formatted message to stderr and exit non-zero.

```bash
# Simulated via stubbed cloud (real flow requires an SSH target and a cloud that emits tier-limit-exceeded).
GENERACY_DEPLOY_STUB=1 node /workspaces/generacy/packages/generacy/bin/generacy.js deploy \
  ssh://test@localhost --workers=100 2>&1 >/dev/null
# → Worker count of 100 exceeds your Basic plan limit of 4. Upgrade your plan or retry with --workers=4.
echo $?
# → 1
```

> **Note**: `GENERACY_DEPLOY_STUB=1` does not currently exist as a runtime feature. End-to-end deploy testing requires a real SSH target plus a cloud emitting the variant; manual coverage is via the orchestrator simulation above.

## End-to-end (requires real cloud and a tier-capped org)

This is fully verifiable only when:
1. The cloud-side change (#700) is live (already shipped via PR #704).
2. The test org has a tier cap lower than the chosen `--workers`.
3. The local CLI does **not** include the launch-config gate from #699 (otherwise the cluster never reaches the poll-time reject).

To bypass the pre-poll gate intentionally (for end-to-end testing), edit `worker-count-resolver.ts` locally to skip the over-cap check, or use a host with an older CLI build.

```bash
cd ~/Generacy
node /workspaces/generacy/packages/generacy/bin/generacy.js launch --claim=<real-claim> --workers=100
```

Expected sequence:
1. `docker compose up -d` succeeds.
2. The orchestrator container starts and calls `activate()`.
3. The poll loop receives `{ status: 'tier-limit-exceeded', cap: 4, requested: 100, tier: 'basic' }`.
4. `activate()` throws `ActivationError('Worker count of 100 exceeds your Basic plan limit of 4. Upgrade your plan or retry with --workers=4.', 'TIER_LIMIT_EXCEEDED')`.
5. `server.ts`'s catch forwards the error via the relay as an `error` cluster status.
6. The cloud dashboard's cluster view shows the formatted message.

Pre-fix, step 3 would throw `ZodError: Invalid discriminator value`, which would crash the activation routine without a clean user-facing message.

## Troubleshooting

**Symptom**: Tests fail with `Error: Cannot find module '@generacy-ai/activation-client'` in the CLI.

The CLI workspace package gained the dep in this PR. If `pnpm install` was not re-run after pulling the branch, refresh the workspace:

```bash
pnpm install
pnpm --filter @generacy-ai/generacy build
```

**Symptom**: `worker-count-resolver.test.ts` failure on the over-cap assertion.

The wording changed in this PR — `worker-count-resolver` now emits the shared formatter's message instead of the old inline string. If the assertion is from a stale test snapshot, update it to match the new wording (see the formatter contract for the exact text).

**Symptom**: Orchestrator integration test still sees `ZodError`.

The `@generacy-ai/activation-client` package wasn't rebuilt after the schema change. Run:

```bash
pnpm --filter @generacy-ai/activation-client build
```

**Symptom**: Deploy command throws `DeployError: Activation failed: Worker count of N exceeds...` (with the prefix).

The deploy branch should call `console.error` + `process.exit(1)` **before** the existing try/catch wraps the error. If you see the `Activation failed:` prefix, the branch was placed inside the try/catch around `ActivationError` — relocate it just after the `pollForApproval` call, before the wrapping logic.
