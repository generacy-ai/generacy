# Data Model: Auto-provision smee.io channel

**Feature**: #952 | **Branch**: `952-summary-no-automated-cluster` | **Date**: 2026-07-16

Types, schemas, and file formats introduced by this feature. All live in `packages/orchestrator/src/`.

## 1. `SmeeChannelResolverOptions`

Constructor options for the new resolver service. Test injection seams (`fetch`, `sleep`) live here.

```ts
// packages/orchestrator/src/services/smee-channel-resolver.ts

export interface SmeeChannelResolverOptions {
  /**
   * Absolute path to the persisted channel file.
   * Sourced from `config.smee.channelFilePath`.
   * Default: `/var/lib/generacy/smee-channel`.
   */
  channelFilePath: string;

  /**
   * If provided, resolver returns it immediately (source: 'env-or-yaml')
   * without touching the file or the network.
   * Wired from `config.smee.channelUrl` — Zod-validated as `z.string().url()`
   * at config-load time, so the resolver trusts it.
   */
  presetUrl?: string;

  /**
   * Injected for tests. Defaults to `globalThis.fetch`.
   * Signature matches native fetch exactly — no wrapper interface.
   */
  fetch?: typeof globalThis.fetch;

  /**
   * Injected for tests. Defaults to a `setTimeout`-backed sleep.
   * Used for the 1s inter-attempt delay (Q4→B).
   */
  sleep?: (ms: number) => Promise<void>;
}
```

**Validation rules**:
- `channelFilePath` — no validation at construction. Existence and writability are validated at read/write time (fail-open on read, drop-URL on write per Q5→A).
- `presetUrl` — no re-validation. Trusted from Zod at config load.

## 2. `SmeeChannelResolverResult`

Return type of `SmeeChannelResolver.resolve()`.

```ts
export type ChannelSource = 'env-or-yaml' | 'persisted' | 'provisioned';

export interface SmeeChannelResolverResult {
  /**
   * The resolved smee channel URL. Always matches `SMEE_URL_PATTERN`
   * or was Zod-validated as `z.string().url()` in the env/yaml case.
   */
  channelUrl: string;

  /**
   * Which tier produced this URL. Emitted in log context so operators
   * can grep for the resolution mode without re-parsing prose.
   */
  source: ChannelSource;
}
```

**Contract**: `resolve()` returns `SmeeChannelResolverResult | null`. `null` means "no URL available; skip pipeline; log warn and continue webhook-less." `null` covers:
- Provision attempt exhausted (Q4→B: 2 attempts both failed).
- Provision succeeded but persistence write failed (Q5→A: drop URL).

`null` does NOT cover:
- `presetUrl` set → always returns non-null (`source: 'env-or-yaml'`).
- Persisted file valid → always returns non-null (`source: 'persisted'`).

## 3. `SmeeChannelResolver` class

```ts
export class SmeeChannelResolver {
  constructor(
    private readonly logger: Logger,
    private readonly options: SmeeChannelResolverOptions,
  ) {}

  /**
   * Resolve the smee channel URL through the 4-tier precedence:
   *   1. options.presetUrl (env or yaml, wired via config)
   *   2. persisted file at options.channelFilePath
   *   3. provision via POST https://smee.io/new (2 attempts, 1s delay, 5s timeout each)
   *   4. persist the provisioned URL atomically; on write failure, drop the URL
   *
   * Never throws. Every failure mode logs internally and folds into `return null`.
   * Non-fatal by contract — spec FR-006 mandates fail-open behavior.
   *
   * @returns The resolved URL + source tag, or null if all tiers failed.
   */
  async resolve(): Promise<SmeeChannelResolverResult | null> { /* … */ }
}
```

**Method inventory**:
- `resolve(): Promise<SmeeChannelResolverResult | null>` — public entry point.
- Private helpers: `readPersistedFile()`, `provision()`, `writePersistedFile(url)`. All private, all `async`, all throw internally so `resolve()` can `try/catch` cleanly.

## 4. `SMEE_URL_PATTERN` constant

```ts
/**
 * Strict validation pattern for smee.io channel URLs.
 *
 * Applied ONLY to the persisted file's contents (tier 3). Env / yaml URLs are
 * trusted (Zod-validated as z.string().url() at config load).
 *
 * Rejects: non-HTTPS, non-smee.io hosts, query strings, fragments, port
 * specifications, additional path segments. This is deliberately narrower than
 * SmeeWebhookReceiver would accept — the file is the corruption failure mode.
 */
export const SMEE_URL_PATTERN = /^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/;
```

