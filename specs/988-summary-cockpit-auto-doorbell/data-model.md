# Data Model: `/cockpit:auto` doorbell webhook-config discovery

Types added or extended in this feature. All live in `packages/generacy/src/cli/commands/cockpit/doorbell/`.

## Extended: `ChannelDiscoveryInput`

File: `channel-discovery.ts`.

```ts
import type { CommandRunner } from '@generacy-ai/cockpit';
import type { PathLike } from 'node:fs';

interface ReadFileFn {
  (path: PathLike, encoding: BufferEncoding): Promise<string>;
}

export interface ChannelDiscoveryInput {
  // Existing fields — unchanged.
  env: NodeJS.ProcessEnv;
  channelFilePath: string;
  fs: { readFile: ReadFileFn };
  logger?: { warn?: (msg: string) => void };
  cwd?: string;
  workspaceMirrorPath?: string;

  // NEW: webhook-config stage inputs. All optional; when absent, the stage is skipped.
  /**
   * Pre-parsed target repos for the webhook-config stage, primary-first.
   * The caller (`doorbell.ts`) derives this via `resolveWebhookTargets`.
   * When absent or empty, the webhook-config stage is skipped.
   */
  targets?: Array<{ owner: string; repo: string }>;

  /**
   * Command runner used to invoke `gh api …/hooks`. When absent, the
   * webhook-config stage is skipped even if `targets` is non-empty.
   */
  runner?: CommandRunner;

  /**
   * Per-call timeout for the `gh api …/hooks` invocation. Default 5000ms
   * (spec FR-009 / clarification Q5=B). Exposed for tests.
   */
  webhookConfigTimeoutMs?: number;
}
```

**Validation rules**:

- `targets`: each entry MUST have non-empty `owner` and `repo` strings. Callers own validation; discovery does not re-validate.
- `webhookConfigTimeoutMs`: MUST be a positive integer. Non-positive values are treated as the default (5000ms).
- No runtime schema — this is a call-site TypeScript-only interface.

## Extended: `ChannelSource` union

File: `channel-discovery.ts`.

```ts
export type ChannelSource =
  | 'env'
  | 'webhook-config'   // NEW
  | 'workspace-walkup'
  | 'workspace-absolute'
  | 'file';
```

**Rationale**: Exposed in `ChannelDiscoveryResult.source` for tests. The FR-006 stderr line via `SourceSelector.formatLine` still maps every non-poll source to the label `smee`, so this expansion is internal.

## New: `SmeeHook`

File: `channel-discovery.ts` (co-located with the stage that consumes it).

Zod-validated subset of GitHub's `/repos/{owner}/{repo}/hooks` response:

```ts
import { z } from 'zod';

const SmeeHookSchema = z.object({
  id: z.number().int(),
  active: z.boolean(),
  config: z.object({
    url: z.string(),
  }),
  updated_at: z.string(),
}).passthrough();

export type SmeeHook = z.infer<typeof SmeeHookSchema>;
```

**Rationale**: `passthrough()` future-proofs against GitHub adding fields. We validate only what we use (`id` for logs, `active` for filter, `config.url` for pattern match, `updated_at` for tie-break).

## New: `pickSmeeHook` — pure function

File: `channel-discovery.ts`.

```ts
export function pickSmeeHook(hooks: SmeeHook[]): SmeeHook | null;
```

**Contract**:

1. Filter `hooks` to entries where `active === true`.
2. Filter to entries where `SMEE_URL_PATTERN.test(config.url)` (existing regex).
3. Sort by `Date.parse(updated_at)` desc; entries where `Number.isNaN(Date.parse(updated_at))` sort last (`-Infinity`).
4. Return `sorted[0] ?? null`.

**Determinism**: Same input → same output; no side effects; no I/O.

**Test surface**:

- Empty input → `null`.
- All inactive → `null`.
- Active + non-smee → `null`.
- Single active smee → that hook.
- Two active smee, distinct `updated_at` → newer one.
- Active + inactive with same URL → active one.
- Two active smee, one with malformed `updated_at` → the well-formed one.

## New: `resolveWebhookTargets` — helper

File: `webhook-target-resolver.ts`.

```ts
import type { GhWrapper } from '@generacy-ai/cockpit';

export interface ResolveWebhookTargetsInput {
  epicRef: string;
  gh: GhWrapper;
  logger?: { warn: (msg: string) => void };
}

export async function resolveWebhookTargets(
  input: ResolveWebhookTargetsInput,
): Promise<Array<{ owner: string; repo: string }>>;
```

**Contract**:

1. Call `resolveEpic({ epicRef, gh, logger })`.
2. On success:
   - Start with `[resolved.epic.repo]` (primary-first invariant).
   - Append `resolved.repos.filter(r => r !== resolved.epic.repo)` (dedup, preserves resolved.repos ordering).
   - Split each `"owner/repo"` on `/` — MUST yield exactly two non-empty segments; malformed entries are skipped with a warn.
   - Return the resulting array.
3. On failure (any thrown error, including `LoudResolverError`):
   - Log one warn line: `cockpit doorbell: webhook-target resolution failed: <message>`.
   - Return `[]` (falls through to FS stages).

**Never throws.**

**Test surface** (`webhook-target-resolver.test.ts`):

- Single-repo epic → `[{ owner, repo }]`.
- Multi-repo epic with primary + two siblings → primary first, dedup preserved.
- Epic ref malformed → `[]` + warn.
- `resolveEpic` throws `NO_REFS` → `[]` + warn.

## Extended: `discoverChannelUrl` — stage ordering

File: `channel-discovery.ts`.

Order (per FR-004):

1. `env[COCKPIT_DOORBELL_SMEE_URL]` — unchanged.
2. **`webhook-config` — NEW.** Skip if `runner == null` or `targets == null || targets.length === 0`. Otherwise, iterate `targets` in order (primary first):
   - Invoke `runner('gh', ['api', `/repos/${target.owner}/${target.repo}/hooks`], { timeoutMs: webhookConfigTimeoutMs ?? 5000 })`.
   - Non-zero exit (including `exitCode: 124` timeout) → warn one line with target repo, advance to next target.
   - JSON parse failure → warn one line, advance.
   - Zod parse failure on the array → warn one line, advance.
   - `pickSmeeHook(parsed)` returns `null` → silent (no warn — "no smee hook" is a routine outcome), advance.
   - `pickSmeeHook(parsed)` returns a hook → return `{ url: hook.config.url, source: 'webhook-config' }` immediately.
   - After exhausting all targets → fall through to walk-up.
3. Walk-up scan — unchanged.
4. Workspace-absolute — unchanged.
5. Cluster-internal file — unchanged.

## No new persisted state

- No files written.
- No cache.
- One call per repo per doorbell startup (FR-007 / SC-002).
- Discovery result lives in `doorbell.ts`'s local `discovery` variable — as today.

## Backwards compatibility

- Callers that pass only the existing `env`, `channelFilePath`, `fs`, `logger`, `cwd`, `workspaceMirrorPath` fields see identical behavior.
- The `webhook-config` stage is a no-op unless the caller opts in by passing `targets` and `runner`.
- All existing `channel-discovery.test.ts` cases continue to pass without modification.
