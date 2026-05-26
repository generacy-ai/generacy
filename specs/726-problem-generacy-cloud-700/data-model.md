# Data Model: Handle `tier-limit-exceeded` PollResponse Variant

**Issue**: [#726](https://github.com/generacy-ai/generacy/issues/726)
**Branch**: `726-problem-generacy-cloud-700`

## Entities

### `PollResponseSchema` (modified)

Wire-format response from `POST /api/clusters/device-code/poll`, defined in `packages/activation-client/src/types.ts`. The existing discriminated union gains one new variant.

**Before**:

```ts
export const PollResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('authorization_pending') }),
  z.object({ status: z.literal('slow_down') }),
  z.object({ status: z.literal('expired') }),
  z.object({
    status: z.literal('approved'),
    cluster_api_key: z.string().min(1),
    cluster_api_key_id: z.string().min(1),
    cluster_id: z.string().min(1),
    project_id: z.string().min(1),
    org_id: z.string().min(1),
    cloud_url: z.string().url(),
  }),
]);
```

**After**:

```ts
export const PollResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('authorization_pending') }),
  z.object({ status: z.literal('slow_down') }),
  z.object({ status: z.literal('expired') }),
  z.object({
    status: z.literal('approved'),
    cluster_api_key: z.string().min(1),
    cluster_api_key_id: z.string().min(1),
    cluster_id: z.string().min(1),
    project_id: z.string().min(1),
    org_id: z.string().min(1),
    cloud_url: z.string().url(),
  }),
  // NEW
  z.object({
    status: z.literal('tier-limit-exceeded'),
    cap: z.number().int().min(0),
    requested: z.number().int().min(1),
    tier: z.string(),
  }),
]);
```

**Validation rules** (new variant only):
- `status`: literal `'tier-limit-exceeded'`.
- `cap`: integer, ≥ 0 (a cap of 0 is degenerate-but-valid; e.g., a paused/frozen org). The CLI's pre-poll gate also accepts `tierCap ≥ 1` via separate validation in `worker-count-resolver`; this schema permits 0 to keep the wire surface non-blocking.
- `requested`: integer, ≥ 1 (the user's chosen worker count; always at least 1 by definition of the launch flow).
- `tier`: string, conventionally a lowercase identifier (`basic`, `pro`, `enterprise`, etc.) — the cluster-side formatter title-cases the first character for display.

**Relationships**:
- Read by `pollDeviceCode` → returned to `pollForApproval` → returned to consumers (orchestrator activate, deploy activation).
- The variant is terminal: when present, the poller does not re-poll.

### `pollForApproval` (modified — switch + JSDoc)

In `packages/activation-client/src/poller.ts`. The switch on `response.status` gains a new branch; the JSDoc enumerates the new terminal status.

**Before (relevant excerpt)**:

```ts
/**
 * Poll for device code approval. Handles `slow_down` and `expired` statuses.
 * Returns the final PollResponse (either 'approved' or 'expired').
 */
export async function pollForApproval(options: PollOptions): Promise<PollResponse> {
  // …
  switch (response.status) {
    case 'approved':
      return response;
    case 'expired':
      return response;
    case 'slow_down':
      intervalMs = Math.min(intervalMs + SLOW_DOWN_INCREMENT_MS, MAX_INTERVAL_MS);
      logger.info(`Poll interval increased to ${intervalMs / 1000}s`);
      break;
    case 'authorization_pending':
      break;
  }
  // …
}
```

**After**:

```ts
/**
 * Poll for device code approval. Handles `slow_down` and `expired` statuses.
 * Returns the final PollResponse: one of 'approved', 'expired', or 'tier-limit-exceeded'.
 * Terminal statuses are returned to the caller without further polling and without
 * an additional log line — the caller is responsible for user-facing surfacing.
 */
export async function pollForApproval(options: PollOptions): Promise<PollResponse> {
  // …
  switch (response.status) {
    case 'approved':
      return response;
    case 'expired':
      return response;
    case 'tier-limit-exceeded':           // NEW
      return response;
    case 'slow_down':
      intervalMs = Math.min(intervalMs + SLOW_DOWN_INCREMENT_MS, MAX_INTERVAL_MS);
      logger.info(`Poll interval increased to ${intervalMs / 1000}s`);
      break;
    case 'authorization_pending':
      break;
  }
  // …
}
```

**Behavioral rule**: terminal statuses (`approved`, `expired`, `tier-limit-exceeded`) return immediately without logging. Non-terminal statuses (`slow_down`, `authorization_pending`) continue the polling loop; `slow_down` adjusts and logs the interval.

### `ActivationErrorCode` (modified)

Union of error codes for the existing `ActivationError` class in `packages/activation-client/src/errors.ts`.

**Before**:

```ts
export type ActivationErrorCode =
  | 'CLOUD_UNREACHABLE'
  | 'DEVICE_CODE_EXPIRED'
  | 'INVALID_RESPONSE';
```

**After**:

```ts
export type ActivationErrorCode =
  | 'CLOUD_UNREACHABLE'
  | 'DEVICE_CODE_EXPIRED'
  | 'INVALID_RESPONSE'
  | 'TIER_LIMIT_EXCEEDED';     // NEW
```

**Validation rules**: union members are string literals; no runtime validation needed.

**Relationships**:
- Set by `throw new ActivationError(formatTierLimitError(...), 'TIER_LIMIT_EXCEEDED')` in the orchestrator's `activate()` (`packages/orchestrator/src/activation/index.ts`).
- Read by consumers that branch on `error.code` (e.g., future relay handlers, integration tests asserting SC-003). No current consumer branches on it — the existing `server.ts` try/catch handles all `ActivationError` instances uniformly.

### `TierLimitErrorInput` (new shape — formatter input)

The input parameter to the shared formatter, defined inline in `packages/activation-client/src/format-tier-limit-error.ts`. Mirrors the wire shape of the `tier-limit-exceeded` variant minus the `status` discriminator.

```ts
export interface TierLimitErrorInput {
  requested: number;
  cap: number;
  tier: string;
}

export function formatTierLimitError(input: TierLimitErrorInput): string;
```

**Validation rules**: trust the caller. The formatter does not re-validate (the schema already did on the wire path; the resolver gate already validated user-supplied flag input). It applies title-casing to `tier` and interpolates into the message body.

**Output**:

```text
Worker count of <requested> exceeds your <Tier> plan limit of <cap>. Upgrade your plan or retry with --workers=<cap>.
```

Where `<Tier>` = `tier.charAt(0).toUpperCase() + tier.slice(1)`.

**Relationships**:
- Called from:
  - `packages/orchestrator/src/activation/index.ts` (orchestrator branch).
  - `packages/generacy/src/cli/commands/deploy/activation.ts` (deploy branch).
  - `packages/generacy/src/cli/commands/launch/worker-count-resolver.ts` (refactored pre-poll gate; replaces the existing inline `throw new Error('--workers=N exceeds tier cap of M…')`).

### `ActivationOptions.initialWorkers` (unchanged, but contextual)

Already added by #716. `pollForApproval` already accepts `workers?: number` and forwards it to the poll body. This issue does **not** change the request-side wire format — only the response-side parsing.

## Flow

```text
POST /api/clusters/device-code/poll
  body: { device_code, workers: N }
    │
    └──► (cloud-side, generacy-cloud#700/PR #704)
          if requested workers > org's tierCap:
            return { status: 'tier-limit-exceeded', cap, requested, tier }
    │
pollDeviceCode → PollResponseSchema.parse(body) — SUCCESS (new variant accepted)
    │
pollForApproval switch:
  case 'tier-limit-exceeded': return response  (terminal, no log)
    │
    ├──► Orchestrator caller (activation/index.ts):
    │       if (pollResult.status === 'tier-limit-exceeded') {
    │         throw new ActivationError(
    │           formatTierLimitError({ requested, cap, tier }),
    │           'TIER_LIMIT_EXCEEDED',
    │         );
    │       }
    │     └──► server.ts existing catch → relay error-status push
    │
    └──► Deploy caller (deploy/activation.ts):
            if (pollResult.status === 'tier-limit-exceeded') {
              console.error(formatTierLimitError({ requested, cap, tier }));
              process.exit(1);
            }
```

Parallel flow on the pre-poll gate path (host-side, `generacy launch`):

```text
generacy launch --workers=N
    │
    └──► fetchLaunchConfig (returns tierCap?)
          resolveWorkerCount(opts, launchConfig, isTTY):
            if (opts.workers > tierCap) {
              throw new Error(formatTierLimitError({ requested: opts.workers, cap: tierCap, tier }));
              // ← REFACTORED — was inline string interpolation before
            }
```

## Tier-name title-casing (formatter internal)

```text
'basic'        →  'Basic'
'pro'          →  'Pro'
'enterprise'   →  'Enterprise'
'team'         →  'Team'
'pro-plus'     →  'Pro-plus'        (degrades acceptably; no mapping table)
''             →  ''                (degenerate; cloud should never send empty)
'BASIC'        →  'BASIC'           (only the first char is touched; cloud convention is lowercase)
```

## Test surface

| Test file                                                                            | Asserts                                                                                                                |
|--------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------|
| `packages/activation-client/tests/unit/types.test.ts`                                | `PollResponseSchema.parse({ status: 'tier-limit-exceeded', cap, requested, tier })` succeeds; fields exposed correctly. |
| `packages/activation-client/tests/unit/poller.test.ts`                               | When `pollDeviceCode` returns the new variant, `pollForApproval` returns it immediately, no extra logs, no re-poll.    |
| `packages/activation-client/tests/unit/format-tier-limit-error.test.ts` (NEW)        | Title-cases tier first char; produces the exact message body for sample inputs.                                        |
| `packages/generacy/src/cli/commands/launch/__tests__/worker-count-resolver.test.ts`  | Over-cap rejection's `Error.message` matches `formatTierLimitError(...)` output (assertion updated to new wording).    |

## File-level shape changes

### `packages/activation-client/src/index.ts` (re-export surface)

Adds one export:

```ts
export { formatTierLimitError } from './format-tier-limit-error.js';
export type { TierLimitErrorInput } from './format-tier-limit-error.js';
```

### `packages/generacy/package.json` (dependencies)

Adds one workspace dep:

```json
{
  "dependencies": {
    "@generacy-ai/activation-client": "workspace:*"
  }
}
```

(The CLI's `deploy` command already imports from this package; promoting the dep to explicit declaration formalizes the existing edge.)

## Out-of-scope reads

- `packages/orchestrator/src/server.ts` — existing try/catch around `activate()` already forwards every `ActivationError` to the relay as `error` status. No code change required; the new `TIER_LIMIT_EXCEEDED` code rides the same path.
- `packages/cluster-relay/` — the error event format is unchanged; the relay forwards the message text as-is.
- Cloud side — already shipped (#700 / PR #704). This issue's wire-format reader matches the cloud's writer.
