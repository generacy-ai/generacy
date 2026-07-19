# Contract: `WebhookSetupService.findExistingSmeeChannel(repos)`

**Issue**: [#1005](https://github.com/generacy-ai/generacy/issues/1005)
**Scope**: `packages/orchestrator/src/services/webhook-setup-service.ts`

## Signature

```ts
public async findExistingSmeeChannel(
  repos: RepositoryConfig[],
): Promise<string | null>
```

**Public** (not underscore-prefixed) — `SmeeChannelResolver`'s adopt tier calls it as an injected `discoverExistingChannel` callback via `webhookSetupService.findExistingSmeeChannel.bind(webhookSetupService)`.

## Return contract

- **Hit** → resolved with a validated `https://smee.io/…` URL string. Never returns malformed URLs; anything that would fail `SMEE_URL_PATTERN` is filtered out.
- **Miss** → resolved with `null` — no matching hook found across all repos, or all repos' `_listRepoWebhooks` calls threw. The resolver treats miss as fall-through-to-provision.
- **Never throws.** All per-repo errors are caught, logged, and skipped; the method continues to the next repo. This is the load-bearing property that keeps the resolver's fail-open contract intact.

## Discovery algorithm

```
chosenUrl = null
chosenRepo = null

for each { owner, repo } in repos, in iteration order:
  try:
    hooks = await this._listRepoWebhooks(owner, repo)
  catch (err):
    logger.warn({ owner, repo, error: String(err) },
                'Failed to list webhooks during smee channel discovery — skipping repo')
    continue

  smeeHook = hooks.find(h => (h.config?.url ?? '').toLowerCase().startsWith('https://smee.io/'))
  if !smeeHook: continue

  url = smeeHook.config.url
  if !SMEE_URL_PATTERN.test(url):
    logger.warn({ owner, repo, url },
                'Repo webhook has smee-prefixed URL that does not match SMEE_URL_PATTERN — skipping')
    continue

  if chosenUrl == null:
    chosenUrl = url
    chosenRepo = { owner, repo }
    continue

  if url != chosenUrl:                              # FR-004 divergence
    logger.warn({
      chosenRepo: `${chosenRepo.owner}/${chosenRepo.repo}`,
      chosenUrl,
      divergentRepo: `${owner}/${repo}`,
      divergentUrl: url,
    }, 'Repo Generacy smee channel disagrees with first-repo winner — deferring to take-over on next self-heal')

return chosenUrl
```

## Rules locked by clarifications

### Q1-A — URL-prefix-only identifier

A hook is considered Generacy-owned iff its `config.url` starts with `https://smee.io/` (case-insensitive). No `config`-shape check, no event-list check, no marker. Matches the classifier at `webhook-setup-service.ts:498-504`.

Implementation note: use `.toLowerCase().startsWith('https://smee.io/')` for the prefix check to match the existing case-insensitive discipline; validate the raw (non-lowercased) URL against `SMEE_URL_PATTERN` for shape.

### Q2-A — First-repo-first-hook wins

Iteration order = the order `repos` is passed in (the caller passes `config.repositories`, whose order is the configured `repos` array). The **first** smee.io hook found on the **first** repo becomes `chosenUrl`. Later repos whose first smee.io hook disagrees do NOT change the choice — they only emit a `warn` log per divergent repo.

The divergence log is a signal of legacy multi-cluster state and drives ops attention; convergence happens automatically on subsequent self-heal passes via the take-over branch.

### Q1-A — Multiple smee hooks on one repo → first match wins

Within a single repo, if `_listRepoWebhooks` returns multiple `https://smee.io/…` hooks, use `.find(…)` (first match wins). Do NOT scan all hooks looking for a "best" one — the extras are legacy cruft (D3 in research.md) and adopt should not try to reason about their relative freshness.

### Per-repo error handling

- **`_listRepoWebhooks` throws** (403, 404, network error, malformed JSON) → log `warn`, skip repo, continue. Does NOT abort discovery — one repo's 403 must not poison the adopt tier for the whole cluster.
- **Repo returns empty hook list** → no log, continue silently.
- **Repo returns hooks but no smee.io hook** → no log, continue silently.

## Interaction with the resolver's retry envelope

The resolver's `runAdoptTier` retries `discoverExistingChannel` up to `MAX_ATTEMPTS = 2` on throw. `findExistingSmeeChannel` MUST NOT throw (see "Never throws" above). Consequently the resolver's retry loop will only re-execute discovery in the case of a JS-level exception (e.g., `undefined` property access, allocation failure) — practically never. The retry is a defense-in-depth guard, not a routine failure path.

The intended failure spectrum:

- **All repos succeeded, no smee hooks found** → returns `null` → resolver falls through to provision.
- **Some repos succeeded, one hit** → returns URL → resolver adopts.
- **All repos' `_listRepoWebhooks` threw** → per-repo warn logs, returns `null` → resolver falls through to provision. Take-over branch will heal on next self-heal.

## Log lines (exact wording)

| Situation | Level | Message |
|-----------|-------|---------|
| Per-repo `_listRepoWebhooks` threw | `warn` | `Failed to list webhooks during smee channel discovery — skipping repo` |
| Per-repo smee hook URL failed `SMEE_URL_PATTERN` | `warn` | `Repo webhook has smee-prefixed URL that does not match SMEE_URL_PATTERN — skipping` |
| Later repo disagrees with chosen URL | `warn` | `Repo Generacy smee channel disagrees with first-repo winner — deferring to take-over on next self-heal` |

Structured fields per the algorithm; consistent `owner`/`repo` naming.

## Test surface

- T-find-1..5 in plan.md §Line-of-effect. T-find-4 (multi-repo divergence) is the load-bearing FR-004 assertion — MUST assert both (a) the return value is the first-repo URL and (b) one `warn` fires per divergent repo.