**Rationale for character class**:
- `A-Za-z0-9` — smee.io's observed ID alphabet (`mNhnxyK56d9qkZo`).
- `_-` — defensive against a future alphabet widen. Safe: neither character can introduce path segments, query strings, or protocol confusion.
- Explicitly excluded: `.`, `/`, `?`, `#`, whitespace, control characters. Any of these in the file's content indicates corruption or a totally different string type (a log line, an error message, an HTML fragment).

## 5. Config schema addition: `channelFilePath`

```ts
// packages/orchestrator/src/config/schema.ts (~line 238)

export const SmeeConfigSchema = z.object({
  /** Smee.io channel URL for receiving webhook events */
  channelUrl: z.string().url().optional(),

  /** Fallback poll interval when Smee is active (milliseconds) */
  fallbackPollIntervalMs: z.number().int().min(30000).default(300000),

  /**
   * Path to the persisted smee channel file.
   * Written after a successful auto-provision; read on subsequent boots.
   * Default: `/var/lib/generacy/smee-channel` (alongside cluster-api-key,
   * cluster.json, master.key, credentials.dat).
   *
   * Overridable via `orchestrator.smeeChannelFilePath` in .generacy/config.yaml
   * or `ORCHESTRATOR_SMEE_CHANNEL_FILE_PATH` env var — test-only, not documented
   * for operators.
   */
  channelFilePath: z.string().default('/var/lib/generacy/smee-channel'),
});
export type SmeeConfig = z.infer<typeof SmeeConfigSchema>;
```

**Backwards compatibility**: `channelFilePath` has a Zod default. Existing configs without the field parse unchanged; the default kicks in on first read. No migration.

