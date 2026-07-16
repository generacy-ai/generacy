# Implementation Plan: Auto-provision smee.io channel on orchestrator startup

**Feature**: On orchestrator startup, resolve the smee channel URL through env → workspace-yaml → persisted file → self-provision (`POST https://smee.io/new`), persist the result to `/var/lib/generacy/smee-channel`, and let the existing `SmeeWebhookReceiver` + `WebhookSetupService.ensureWebhooks(...)` flow wire up the GitHub webhook. Every automated provisioning path (local CLI, cloud onboarding, cloud deploy) currently ships an empty `SMEE_CHANNEL_URL`, so every new cluster silently runs webhook-less and degrades to polling. Fixing it in the orchestrator covers all paths in one place and ships via npm on `@channel`, so existing clusters pick it up on restart.
**Branch**: `952-summary-no-automated-cluster`
**Date**: 2026-07-16
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md)
**Status**: Complete

## Summary

The orchestrator today reads `config.smee.channelUrl` from env (`SMEE_CHANNEL_URL` / `ORCHESTRATOR_SMEE_CHANNEL_URL`) or from `.generacy/config.yaml`'s `orchestrator.smeeChannelUrl`. When neither is set — the case for **every** automated provisioning path (`packages/generacy/src/cli/commands/cluster/scaffolder.ts` writes `SMEE_CHANNEL_URL=`; cloud onboarding + cloud deploy do the same) — `config.smee.channelUrl` stays `undefined` and two things are silently skipped at `server.ts:487` and `server.ts:824`: `SmeeWebhookReceiver` is never constructed and `WebhookSetupService.ensureWebhooks()` never runs. The cluster falls back to polling with a **≤90s** worst-case latency (`COMPLETED_CHECK_INTERVAL = 3` at `label-monitor-service.ts:83` × 30s poll) for resume-triggering `completed:*` labels.

