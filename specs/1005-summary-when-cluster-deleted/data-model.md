# Data Model: Adopt existing smee channel on cluster delete→relaunch

**Issue**: [#1005](https://github.com/generacy-ai/generacy/issues/1005)
**Branch**: `1005-summary-when-cluster-deleted`

Purely internal data shapes — no persistent schemas, no relay-wire payloads, no HTTP contracts change. This document names the types the resolver + webhook-setup service exchange for the adopt tier and the take-over branch.

## Types added

### `ChannelSource` — extend existing enum

**File**: `packages/orchestrator/src/services/smee-channel-resolver.ts`

```ts
export type ChannelSource = 'env-or-yaml' | 'persisted' | 'adopted' | 'provisioned';
```

- Adds `'adopted'` between `'persisted'` and `'provisioned'` — the ordering here does not affect runtime, but matches the resolver's tier order for readability.
- Downstream consumers of `SmeeChannelResolverResult.source` — currently only the `server.log.info` at `server.ts:652-655` — do not switch/guard on the value; they log it as a string. No breakage.

**Validation rule**: `SmeeChannelResolverResult` invariant — `channelUrl` MUST match `SMEE_URL_PATTERN` regardless of source. The adopt tier enforces this by validating the callback's return before treating it as a hit (see `runAdoptTier` in the contract file).

### `RepositoryRef` — shared shape (already exists)

**File**: `packages/orchestrator/src/services/webhook-setup-service.ts` (re-used as `RepositoryConfig`)

```ts
export interface RepositoryConfig {
  owner: string;
  repo: string;
}
```

Reused by the resolver's new `SmeeChannelResolverOptions.repos` field. No new type — the resolver imports the existing `RepositoryConfig` (or a narrower alias like `RepositoryRef = Pick<RepositoryConfig, 'owner' | 'repo'>`).

### `SmeeChannelResolverOptions` — extend existing

**File**: `packages/orchestrator/src/services/smee-channel-resolver.ts`

Adds two optional fields to the existing interface:

```ts
export interface SmeeChannelResolverOptions {
  /* ...existing fields unchanged... */

  /**
   * Repos to inspect for an existing Generacy smee webhook when persisted is
   * absent (tier 3 "adopt-existing"). When absent or empty, the adopt tier is
   * skipped and the resolver falls straight through to tier 4 (provision).
   */
  repos?: RepositoryConfig[];

  /**
   * Discovery callback for the adopt tier. When set (and `repos` is non-empty
   * and persisted returned null), the resolver calls this to find a live
   * smee.io channel URL already registered on a configured repo's GitHub
   * webhooks. Must return `null` (not throw) on "no match" or unrecoverable
   * failure. Throws are caught and retried once (MAX_ATTEMPTS = 2).
   */
  discoverExistingChannel?: (repos: RepositoryConfig[]) => Promise<string | null>;
}
```

**Validation rules.**
- `repos` — undefined or empty → adopt tier skipped (fall through to provision). Callers that want adopt MUST pass a non-empty list AND a `discoverExistingChannel` callback.
- `discoverExistingChannel` — undefined → adopt tier skipped. Return values MUST either be `null` or a string matching `SMEE_URL_PATTERN`. Non-matching strings are treated as `null` (defensive drop with warn log).

### `FindExistingSmeeChannelResult` — internal, unnamed

**File**: `packages/orchestrator/src/services/webhook-setup-service.ts`

The public callback signature is `(repos) => Promise<string | null>`. Internally, `findExistingSmeeChannel` may track structured state for the divergence-warn side-effect:

```ts
interface RepoScanResult {
  owner: string;
  repo: string;
  smeeUrl: string | null;   // first smee.io hook URL found, or null
  listError?: string;       // populated when _listRepoWebhooks threw
}
```

Not exported. Used only for the "one warn per divergent repo" log side-effect (FR-004). The method's return type stays `Promise<string | null>` to keep the callback contract minimal.

## Types unchanged

- `SmeeChannelResolverResult` — shape unchanged; `source` field now has a new enum value.
- `GitHubWebhook` — unchanged.
- `WebhookSetupResult` — unchanged. The take-over branch (Q5-C) uses the existing `action: 'reactivated'` result kind, matching the current `update-url` handler at `webhook-setup-service.ts:372-402`.
- `WebhookSetupSummary` — unchanged.
- `RepositoryConfig` — unchanged (existing field).

## Relationships

```
SmeeChannelResolver.resolve()
  ├─ if presetUrl → return { source: 'env-or-yaml' }
  ├─ if persisted file valid → return { source: 'persisted' }
  ├─ NEW: if discoverExistingChannel + repos → runAdoptTier()
  │        ├─ retry ≤ MAX_ATTEMPTS
  │        ├─ validate SMEE_URL_PATTERN
  │        ├─ writePersistedFile (best-effort)
  │        └─ return { source: 'adopted' } | fall through
  └─ else → provision() → return { source: 'provisioned' } | null

WebhookSetupService.findExistingSmeeChannel(repos)  ← callback source for the above
  └─ for repo in repos:
       ├─ _listRepoWebhooks(owner, repo)  ← existing method, unchanged
       ├─ collect first https://smee.io/… hook URL
       ├─ first-hit wins; log warn per divergent later repo
       └─ return chosenUrl | null

WebhookSetupService._selectExistingHookForUpdate(hooks, currentUrl, persistedUrl)
  ├─ (existing) exact match on current → skip-active | reactivate
  ├─ (existing) exact match on persisted → update-url [FR-004 stale-channel heal, already there]
  ├─ (existing) foreign smee.io hook (URL matches neither) → skip
  └─ NEW: if smeeHooks.length === 1 AND stale → update-url  [take-over Q5-C]
```

**Invariant**: The take-over branch (Q5-C) fires AFTER the existing `foreign` branch's match. This ordering matters — the existing `foreign` branch already covers the "surviving orphan" case with a *log-and-skip*. The new branch replaces that log-and-skip with a `update-url` when-and-only-when there is exactly one Generacy smee hook on the repo. So the new branch is inserted as a refinement: still classify as smee, but repoint instead of skip, gated on the count check.

Implementation note: in code, this means the new branch is checked *before* the `foreign` branch (or the `foreign` branch is refactored to exclude the single-hook case). The `_selectExistingHookForUpdate` refactor is:

```ts
// existing current-match branch: unchanged
// existing persisted-match branch: unchanged

// smee hooks that match neither current nor persisted
const staleGeneracySmee = hooks.filter(
  (h) => {
    const url = (h.config?.url ?? '').toLowerCase();
    return (
      url.startsWith('https://smee.io/') &&
      url !== currentNormalized &&
      (persistedNormalized === null || url !== persistedNormalized)
    );
  },
);

// NEW: take-over Q5-C — exactly one stale Generacy smee hook → repoint
if (staleGeneracySmee.length === 1) {
  return { kind: 'update-url', hook: staleGeneracySmee[0] };
}

// existing foreign branch fires for the ≥2 case (skip the first one, keep behavior)
if (staleGeneracySmee.length >= 2) {
  return { kind: 'foreign', hook: staleGeneracySmee[0] };
}

// no match — create
return { kind: 'create' };
```

## Persistence

- **`/var/lib/generacy/smee-channel`** — written on both `adopted` and `provisioned` outcomes. Read on every `resolve()` call. Content: single validated smee.io URL. No format change.
- No new files. No database rows. No relay-side state. The adopt tier is stateless between clusters — its input is the repo's GitHub webhook list, its output is a URL, and its side effect is the same persisted-file write the resolver already does for `provisioned`.
