# Data Model: PR-feedback CLI self-commit detection

**Feature**: `1073-problem-when-pr-feedback`

This fix is producer-side and additive. It touches label vocabulary (one new entry) and handler-internal local state (one new `const`). No public API signature changes, no persisted state, no schema migrations.

---

## New label vocabulary

### `blocked:resolve-failed`

Registered in `packages/workflow-engine/src/actions/github/label-definitions.ts` as the fifth entry in the `blocked:*` family.

```ts
{
  name: 'blocked:resolve-failed',
  color: 'D73A4A',
  description: 'PR-feedback code changes landed but thread reply/resolve failed — check GitHub API responses (#1073).',
}
```

**Applied by**: `PrFeedbackHandler.handle()` at the retargeted `resolveSuccesses === 0` branch (`:625-633`), when the branch HEAD SHA advanced during the CLI invocation (i.e., `cliSelfCommitted === true` OR `hasChanges === true`).

**Removed by**: operator (manual `gh issue edit --remove-label blocked:resolve-failed`). No automatic re-dispatch — resolve failures are GitHub-API-shaped, not fixer-shaped, so a retry with the same inputs would not help.

**Interaction with monitor**: falls under the pre-existing `blocked:*` short-circuit in `PrFeedbackMonitorService` at `pr-feedback-monitor-service.ts:373-389`, which pauses the trigger until the label clears. Zero monitor-side changes needed (this is #1070's model).

---

## Handler-local state

### `postCliSha: string | null`

Local `const` captured in `PrFeedbackHandler.handle()` immediately after `spawnClaudeForFeedback()` returns and before `evaluatePushGuard()` runs.

```ts
const postCliSha = await this.getHeadSha(checkoutPath);
```

`null` when `git rev-parse HEAD` fails (matches the fallback shape of `preFixSha` at `:453`).

### `cliSelfCommitted: boolean`

Local `const` derived from the two SHAs. Load-bearing definition — the negation-carrying nulls are what makes this safe on `git`-failure paths.

```ts
const cliSelfCommitted =
  postCliSha !== null && preFixSha !== null && postCliSha !== preFixSha;
```

Truth table:

| `preFixSha` | `postCliSha` | Equal? | `cliSelfCommitted` | Semantics |
|-------------|--------------|--------|---------------------|-----------|
| `'sha-A'`   | `'sha-A'`    | yes    | `false`             | No commit landed during the cycle (handler falls through to existing B1/B2/B3). |
| `'sha-A'`   | `'sha-B'`    | no     | `true`              | Head advanced during the cycle — happy path. |
| `null`      | `'sha-B'`    | n/a    | `false`             | Pre-fix git read failed → safe direction: treat as no-CLI-commit. |
| `'sha-A'`   | `null`       | n/a    | `false`             | Post-fix git read failed → safe direction: treat as no-CLI-commit. |
| `null`      | `null`       | n/a    | `false`             | Both git reads failed → safe direction. |

**Consumer**: two decision points in the same method:
1. `:577` — retargeted B1/B2/B3 gate: `if (!cliSelfCommitted && (!success || !hasChanges))`.
2. `:625` — retargeted `resolveSuccesses === 0` gate: `head-advanced → blocked:resolve-failed`; `head-unchanged → blocked:stuck-feedback-loop`.

Semantically, decision point 2 could equivalently use `postCliSha !== preFixSha` directly (with `null`-guard) instead of the `cliSelfCommitted` boolean. Using the same `cliSelfCommitted` variable keeps the two decisions synchronized — a future edit to the definition automatically applies to both.

---

## Log payload shape (new / modified fields)

### CLI-self-commit info line (new)

```ts
{
  prNumber,
  issueNumber,
  source: 'cli',
  disposition: 'cli-self-committed',
  preFixSha,             // full SHA (FR-008a — auditable, load-bearing)
  postFixSha: postCliSha, // full SHA (FR-008a)
}
// message: 'CLI self-committed changes — proceeding to reply/resolve'
```

### Handler-commit info line (modified — adds `source`)

```ts
// existing at :503-506
{ prNumber, issueNumber, source: 'handler' }
// message unchanged: 'Successfully pushed changes to PR branch'
```

### Handler timeout-partial warn line (modified — adds `source`)

```ts
// existing at :508-511
{ prNumber, issueNumber, cliCompleted: false, exitCode, source: 'handler' }
// message unchanged: 'Pushed partial changes before CLI timed out — retry may follow'
```

### `resolveSuccesses === 0` warn line (modified — differentiates by `cliSelfCommitted`)

Existing warn at `:627-630`:
```
'commit pushed but resolve batch had zero successes — persisting trigger, entering blocked-stuck-feedback-loop disposition'
```

New shape — one of two branches depending on `cliSelfCommitted`:
```
// cliSelfCommitted === true (head advanced):
'commit pushed but resolve batch had zero successes — entering blocked:resolve-failed disposition (#1073)'

// cliSelfCommitted === false (head unchanged):
// unchanged text — the pre-existing branch preserved verbatim
```

---

## Unchanged surfaces (explicit non-goals per FR-011)

- `PrFeedbackMetadata` (`packages/orchestrator/src/types/monitor.ts:38-43`) — no new fields.
- `QueueItem` — no changes.
- `PrFeedbackMonitorService` — no changes, including no changes to the `blocked:*` short-circuit at `:373-389`.
- `SpawnClaudeResult` (widened by #1070) — reused as-is.
- `evaluatePushGuard` and `handlePushRefused` (#1051) — not touched; the guard fires ahead of the SHA capture and short-circuits on refusal.
- `getHeadSha` / `getHeadShortSha` — reused, not modified.
- All five existing `add*BlockedLabel` methods — untouched (`addBlockedResolveFailedLabel` is a sibling, not a replacement).