**Fix**: introduce a `SmeeChannelResolver` service in `packages/orchestrator/src/services/smee-channel-resolver.ts` that runs at server-ready time inside the existing `!isWorkerMode && config.labelMonitor && config.repositories.length > 0` gate (the same one that constructs `SmeeWebhookReceiver` at `server.ts:464`). The resolver implements a 4-tier lookup — env, workspace yaml, persisted file, self-provision — and returns the resolved URL. On resolution success, the orchestrator constructs `SmeeWebhookReceiver` + calls `ensureWebhooks(...)` via the existing code path (the block at `server.ts:814-829` is factored into a helper `startSmeePipeline(url)` invoked either synchronously with the pre-existing `config.smee.channelUrl` OR asynchronously with the resolver's result). On resolution failure, structured warn log, no receiver, cluster continues webhook-less — identical to today's behavior on empty config.

**Persistence path**: `/var/lib/generacy/smee-channel`, mode `0600`, alongside `cluster-api-key`, `cluster.json`, `master.key`, `credentials.dat`. Overridable via new `config.smee.channelFilePath` (default `/var/lib/generacy/smee-channel`) following the `keyFilePath` / `clusterJsonPath` convention at `config/schema.ts:216-218`.

**Design decisions locked by clarifications**:

- **Q1→B**: HTTP timeout **5s** for `POST https://smee.io/new`. `AbortSignal.timeout(5000)` on the `fetch()`.
- **Q2→C**: **Fully async, fire-and-forget**, gated on `!isWorkerMode && config.labelMonitor && config.repositories.length > 0` (identical predicate to `server.ts:464`). Never blocks `server.listen()`. On the wizard cluster's first boot (no repos, no credentials) the predicate is `false` and the resolver never runs — the guaranteed post-activation restart picks it up on boot 2 via the persisted file (or provisions then).
- **Q3→A**: On persisted content that doesn't match `^https://smee\.io/[A-Za-z0-9]+$`, log warn, **re-provision**, overwrite the file. Do NOT prune "foreign" smee webhooks on the repo to compensate — a single repo may be legitimately monitored by multiple clusters (spec `284-problem-when-multiple`).
- **Q4→B**: **2 attempts with a 1s fixed delay** for `POST /new` failures within a single boot. Third attempt adds nothing over the guaranteed post-activation restart.
- **Q5→A**: If provisioning succeeds but persistence write fails, **drop the URL** — warn log, skip both `SmeeWebhookReceiver` and `ensureWebhooks`. A channel we can't reproduce on next boot would accumulate one orphaned GitHub webhook per restart.

**Non-goals** (deliberate):

- No changes to `SmeeWebhookReceiver` (`services/smee-receiver.ts`) or `WebhookSetupService` (`services/webhook-setup-service.ts`) internals. The fix supplies the URL; those services consume it as they do today.
- No changes to any provisioning path outside the orchestrator (CLI scaffolder, cloud onboarding template, cloud deploy template). Spec §"Why the orchestrator, and not each provisioning path" — one implementation covers all paths.
- No adaptive-polling change — that's #953.
- No "running webhook-less" telemetry — that's #954.
- No pruning of orphaned webhooks — explicitly rejected in Q3 refinement.
- No smee URL written into `.generacy/config.yaml` — that file is committed to the project repo; smee URLs are unauthenticated capability URLs.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js ≥22 (per orchestrator package). `AbortSignal.timeout()` requires Node ≥17.3 / ≥16.14; ≥22 covers it.
**Primary Dependencies**: native `fetch` + `AbortSignal.timeout` for the HTTP call (no `undici` import needed on Node ≥22); native `node:fs/promises` for atomic write; `pino` (Logger); `zod` for schema field; `vitest` for tests. **No new package dependencies.**
**Storage**: single file `/var/lib/generacy/smee-channel`, mode `0600`, atomic write via `.tmp` + `rename()` (identical pattern to `activation/persistence.ts:25-36`). Volume `/var/lib/generacy` is mounted rw and node-owned; already used for `cluster-api-key`, `cluster.json`, `master.key`, `credentials.dat`.
**Testing**: `vitest`. Affected suites:
- `packages/orchestrator/src/services/__tests__/smee-channel-resolver.test.ts` — NEW. Covers the full precedence order (env > yaml > file > provision), URL-shape validation for the persisted file (Q3→A), 2-attempt retry with 1s delay (Q4→B), 5s timeout (Q1→B), persistence-write failure → drop URL (Q5→A), corrupt-file re-provision + overwrite (Q3→A).
- `packages/orchestrator/src/services/__tests__/smee-receiver.test.ts` — untouched (behavior unchanged; only the URL source changes).
- `packages/orchestrator/src/services/__tests__/webhook-setup-service.test.ts` — untouched (behavior unchanged).
- `packages/orchestrator/src/__tests__/server-smee-provisioning.test.ts` — NEW integration test. Drives `createServer()` with `config.smee.channelUrl = undefined` and a repositories-configured workspace; stubs `fetch` to return a 302 with `Location: https://smee.io/abc123`; asserts (a) the file at `channelFilePath` is written with mode 0600 and content `https://smee.io/abc123`, (b) `SmeeWebhookReceiver` is constructed **after** `server.listen()` returns (fire-and-forget invariant, Q2→C), (c) `ensureWebhooks` is called with the provisioned URL. Second test: worker-mode → resolver never invoked (Q2→C predicate). Third test: pre-activation wizard mode (empty `repositories`) → resolver never invoked, no `smee-channel` file created.

**Target Platform**: Node orchestrator process inside cluster container. `/var/lib/generacy` is a bind-mounted host volume in the compose file.
**Project Type**: Monorepo package (`packages/orchestrator`). No cross-package changes. Zero changes required in `packages/generacy` (CLI scaffolder) or `packages/cluster-relay`.
**Performance Goals**: N/A. One HTTP call once per cluster lifetime (later boots read the persisted file). Async off the listen path.
**Constraints**:
- Zero new package dependencies.
- `SmeeWebhookReceiver` and `WebhookSetupService` signatures unchanged.
- `config.smee.channelUrl` semantic unchanged from the consumer's perspective — the resolver just widens the set of paths that can populate it (via the pipeline helper) beyond env/yaml.
- Provisioning must never block `server.listen()` (Q2→C).
- Persistence write must be atomic (`.tmp` + `rename`) to avoid the "torn write on crash" case that Q3 addresses (FR-004 in spec).
- Never write the URL to `.generacy/config.yaml`. Cluster-local state only.
- Never prune webhooks on the repo to compensate for orphan risk (Q3 refinement 2).
- On the exact overlap `config.smee.channelUrl` (env/yaml already set) → resolver is a no-op; the pipeline uses the pre-existing URL. Prevents the "env says X, file says Y, we write X and mint Z" race.

**Scale/Scope**: 1 new source file (`services/smee-channel-resolver.ts`, ~120 LOC), 1 modified source file (`server.ts`, ~40 LOC delta for the pipeline factoring + gated invocation), 1 modified schema file (`config/schema.ts`, ~4 LOC delta for `channelFilePath`), 2 new test files (~250 LOC). No changes to `smee-receiver.ts`, `webhook-setup-service.ts`, or any CLI/scaffolder.

## Constitution Check

*GATE: no constitution file at `.specify/memory/constitution.md`. Repository-wide invariants from `CLAUDE.md`, clarifications, and adjacent completed epics:*

| Gate | Result | Note |
|------|--------|------|
| No premature abstractions / no half-finished implementations | PASS | One new service class with a single public method (`resolve(): Promise<string \| null>`); one new optional config field (`channelFilePath`); one small helper factoring in `server.ts` (`startSmeePipeline(url)`). No plugin hook, no interface split, no strategy pattern for the 4 tiers — it's a 4-branch async function. |
| Match spec Q&A intent, not just the letter | PASS | Q1→B (5s AbortSignal), Q2→C (post-listen fire-and-forget, gated on the receiver-construction predicate), Q3→A (strict `https://smee.io/<id>` regex, re-provision on mismatch, no webhook pruning), Q4→B (2 attempts, 1s fixed delay), Q5→A (drop the URL on persist-fail) — all encoded verbatim in the resolver's decision points and mirrored in the test cases named for each clarification. |
| No backwards-compat shims for removed code | PASS | Nothing removed. Empty-config path (no env, no yaml, no repos, no receiver) behaves exactly as today. Existing clusters with a hand-set `SMEE_CHANNEL_URL` skip the resolver entirely (the pre-existing URL wins). The pre-existing `tetrad-development` cluster with the hardcoded `https://smee.io/mNhnxyK56d9qkZo` in its env continues to use that URL. |
| Trust framework guarantees, don't over-validate | PASS | Zod already validates `smee.channelUrl` as `z.string().url()`. The resolver's strict regex (`^https://smee\.io/[A-Za-z0-9_-]+$`) applies only to the **persisted file** (Q3→A refinement 1) because a torn write or hand-edit is the failure mode being defended against. Env / yaml values are trusted (Zod-validated at load) — the resolver does not re-validate them. |
| Structured logging conventions | PASS | 5 new log lines, all at the existing cadence: (a) info at successful provision (`{ channelUrl, source: 'provisioned' }`), (b) info at successful reuse of persisted (`{ channelUrl, source: 'persisted' }`), (c) warn on corrupt persisted content (`{ path, contentPreview }` — truncated to 64 chars, never logs a full URL that might have been a stray secret), (d) warn on all-attempts-exhausted provision failure (`{ attempts: 2, lastError }`), (e) warn on persistence-write failure post-provision (`{ path, error }`). Never logs the raw URL at level ≥ info if it came from an unvalidated persisted file. |
| Don't add features beyond what the task requires | PASS | No adaptive-polling changes (#953), no webhook-less telemetry (#954), no CLI change, no cloud change, no `.generacy/config.yaml` write, no orphan pruning, no per-repo isolation, no health-check field. Just the 4-tier resolver + the pipeline factoring. |
| Changesets gate | PASS | `.changeset/952-orchestrator-smee-auto-provision.md` MUST be added by the implement phase. Bump level: `minor` — `@generacy-ai/orchestrator` gains new resolver behavior (new capability). No other packages touched, so no other entries. |

Post-Phase-1 re-check: no violations introduced.

## Project Structure

### Documentation (this feature)

```text
specs/952-summary-no-automated-cluster/
├── spec.md              # (present, unchanged by /plan)
├── clarifications.md    # (present, unchanged by /plan)
├── plan.md              # THIS FILE
├── research.md          # Phase 0 output — smee.io /new contract, existing precedent (activation/persistence.ts), why not extract a generic "resolver framework"
├── data-model.md        # Phase 1 output — SmeeChannelResolverOptions, ChannelSource enum, config schema addition (channelFilePath), file format contract
├── quickstart.md        # Phase 1 output — repro the bug on snappoll, verify fix, verify persistence across restart, verify offline fail-open
├── contracts/
│   ├── smee-channel-resolver.md      # 4-tier resolve() contract, retry, timeout, validation, persistence semantics
│   ├── smee-channel-file.md          # On-disk file format, mode, path, validation regex, corruption handling
│   └── server-pipeline.md            # startSmeePipeline() helper contract, gating predicate, async fire-and-forget invariant
└── checklists/          # (empty)
```

### Source Code (repository root)

```text
packages/orchestrator/src/
├── services/
│   ├── smee-channel-resolver.ts               # NEW — 4-tier resolver (env pass-through, yaml pass-through, persisted file, provision + persist). ~120 LOC.
│   └── __tests__/
│       └── smee-channel-resolver.test.ts      # NEW — precedence, retry (Q4), timeout (Q1), validation (Q3), persist-fail-drop (Q5). ~180 LOC.
├── config/
│   └── schema.ts                              # MODIFIED — SmeeConfigSchema gains `channelFilePath: z.string().default('/var/lib/generacy/smee-channel')`. ~4 LOC delta.
├── server.ts                                  # MODIFIED — extract inline "construct receiver + call ensureWebhooks" (lines 486-497 + 814-829) into `startSmeePipeline(url)` helper; inside the existing gate at line 464, if `config.smee.channelUrl` is set, invoke pipeline synchronously with it; otherwise kick off `SmeeChannelResolver.resolve()` post-`server.listen()` in the `onReady` block and pipe the result into `startSmeePipeline(url)` on success. ~40 LOC delta.
└── __tests__/
    └── server-smee-provisioning.test.ts       # NEW — integration test asserting fire-and-forget invariant, worker-mode skip, wizard-mode skip, provisioned URL is persisted and threaded into receiver + ensureWebhooks. ~70 LOC.

.changeset/
└── 952-orchestrator-smee-auto-provision.md    # NEW — added by implement phase per CLAUDE.md changeset gate. Bump: `@generacy-ai/orchestrator` minor.
```

**Structure Decision**: The resolver lives under `packages/orchestrator/src/services/` alongside its peers (`webhook-setup-service.ts`, `smee-receiver.ts`, `cluster-api-key-probe.ts`, `credential-expiry-watcher.ts`). It does not go into `packages/orchestrator/src/activation/` (that directory is scoped to the cluster-API-key device-flow, a different concern) and it does not go into a new `packages/smee-client` package (single consumer, no reuse; the spec's §"Why the orchestrator, and not each provisioning path" is the whole point of keeping it here). The `startSmeePipeline(url)` helper is a small closure inside `server.ts` — not a new file — because it captures `labelMonitorService`, `config`, `server.log`, and `githubTokenProvider` from the enclosing scope and has exactly one caller (two invocation sites but from the same scope).

## Design Overview

### `SmeeChannelResolver` public shape

```ts
// packages/orchestrator/src/services/smee-channel-resolver.ts

export type ChannelSource = 'env-or-yaml' | 'persisted' | 'provisioned';

export interface SmeeChannelResolverOptions {
  /** Absolute path to the persisted channel file. From config.smee.channelFilePath. */
  channelFilePath: string;
  /** Optional. If provided, resolver returns it without touching the file or the network. Wired from config.smee.channelUrl. */
  presetUrl?: string;
  /** Injected for tests. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injected for tests. Defaults to a resolved-promise setTimeout wrapper. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SmeeChannelResolverResult {
  channelUrl: string;
  source: ChannelSource;
}

export class SmeeChannelResolver {
  constructor(private readonly logger: Logger, private readonly options: SmeeChannelResolverOptions) {}

  /**
   * Resolve the smee channel URL. Returns null if all tiers fail (including
   * the terminal Q5→A "persist-write-failed → drop URL" branch).
   *
   * Never throws — every failure mode is logged internally and folds into
   * `return null`. Server ready hook contract: caller checks for non-null
   * and only then wires SmeeWebhookReceiver + ensureWebhooks.
   */
  async resolve(): Promise<SmeeChannelResolverResult | null> { /* … */ }
}

export const SMEE_URL_PATTERN = /^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/;
```

### Resolution flow (matches Q1–Q5 verbatim)

```
resolve():
  1. If options.presetUrl → return { channelUrl: presetUrl, source: 'env-or-yaml' }.
     (env/yaml already validated by Zod at load; no re-validation.)

  2. Read options.channelFilePath. If exists and content matches SMEE_URL_PATTERN
     → log info, return { channelUrl: content, source: 'persisted' }.
     If exists but malformed → log warn { path, contentPreview }, DELETE not required
     (step 4 overwrites atomically). Fall through to step 3.
     If ENOENT → fall through silently.

  3. Attempt provision: POST https://smee.io/new with AbortSignal.timeout(5000).
     - Expect 302 with Location header pointing at https://smee.io/<id>.
     - Retry ONCE (total attempts = 2) on any of: network error, non-302 status,
       missing/malformed Location, timeout. Fixed 1s delay between attempts.
     - Validate the Location value with SMEE_URL_PATTERN before accepting.
     - On both attempts failed → log warn { attempts: 2, lastError }, return null.

  4. Write the provisioned URL to options.channelFilePath atomically:
     - mkdir -p parent (recursive), mode default.
     - writeFile(tmp, url, { mode: 0o600 }).
     - rename(tmp, channelFilePath).
     - On write failure → log warn { path, error }, RETURN NULL (Q5→A drop URL,
       skip receiver, skip ensureWebhooks). Do NOT proceed with the in-memory URL.

  5. Log info, return { channelUrl: url, source: 'provisioned' }.
```

**Rejected alternative**: a fifth "in-memory only, no persistence" tier. Explicitly ruled out by Q5→A because the receiver+webhook pair leaks orphaned GitHub webhooks on every restart.

### `server.ts` — pipeline extraction and gated invocation

**Before** (`server.ts:486-497` + `server.ts:814-829`, split across two lifecycle hooks):
```ts
// Inside `if (!isWorkerMode && config.labelMonitor && config.repositories.length > 0)`:
if (config.smee.channelUrl) {
  const watchedRepos = new Set(config.repositories.map(r => `${r.owner}/${r.repo}`));
  smeeReceiver = new SmeeWebhookReceiver(server.log, labelMonitorService, {
    channelUrl: config.smee.channelUrl, watchedRepos, clusterGithubUsername,
  });
  server.log.info({ channelUrl: config.smee.channelUrl }, 'Smee webhook receiver configured');
}

// … later, in onReady:
if (smeeReceiver) { smeeReceiver.start().catch(…); }
if (config.webhookSetup.enabled && config.smee.channelUrl) {
  const webhookSetupService = new WebhookSetupService(server.log, githubTokenProvider);
  webhookSetupService.ensureWebhooks(config.smee.channelUrl, config.repositories).catch(…);
}
```

**After** (same file, refactored + resolver kick-off):
```ts
// New helper, defined once inside createServer() closure to capture
// labelMonitorService, config, githubTokenProvider, clusterGithubUsername:
const startSmeePipeline = (channelUrl: string): void => {
  const watchedRepos = new Set(config.repositories.map(r => `${r.owner}/${r.repo}`));
  const receiver = new SmeeWebhookReceiver(server.log, labelMonitorService!, {
    channelUrl, watchedRepos, clusterGithubUsername,
  });
  smeeReceiver = receiver;
  server.log.info({ channelUrl }, 'Smee webhook receiver configured');
  receiver.start().catch((error) => {
    server.log.error({ err: error }, 'Smee webhook receiver failed');
  });
  if (config.webhookSetup.enabled) {
    const webhookSetupService = new WebhookSetupService(server.log, githubTokenProvider);
    webhookSetupService.ensureWebhooks(channelUrl, config.repositories).catch((error) => {
      server.log.error({ err: error }, 'Webhook setup failed');
    });
  }
};

// Inside `if (!isWorkerMode && config.labelMonitor && config.repositories.length > 0)`:
if (config.smee.channelUrl) {
  // Env/yaml provided a URL: preserve today's synchronous construction so `smeeReceiver`
  // is non-null before onReady runs (existing test expectations rely on this ordering).
  startSmeePipeline(config.smee.channelUrl);
} else {
  // No URL configured: kick off async resolver AFTER server.listen(). Wire this into the
  // onReady hook (fire-and-forget). The listen callback ordering is preserved: the
  // resolver never blocks listen.
  server.addHook('onReady', async () => {
    if (isWorkerMode) return; // predicate mirrored for clarity in the async path
    const resolver = new SmeeChannelResolver(server.log, {
      channelFilePath: config.smee.channelFilePath,
    });
    resolver.resolve()
      .then((result) => {
        if (result) {
          server.log.info({ channelUrl: result.channelUrl, source: result.source },
            'Resolved smee channel URL — starting pipeline');
          startSmeePipeline(result.channelUrl);
        } else {
          server.log.warn('No smee channel URL available — cluster is webhook-less, falling back to polling');
        }
      })
      .catch((error) => {
        // Belt-and-braces: resolver contracts to never throw, but if it does,
        // fail open exactly as today.
        server.log.error({ err: error }, 'Unexpected error resolving smee channel URL');
      });
  });
}
```

- **Fire-and-forget invariant**: the `resolve().then(...)` promise is not awaited by any lifecycle hook. `server.listen()` completes before `resolve()` can complete (network round-trip vs. local bind). `/health` responds immediately.
- **Gating predicate**: outer `if` at line 464 is unchanged. The resolver is invoked only inside that block, so worker-mode processes and pre-activation wizard boots (no repositories) never touch it — matching Q2→C.
- **Idempotency across restarts**: on boot 2 with a persisted file, `resolve()` returns at step 2 (persisted tier) with **zero** HTTP calls and zero writes. `SmeeWebhookReceiver` construction happens in the async path, one tick later than today's sync path. All downstream consumers (`labelMonitorService`, SSE) already tolerate this because today's sync path itself has the receiver `start()` invocation inside the async `onReady` hook (existing lines 814-818).
- **Preservation of today's env-set behavior**: when `config.smee.channelUrl` is set (env or yaml), `startSmeePipeline` runs synchronously in the same code block that constructed `smeeReceiver` today — no behavior change, no timing change, no test-fixture change. The resolver is only invoked in the new "no URL configured" path.

### Config schema addition

```ts
// packages/orchestrator/src/config/schema.ts (~line 238)
export const SmeeConfigSchema = z.object({
  channelUrl: z.string().url().optional(),
  fallbackPollIntervalMs: z.number().int().min(30000).default(300000),
  /** Path to the persisted smee channel file. */
  channelFilePath: z.string().default('/var/lib/generacy/smee-channel'),
});
```

- Overridable via env var: existing `orchestrator.smeeChannelFilePath` field in `.generacy/config.yaml` OR `ORCHESTRATOR_SMEE_CHANNEL_FILE_PATH` (added to `config/loader.ts` mirroring line 133's `smeeEnvUrl` pattern). Test-only usage; not documented in the CLI scaffolder.
- Default matches the existing state directory (`activation/persistence.ts` default `/var/lib/generacy/cluster-api-key`, `credhelper-daemon` `/var/lib/generacy/master.key`), so no compose-file or volume-mount change.

### Persisted file format

- **Content**: exactly the URL string, no trailing newline. `writeFile(path, url, { mode: 0o600 })`.
- **Read behavior**: `readFile(path, 'utf-8').trim()` (defensive against a stray newline from hand-edits). Trimmed value passed to `SMEE_URL_PATTERN.test(...)`.
- **Regex**: `^https:\/\/smee\.io\/[A-Za-z0-9_-]+$`. `smee.io` allows short IDs like `mNhnxyK56d9qkZo` (mixed-case alphanumeric); the character class is deliberately narrow to reject anything with query strings, fragments, or path components.
- **Corruption**: any read failure other than ENOENT (permission, EIO) is treated as "file absent" — logs warn once, falls through to provision. Justification: the alternative (fail-loud) contradicts FR-006's fail-open mandate. The very next successful provision overwrites the file atomically.

### Non-changes (deliberate)

- **`SmeeWebhookReceiver`** (`services/smee-receiver.ts`) — the receiver's `start()`, reconnect backoff, event handling, and shutdown are all unchanged. The resolver only supplies the URL.
- **`WebhookSetupService`** (`services/webhook-setup-service.ts`) — `ensureWebhooks(smeeChannelUrl, repositories)` signature and behavior unchanged.
- **`packages/generacy/src/cli/commands/cluster/scaffolder.ts`** — still writes `SMEE_CHANNEL_URL=` (empty) to `.env`. That's the whole point: the orchestrator now handles that case gracefully. Deleting the empty line from the scaffolder is a follow-up cleanup (out of scope).
- **`generacy-cloud`** templates — same as above, cross-repo, out of scope.
- **`cluster-base/.generacy/setup.sh`** — the interactive shell script that hand-runs `curl https://smee.io/new` is left in place; it's still useful for hand-forked clusters that want to pre-seed a URL before first boot. The orchestrator's new resolver is the automated path for the common case; the script remains the hand-run path for edge cases.
- **`.generacy/config.yaml`** — spec explicitly forbids writing the URL here (unauthenticated capability URL + committed file). Not touched.
- **Adaptive polling** (`label-monitor-service.ts`) — #953 territory. Not touched.
- **`/health` endpoint** — no new field. Adding a `smeeReady` boolean is out of scope; use the existing warn log line ("cluster is webhook-less…") for observability. If a follow-up needs a health field, it slots in via the `#824`/`#598` boot-resume pattern.
- **Relay metadata** — no new field. If cloud UI needs to display "cluster is webhook-less" that's a `#954` sibling.
- **Existing hardcoded `https://smee.io/mNhnxyK56d9qkZo`** references (spec Evidence): unchanged. The `tetrad-development` cluster's env-set URL still wins at tier 1 and continues to work.

## Complexity Tracking

*Constitution Check passed; no violations.*

- 1 new source file (`smee-channel-resolver.ts`, ~120 LOC). 2 new test files (~250 LOC).
- 1 new optional config field (`channelFilePath`).
- 1 modified source file (`server.ts`) — factoring out an inline block into a `startSmeePipeline(url)` closure + one `else`-branch resolver invocation. Delta ~40 LOC.
- 0 new package dependencies. 0 new interfaces beyond the two exported types (`SmeeChannelResolverOptions`, `SmeeChannelResolverResult`).
- 5 new log lines, all at the existing cadence.
- 1 changeset entry (`.changeset/952-orchestrator-smee-auto-provision.md`, minor bump, orchestrator only) added by the implement phase.

## Risk / Rollback

- **Risk 1**: `smee.io` starts issuing IDs with characters outside `[A-Za-z0-9_-]` (e.g., adds `.` or `~`). The strict regex would reject valid new channels. **Mitigation**: `smee.io`'s current ID format (`mNhnxyK56d9qkZo`-style, mixed-case alphanumeric ~15 chars) has been stable since the service launched. If they widen the character class, the regex needs a matching widen — one-line change, low risk. The rejection path is loud (warn log with `attempts: 2, lastError`), so drift would be visible in production before it silently degraded anything.

- **Risk 2**: `POST https://smee.io/new` starts returning something other than a 302 (e.g., they switch to JSON body with the URL inside). **Mitigation**: the resolver validates the Location header explicitly and treats a missing/wrong-shape response as a failure → retry → fail-open. The cluster degrades to polling; the operator sees a warn log; a code change is needed to adapt. This is preferable to accepting an unvalidated body and wiring the receiver against something nonsensical.

- **Risk 3**: `AbortSignal.timeout()` semantics differ subtly between Node versions. **Mitigation**: pinned Node ≥22 in the orchestrator package; `AbortSignal.timeout()` is stable since Node 17.3. Test file uses a mock `fetch` that never returns to exercise the timeout branch — no dependency on real Node timer behavior for correctness.

- **Risk 4**: `/var/lib/generacy` becomes read-only mid-run (mount point remounted ro, disk-full). Provisioning succeeds, write fails, Q5→A drops the URL, cluster degrades. **Mitigation**: this is the specified behavior. The wider fallout (`cluster-api-key` can't be updated, `credentials.dat` can't be updated) is already the operator's top concern; the smee-channel drop is symptomatic, not causal. No mitigation needed at this layer.

- **Risk 5**: Two orchestrator processes race to provision on the same volume (e.g., an operator runs `docker compose up -d` with 2 replicas). Both call `POST /new`, both get different channels, one overwrites the other's file, one webhook lands on the repo, the other leaks. **Mitigation**: the spec's target is single-orchestrator-per-cluster (compose file spawns 1 orchestrator container). This is not a supported configuration. If it ever becomes one, `flock`-based locking on `/var/lib/generacy/smee-channel.lock` (same pattern as `credentials.dat.lock` in `credhelper-daemon`) would serialize; out of scope now.

- **Risk 6**: A pre-existing cluster with an env-set `SMEE_CHANNEL_URL` also has a stale `/var/lib/generacy/smee-channel` file from a previous boot with a different URL. **Mitigation**: not a bug. `presetUrl` short-circuits at tier 1; the file is never read. If env is later unset, the file is used on next boot — this is the intended "fall back to persisted" path.

- **Risk 7**: The changeset file is forgotten (per `CLAUDE.md`, the #1 reason speckit PRs land red). **Mitigation**: called out explicitly in the Constitution Check table above and in the tasks phase output as a required task. The gate at `.github/workflows/changeset-bot.yml` will fail CI otherwise.

- **Rollback**: revert `services/smee-channel-resolver.ts` (delete), revert `server.ts` (restore the inline block at lines 486-497 + 814-829), revert `config/schema.ts` (drop `channelFilePath`), delete the two new test files, delete the changeset entry. Existing clusters with an env-set URL continue to work; clusters that had been depending on the auto-provisioned file are back to webhook-less polling (their previous state). Zero data migration. The persisted `/var/lib/generacy/smee-channel` files created during the rollout are harmless orphans on disk — reused on any future re-rollout, or ignorable indefinitely.

---

*Generated by /plan — 2026-07-16*