**Env var wiring** (`packages/orchestrator/src/config/loader.ts` addition, mirrors line 133's `smeeEnvUrl` pattern):

```ts
const smeeChannelFilePath = process.env['ORCHESTRATOR_SMEE_CHANNEL_FILE_PATH'];
if (smeeChannelFilePath) {
  if (!config.smee) config.smee = {};
  (config.smee as Record<string, unknown>).channelFilePath = smeeChannelFilePath;
}
```

## 6. Persisted file format

**Path**: `/var/lib/generacy/smee-channel` (or `config.smee.channelFilePath` override).

**Owner / mode**: `node` user (uid 1000 in cluster-base container), mode `0600` — read + write by owner only, matching `cluster-api-key`.

**Format**: Plain text. Exactly one line. No trailing newline (defensively `.trim()`ed on read to tolerate hand-edits that add one).

**Content grammar**:
```
smee_url := "https://smee.io/" id
id       := [A-Za-z0-9_-]+
```

**Example** (this is the exact byte content):
```
https://smee.io/mNhnxyK56d9qkZo
```

**Read semantics**:
- ENOENT → falls through to provision (tier 3).
- Any other read error (EACCES, EIO, EISDIR, …) → logs warn, falls through to provision.
- File exists but content doesn't match `SMEE_URL_PATTERN` after trim → logs warn `{ path, contentPreview }` (contentPreview truncated to 64 chars to avoid leaking secrets in case someone wrote sensitive data here by mistake), falls through to provision. Provision success will overwrite the file atomically (Q3→A).

**Write semantics**:
- Directory: `mkdir({ recursive: true })` on the parent (`/var/lib/generacy/`). No-op if it exists (which it always does, but the mkdir defends against fresh cluster startup edge cases).
- Temp file: `${channelFilePath}.tmp`, `writeFile(url, { mode: 0o600 })`.
- Atomic swap: `rename(tmp, channelFilePath)`. On POSIX, atomic within a filesystem.
- Failure → resolver returns `null` (Q5→A: drop the URL, skip pipeline).

## 7. HTTP contract: `POST https://smee.io/new`

**Request**:
- Method: `POST`
- URL: `https://smee.io/new` (no query string, no body)
- Headers: none required (implementation may include `User-Agent: generacy-orchestrator/<version>` for smee.io analytics; not load-bearing)
- `redirect: 'manual'` — critical, because auto-following the 302 issues a `GET` on the channel URL which opens the SSE connection prematurely.
- `signal: AbortSignal.timeout(5000)` — 5s connect+response budget (Q1→B).

**Successful response**:
- Status: `302`
- `Location` header: `https://smee.io/<id>` where `id` matches the ID grammar above.
- Body: irrelevant (typically an HTML redirect page).

**Failure modes → all treated identically** (retry once, then fail):
- Network error (ENOTFOUND DNS, ECONNREFUSED, ECONNRESET, timeout via AbortError).
- Non-302 status (any 2xx, 4xx, 5xx).
- Missing or empty `Location` header.
- `Location` value doesn't match `SMEE_URL_PATTERN`.

**Retry**: 2 attempts total, 1s fixed delay between (Q4→B).

## 8. `startSmeePipeline(url)` helper contract

Not a class or exported function — a closure inside `createServer()`. Contract documented here for reference.

```ts
/**
 * Wire the smee pipeline for the given resolved URL.
 *   1. Construct SmeeWebhookReceiver with the URL and watchedRepos.
 *   2. Assign the receiver to the enclosing `smeeReceiver` variable so the
 *      graceful-shutdown block at server.ts:866-868 can stop it.
 *   3. Log info { channelUrl } — "Smee webhook receiver configured".
 *   4. Fire-and-forget: receiver.start().catch(log).
 *   5. If config.webhookSetup.enabled: construct WebhookSetupService and
 *      fire-and-forget: ensureWebhooks(url, config.repositories).catch(log).
 *
 * Invariant: MUST be called from a code path that has already passed the
 * `!isWorkerMode && config.labelMonitor && config.repositories.length > 0`
 * gate. Called from two sites: (a) synchronously inside the gate when
 * config.smee.channelUrl is env/yaml-set; (b) asynchronously from the
 * SmeeChannelResolver.resolve() .then() callback in the onReady hook.
 */
```

## 9. Log line vocabulary

Five new log lines are introduced. Structured fields chosen to match the surrounding log conventions in `server.ts` and `services/*.ts`.

| # | Level | Location | Message | Structured fields |
|---|-------|----------|---------|-------------------|
| L1 | info | `resolve()` step 2 success | `Reusing persisted smee channel URL` | `{ channelUrl, source: 'persisted' }` |
| L2 | info | `resolve()` step 5 success | `Provisioned new smee channel URL` | `{ channelUrl, source: 'provisioned' }` |
| L3 | warn | `resolve()` step 2 malformed | `Persisted smee channel file has malformed content — re-provisioning` | `{ path, contentPreview }` (contentPreview truncated to 64 chars) |
| L4 | warn | `resolve()` step 3 exhausted | `Failed to provision smee channel after 2 attempts — cluster is webhook-less, falling back to polling` | `{ attempts: 2, lastError }` |
| L5 | warn | `resolve()` step 4 write-fail | `Provisioned smee channel URL but failed to persist — dropping URL to avoid orphaned GitHub webhook accumulation` | `{ path, error }` |

**Note**: L1 and L2 log the full URL. This is intentional — the URL was validated by the resolver (L1 by regex, L2 by regex on the Location header before persistence) so it's trustworthy. L3's `contentPreview` is deliberately truncated because malformed content might be arbitrary (a stray secret, an error message, an HTML fragment).

Additional log line in the pipeline path (already exists at `server.ts:496`, but now fires in the async path too):
- `Smee webhook receiver configured` — info, `{ channelUrl }`. Emitted by `startSmeePipeline()`.

## 10. Relationships

```
config.yaml / env vars
        │
        ▼
   Zod-validated                                       Filesystem
   OrchestratorConfig                                  /var/lib/generacy/
        │                                              smee-channel (mode 0600)
        │                                                    ▲
        │                                                    │ atomic .tmp + rename
        ├─ config.smee.channelUrl?  (Q2→C: fire-and-forget)  │
        │                                                    │
        └─ config.smee.channelFilePath                       │
                                                             │
                       ┌──────────────────────────┐          │
                       │  SmeeChannelResolver     │          │
                       │  .resolve()              │──write───┘
                       └───────────┬──────────────┘
                                   │
                                   │ presetUrl OR persisted OR provisioned
                                   │
                                   ▼
                       ┌──────────────────────────┐
                       │  startSmeePipeline(url)  │
                       └───────────┬──────────────┘
                                   │
                       ┌───────────┴────────────┐
                       ▼                        ▼
              SmeeWebhookReceiver     WebhookSetupService
              (services/smee-         (services/webhook-
               receiver.ts, unchanged) setup-service.ts, unchanged)
                       │                        │
                       │                        │
                       ▼                        ▼
              smee.io SSE stream       GitHub REST API
              (real-time events)       (create/reactivate webhook per repo)
```

## 11. No new persistent state beyond the single file

- No new Redis keys.
- No new relay message types.
- No new `.agency/` YAML fields.
- No new `cluster.json` fields.
- No changes to `credentials.dat`, `master.key`, `cluster-api-key`.

The entire on-disk footprint of this feature is one small text file at `/var/lib/generacy/smee-channel`.
