# Data Model: smee.io provisioner fix (#965)

This fix introduces no new entities, no new types, and no new persisted state. It is a pure predicate change inside `SmeeChannelResolver.provision()`.

The existing data model surfaces are documented here for reference so contracts/tasks phases have the invariants in one place.

## Existing entities (unchanged)

### `SmeeChannelResolverOptions`

Defined at `packages/orchestrator/src/services/smee-channel-resolver.ts:37-46`. Unchanged.

```ts
export interface SmeeChannelResolverOptions {
  /** Absolute path to the persisted channel file. */
  channelFilePath: string;
  /** If provided, resolver returns it immediately (source: 'env-or-yaml'). */
  presetUrl?: string;
  /** Injected for tests. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Injected for tests. Defaults to a `setTimeout`-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
}
```

### `SmeeChannelResolverResult`

Defined at `smee-channel-resolver.ts:48-51`. Unchanged.

```ts
export interface SmeeChannelResolverResult {
  channelUrl: string;
  source: ChannelSource;    // 'env-or-yaml' | 'persisted' | 'provisioned'
}
```

### `ChannelSource`

Defined at `smee-channel-resolver.ts:35`. Unchanged.

```ts
export type ChannelSource = 'env-or-yaml' | 'persisted' | 'provisioned';
```

## Predicate change (internal to `provision()`)

The change is confined to the guard inside the retry loop at `smee-channel-resolver.ts:141`. Modelled as a decision table:

| `response.status` | `Location` header | Old behavior (`POST`+`302`-only) | New behavior (`GET`+3xx-range) |
|---|---|---|---|
| `200` (POST) | — | `lastError = "unexpected status 200"` → retry → fail | (no longer reachable — method is `GET`) |
| `200` (GET) | — | `lastError = "unexpected status 200"` → retry → fail | `lastError = "expected 3xx with Location, got 200"` → retry → fail |
| `301` | valid smee URL | `lastError = "unexpected status 301"` → retry → fail | **success** — return `Location` |
| `302` | valid smee URL | **success** — return `Location` | **success** — return `Location` (302 is inside `>= 300 && < 400`) |
| `303` | valid smee URL | `lastError = "unexpected status 303"` → retry → fail | **success** — return `Location` |
| `304`/`305`/`306` | invalid or absent | `lastError = "unexpected status …"` → retry → fail | `lastError = "Location does not match SMEE_URL_PATTERN"` (or `"missing Location header"`) → retry → fail |
| `307` (current live) | valid smee URL | `lastError = "unexpected status 307"` → retry → fail | **success** — return `Location` |
| `308` | valid smee URL | `lastError = "unexpected status 308"` → retry → fail | **success** — return `Location` |
| `3xx` | absent | `lastError = "missing Location header"` → retry → fail | `lastError = "missing Location header"` → retry → fail (branch unchanged) |
| `3xx` | present but doesn't match `SMEE_URL_PATTERN` | `lastError = "Location does not match SMEE_URL_PATTERN"` → retry → fail | `lastError = "Location does not match SMEE_URL_PATTERN"` → retry → fail (branch unchanged) |
| `4xx`/`5xx` | — | `lastError = "unexpected status …"` → retry → fail | `lastError = "expected 3xx with Location, got …"` → retry → fail |
| network / timeout / abort | — | catch branch, `lastError = "timeout after 5000ms"` or `err.message` | (unchanged) |

Invariants preserved across the change:
- `provision()` never throws — every path folds into `return null` or a returned `location` string. (spec FR-006)
- Retry envelope (2 attempts, 1s backoff between attempts, 5s per-request timeout) is unchanged. (FR-006)
- `SMEE_URL_PATTERN` re-validation on `Location` is unchanged — it is the second-line gate that keeps the broad 3xx range honest. (FR-003)
- The `Location`-missing and `Location`-invalid branches are unchanged. (FR-003)
- The catch branch (timeouts, network errors) is unchanged.

## Validation rules

- **`SMEE_URL_PATTERN`**: `/^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/`. Unchanged. Both `POST`-era and current `GET`-era URLs match. (spec §Assumptions)
- **Response status acceptance**: `response.status >= 300 && response.status < 400`. Was `response.status === 302`. (FR-002)
- **`Location` header presence**: unchanged — absent `Location` is `lastError = 'missing Location header'`.
- **`Location` header shape**: unchanged — must match `SMEE_URL_PATTERN`.

## Relationships

Unchanged. The 4-tier `resolve()` precedence is:

```
presetUrl (env-or-yaml)  →  persisted file  →  provision()  →  writePersistedFile()
```

Only `provision()`'s internal predicate changes. The other three tiers are untouched.
