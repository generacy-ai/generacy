# Contract: `SmeeChannelResolver` — adopt-existing tier

**Issue**: [#1005](https://github.com/generacy-ai/generacy/issues/1005)
**Scope**: `packages/orchestrator/src/services/smee-channel-resolver.ts`

## Tier ordering (post-fix)

```
resolve():
  1. env-or-yaml preset    (unchanged)   → return { source: 'env-or-yaml' }
  2. persisted file        (unchanged)   → return { source: 'persisted' }
  3. NEW: adopt-existing                 → return { source: 'adopted' }  | fall through
  4. provisioned           (unchanged)   → return { source: 'provisioned' } | null
```

First tier that returns a non-null result wins. Every tier folds all failure modes into `null` and falls through — never throws.

**Key invariant (FR-010, SC-003)**: Tier 3 (adopt) MUST NOT run when tier 2 (persisted) returns a valid URL. The persisted-hit fast path issues zero GitHub API calls. Enforced by the strict `if (persisted) return …` short-circuit at `smee-channel-resolver.ts:85-93` — no change needed except that the new tier 3 code lives *after* that return.

## Tier-3 activation predicate

Tier 3 executes only when ALL of:

1. `options.discoverExistingChannel` is a function.
2. `options.repos` is a non-empty array.
3. Tier 2 returned `null` (persisted file missing / malformed / unreadable).

If any predicate fails, tier 3 is skipped and control flows to tier 4 (provision) as before.

## `runAdoptTier()` behavior

```ts
private async runAdoptTier(): Promise<string | null>
```

**Inputs (from `this.options`)**:
- `discoverExistingChannel: (repos) => Promise<string | null>` — trusted, but return value is validated defensively.
- `repos: RepositoryConfig[]` — passed through to the callback unchanged.

**Retry envelope**: reuse the existing `MAX_ATTEMPTS = 2` and `RETRY_DELAY_MS = 1000` constants at `smee-channel-resolver.ts:32`. Reuse `this.sleepImpl` for the inter-attempt delay so tests can inject.

```
lastError = undefined
for attempt in 1..MAX_ATTEMPTS:
  try:
    result = await discoverExistingChannel(repos)
  catch (err):
    lastError = err.message
    if attempt < MAX_ATTEMPTS: await sleep(RETRY_DELAY_MS)
    continue

  if result == null:
    return null                     # miss — fall through immediately, no retry

  if !SMEE_URL_PATTERN.test(result):
    logger.warn({ result, source: 'adopted' }, 'Adopt callback returned URL not matching SMEE_URL_PATTERN — falling through')
    return null                     # malformed — fall through immediately, no retry

  return result                     # hit — validated URL

if lastError:
  logger.warn({ attempts: MAX_ATTEMPTS, lastError, source: 'adopted' }, 'Adopt callback failed after N attempts — falling through to provision')
return null
```

**Retry semantics**:
- **Throw / timeout** → retry once (up to MAX_ATTEMPTS total = 2 attempts).
- **Return `null`** → no retry. `null` means "no matching hook found" — a legitimate miss, not a transient failure.
- **Return malformed URL** → no retry. Same reasoning; treated as a legit "no clean match".

## Persist-on-adopt

On tier-3 hit, the resolver MUST:

1. Call `writePersistedFile(url)` — reuse the existing method verbatim.
2. Call `mirrorToWorkspace(url)` — reuse the existing method verbatim (unguarded write, matching the tier-4 behavior).
3. `logger.info({ channelUrl: url, source: 'adopted' }, 'Adopted existing smee channel URL from repo webhook')`.
4. Return `{ channelUrl: url, source: 'adopted' }`.

**Persist failure divergence from tier 4**. `provisioned` returns `null` on persist failure (`smee-channel-resolver.ts:97-105`) because the fresh channel would otherwise become an untracked orphan. `adopted` MUST NOT return `null` on persist failure — the channel already existed on GitHub before this boot and the resolver is only reusing it. Persist failure means the next boot re-runs the adopt tier (no cost beyond one `_listRepoWebhooks` call per repo), so a `warn` + still-return `{ source: 'adopted' }` is correct.

```ts
const persisted = await this.writePersistedFile(url);
if (!persisted) {
  this.logger.warn(
    { path: this.options.channelFilePath, url },
    'Adopted smee channel URL but failed to persist — next boot will re-run adopt tier',
  );
}
await this.mirrorToWorkspace(url);
this.logger.info({ channelUrl: url, source: 'adopted' }, 'Adopted existing smee channel URL from repo webhook');
return { channelUrl: url, source: 'adopted' };
```

## Log lines (exact wording)

| Situation | Level | Message |
|-----------|-------|---------|
| Successful adopt | `info` | `Adopted existing smee channel URL from repo webhook` |
| Callback returned malformed URL | `warn` | `Adopt callback returned URL not matching SMEE_URL_PATTERN — falling through` |
| Callback threw twice | `warn` | `Adopt callback failed after N attempts — falling through to provision` |
| Persist-on-adopt failed | `warn` | `Adopted smee channel URL but failed to persist — next boot will re-run adopt tier` |

Structured fields are the same across sites: `{ channelUrl, source, path?, attempts?, lastError? }` as applicable.

## Non-goals for this contract

- `provision()` behavior — unchanged.
- `readPersistedFile()` — unchanged.
- `mirrorToWorkspace*` — unchanged; called from the new tier via the existing methods.
- Tier-1 (preset) — unchanged.
- Any DI shape outside `SmeeChannelResolverOptions.repos` / `.discoverExistingChannel`.

## Test surface (see plan.md §Line-of-effect)

- T-adopt-1..6 for the resolver-side branches above.
- T-adopt-7 explicitly asserts SC-003: with a valid persisted file, `discoverExistingChannel` MUST NOT be called (vitest `expect(cb).not.toHaveBeenCalled()`).
