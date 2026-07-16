# Contract: `SmeeChannelResolver`

**File**: `packages/orchestrator/src/services/smee-channel-resolver.ts`
**Consumer**: `packages/orchestrator/src/server.ts` (single call site inside the `!isWorkerMode && config.labelMonitor && config.repositories.length > 0` gate)
**Feature**: #952

## Purpose

Resolve the smee channel URL for the orchestrator through a 4-tier precedence, persisting a fresh URL when we mint one. Fail open on any resolution failure so the cluster degrades to polling rather than crashing.

## Public API

```ts
export class SmeeChannelResolver {
  constructor(logger: Logger, options: SmeeChannelResolverOptions);
  async resolve(): Promise<SmeeChannelResolverResult | null>;
}

export interface SmeeChannelResolverOptions {
  channelFilePath: string;
  presetUrl?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface SmeeChannelResolverResult {
  channelUrl: string;
  source: 'env-or-yaml' | 'persisted' | 'provisioned';
}

export const SMEE_URL_PATTERN: RegExp; // /^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/
```

## Behavioral contract

### Tier precedence

Called in this order; the first tier to yield a URL returns. Later tiers do NOT run.

1. **env-or-yaml**: If `options.presetUrl` is set, return `{ channelUrl: presetUrl, source: 'env-or-yaml' }`. Zero side effects. Do NOT re-validate (trust Zod).
2. **persisted**: Read `options.channelFilePath`. If content matches `SMEE_URL_PATTERN` after trim, return `{ channelUrl: content, source: 'persisted' }` and log L1.
3. **provisioned**: `POST https://smee.io/new`. On success, write the URL to `options.channelFilePath` atomically, return `{ channelUrl, source: 'provisioned' }`, log L2.

### Failure handling per tier

- **Tier 1**: Cannot fail (either preset is set, or it's not).
- **Tier 2**:
  - ENOENT → silent fall-through to tier 3.
  - Other read errors (EACCES, EIO, EISDIR, …) → log warn once, fall through to tier 3. Do NOT retry the read.
  - Content present but doesn't match `SMEE_URL_PATTERN` → log L3 `{ path, contentPreview (max 64 chars) }`, fall through to tier 3. The successful tier-3 write will atomically overwrite the malformed file.
- **Tier 3**:
  - Each `POST /new` attempt uses `AbortSignal.timeout(5000)` and `redirect: 'manual'`.
  - On any failure (network error, non-302, missing/malformed Location header) — retry ONCE after 1s fixed delay. Total attempts = 2.
  - Both attempts failed → log L4 `{ attempts: 2, lastError }`, return `null`.
  - Successful `POST` → validate the `Location` header against `SMEE_URL_PATTERN` before accepting.
- **Tier 3 write** (post-provision):
  - Atomic: `writeFile(tmp, url, { mode: 0o600 })` then `rename(tmp, path)`. `mkdir({ recursive: true })` on parent.
  - Write failure → log L5 `{ path, error }`, **return `null`**. Do NOT return the in-memory URL. This is the Q5→A drop-URL contract.

### Return-value contract

- `SmeeChannelResolverResult` on any tier's success.
- `null` on tier-3 exhaustion (both provisions failed) or tier-3 write-fail.
- Never throws. If an unexpected error escapes (defensive), the caller in `server.ts` has a `.catch()` fallback that logs and skips the pipeline.

## Idempotency

- Boot 1 (no preset, no file): tier 3 provisions + writes. Cost: 1 HTTP call, 1 file write.
- Boot 2+ with file present and valid: tier 2 succeeds. Cost: 1 file read. Zero HTTP calls, zero writes.
- Boot 2+ with file corrupted (crash mid-write, hand-edit): tier 2 fails validation → tier 3 provisions + overwrites atomically. Cost: 1 file read + 1 HTTP call + 1 file write.
- Boot 2+ with env/yaml URL set: tier 1 succeeds. Cost: zero I/O of any kind. File is ignored, not read, not written.

## Concurrency

- The resolver is single-threaded — called once from a single `.then()` callback in `server.ts`. No internal locking.
- Two orchestrator processes racing on the same volume is unsupported (see plan.md Risk 5). If needed later, add `flock` on `${channelFilePath}.lock` per the credhelper file-store pattern.

## Timeouts and retries — exact numbers

| Parameter | Value | Source |
|-----------|-------|--------|
| HTTP timeout per attempt | 5000 ms | Q1→B |
| Attempts per boot | 2 | Q4→B |
| Delay between attempts | 1000 ms fixed | Q4→B |
| Worst-case tier-3 time | ~11 s (5 + 1 + 5) | derived |
| Startup-listen impact | 0 ms | Q2→C: async fire-and-forget |

## Log contract

See `data-model.md` §9 for the L1–L5 log-line vocabulary and structured-field schema.

## Testing contract

Test file: `packages/orchestrator/src/services/__tests__/smee-channel-resolver.test.ts`. Must cover:

- **T1**: presetUrl set → returns `{ source: 'env-or-yaml' }`, does not read file, does not fetch.
- **T2**: file exists + valid → returns `{ source: 'persisted' }` with the file's content, does not fetch, does not write.
- **T3**: file exists + malformed → logs L3 with truncated contentPreview, calls fetch, on success overwrites file, returns `{ source: 'provisioned' }`.
- **T4**: file missing (ENOENT) → silently proceeds to tier 3 (no warn).
- **T5**: file read error (EACCES) → warn, proceeds to tier 3.
- **T6**: tier 3 first attempt fails (network) → 1s sleep, second attempt succeeds → returns `{ source: 'provisioned' }`.
- **T7**: tier 3 both attempts fail → logs L4, returns `null`.
- **T8**: tier 3 succeeds but Location header missing → treated as attempt-failure, retries.
- **T9**: tier 3 succeeds but Location header shape wrong (`https://evil.com/x`) → treated as attempt-failure, retries.
- **T10**: tier 3 succeeds but persistence write fails (mode 0000 dir) → logs L5, returns `null` (does NOT return the in-memory URL).
- **T11**: tier 3 timeout (fetch never returns) → 5s AbortError → treated as attempt-failure, retries. Test uses injected `fetch` stub that returns a pending promise + verifies `AbortSignal.timeout` fires.
- **T12**: written file has mode 0600. `fs.stat().mode & 0o777 === 0o600`.
- **T13**: written file has no trailing newline. `readFileSync().toString() === url`.
- **T14**: file with trailing newline → trimmed on read, still matches regex, still returned. (Defense against hand-edit.)

## Non-goals for this class

- Does NOT wire the `SmeeWebhookReceiver`. Consumer's job.
- Does NOT call `ensureWebhooks`. Consumer's job.
- Does NOT emit relay events. No new relay message types.
- Does NOT expose a `refresh()` or "provision on demand" method. Boot-time only. If a future feature needs runtime re-provisioning, add it then.
- Does NOT prune orphaned webhooks on the repo. Q3→A refinement 2 explicitly forbids this.
- Does NOT read `.generacy/config.yaml` — that's config loader's job; the resolver only sees the post-load `presetUrl` field.
