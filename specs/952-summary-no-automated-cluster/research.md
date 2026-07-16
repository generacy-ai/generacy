# Research: Auto-provision smee.io channel on orchestrator startup

**Feature**: #952 | **Branch**: `952-summary-no-automated-cluster` | **Date**: 2026-07-16

## 1. smee.io `POST /new` contract

**Decision**: Call `POST https://smee.io/new` and read the `Location` header from the resulting 302 response.

**Evidence**:
- The reference implementation shipped in the interactive script (`cluster-base/.generacy/setup.sh:165`) uses `curl -s https://smee.io/new -o /dev/null -w '%{redirect_url}'`. `%{redirect_url}` in curl is populated from the `Location` header of a 3xx response. This confirms the smee.io endpoint returns a redirect, not a JSON body.
- Cross-check against smee.io's own documentation and its open-source implementation (`github.com/probot/smee.io/blob/main/index.js`): the `/new` route calls `Channel.uid()` and responds `res.redirect(uid)`.

**Implementation implication**:
- Use `fetch('https://smee.io/new', { method: 'POST', redirect: 'manual' })` so the fetch does NOT auto-follow the 302 to `/mNhnxyK56d9qkZo` (that follow would issue a `GET` on the channel URL, keeping the channel connection open and confusing the intent). Read `response.headers.get('Location')`.
- Validate the Location value against `^https?://smee\.io/[A-Za-z0-9_-]+$` before accepting. Reject anything else as "provision failed" and let the retry / fail-open path take over.
- Alternative rejected: use a wrapper package like `smee-client`. That package provides receiver semantics (SSE consumption), not channel creation. Adding it as a dependency to invoke a single `POST` is unwarranted — native `fetch` is 4 LOC.

## 2. Timeout: `AbortSignal.timeout(5000)`

**Decision**: `fetch(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000) })`.

**Rationale**:
- Q1→B locks the timeout at 5s (see clarifications.md §Q1). The clarification explicitly corrected the question's premise that there was a "10s existing convention" — there is not; the only comparable timeouts in the orchestrator are 500 ms localhost probes (`services/control-plane-probe.ts:4`, `services/code-server-probe.ts:4`).
- `AbortSignal.timeout()` is a Node 17.3+ / Node 22-stable API. The orchestrator's `package.json` requires Node ≥22, so no polyfill or `AbortController` boilerplate is needed.
- The signal covers connect + response together. If smee.io is unreachable, we fail at 5s. If they're slow-to-respond, we fail at 5s. Either failure mode enters the retry-once branch (Q4→B).

**Alternative rejected**: `AbortController` + manual `setTimeout` + `clearTimeout`. More code, more chances to leak a timer if an early throw skips the clear. `AbortSignal.timeout()` is self-cancelling.

## 3. Retry policy: 2 attempts, 1s fixed delay

**Decision**: `for (let attempt = 1; attempt <= 2; attempt++) { try { ... return ... } catch { if (attempt < 2) await sleep(1000) } }`.

**Rationale**:
- Q4→B locks this shape. The clarification's reasoning: the most common real failure mode is container DNS not yet warm in the first seconds of boot. One extra attempt after a 1s wait catches that cheaply. A third attempt (Q4 option C's `activation/` exponential-backoff pattern) adds little because the post-activation restart is the real recovery path.
- Since Q2→C makes provisioning fully async, this retry budget never impacts `server.listen()` — so this decision is a hit-rate vs. complexity trade-off, not a startup-time trade-off.

**Alternative rejected**: Exponential backoff (1s, 2s) with 3 attempts. Matches `activation/poller.ts` but the activation flow is polling a stateful cloud endpoint over minutes; the smee provision is a one-shot on-boot call where a persistent failure is a real failure and a transient blip has a specific known cause (DNS warmup). Extra attempts don't cover a new failure class.

## 4. Persistence path: `/var/lib/generacy/smee-channel`

**Decision**: Follow the existing state-directory convention. Path `/var/lib/generacy/smee-channel`, mode `0600`, node-owned. Atomic write via `.tmp` + `rename()`. Config field `channelFilePath` with the path as default, overridable for tests.

**Rationale**:
- Adjacent state files in the same directory:
  - `/var/lib/generacy/cluster-api-key` — activation client (`packages/orchestrator/src/activation/persistence.ts:25-36`).
  - `/var/lib/generacy/cluster.json` — activation metadata (same file, `writeClusterJson`).
  - `/var/lib/generacy/master.key` — credhelper AES-256-GCM master key (`packages/credhelper/src/backends/file-store.ts`).
  - `/var/lib/generacy/credentials.dat` + `/var/lib/generacy/credentials.dat.lock` — encrypted credential store (same file).
- Same volume mount, same ownership, same lifecycle semantics. Adding a new file here is zero-config for operators.
- Config override matches the existing pattern in `ActivationConfigSchema.keyFilePath` / `clusterJsonPath` (`config/schema.ts:216-218`).

**Alternative rejected**: `.generacy/config.yaml` — explicitly forbidden by spec §Persistence. That file is committed to the project repo; smee channel URLs are unauthenticated capability URLs; committing one to a public repo (e.g. `christrudelpw/snappoll`) leaks the event stream and allows forged payload injection.

**Alternative rejected**: cluster `.env` at host path (e.g. `C:\Users\ChrisTrudel\Generacy\snappoll\.generacy\.env`). Spec §Persistence explicitly confirms via `docker inspect` that this file lives on the host **outside** the container and is not mounted into the orchestrator. Not a viable persistence target.

**Alternative rejected**: Redis-backed persistence (`smee-channel` key in the shared Redis). Adds a dependency the resolver otherwise doesn't need. In degraded-Redis mode, the resolver would fall back to something else anyway — moving the failure mode without eliminating it. And multi-cluster shared Redis would defeat the "each cluster has its own channel" invariant (spec §Related, spec `284-problem-when-multiple`).

## 5. Atomic write: `.tmp` + `rename()`

**Decision**: `writeFile('/var/lib/generacy/smee-channel.tmp', url, { mode: 0o600 })` then `rename(tmp, target)`.

**Rationale**:
- Direct copy of `activation/persistence.ts:25-36`'s `writeKeyFile()` pattern. That code has been in production since the activation client (#500) and defends against the same failure mode: crash mid-write leaving a truncated file.
- `rename()` on POSIX is atomic within a filesystem. Both `tmp` and target live under `/var/lib/generacy/`, so they're on the same filesystem by construction.
- Q3→A specifies re-provisioning on malformed content — but the atomic-write pattern makes malformed content approach never in practice. The re-provision path is the correctness backstop, not the expected path.

**Alternative rejected**: `fsync()` before `rename()`. The `credhelper` file-store does this (`packages/credhelper/src/backends/file-store.ts`), and it's the right choice there because credentials are load-bearing across container restarts. For the smee channel, the correctness contract is "on boot, either use the file or provision a fresh channel." A power-loss-corrupted file is handled by Q3→A (re-provision on malformed) and Q5→A (drop if the re-provision's write also fails). Adding `fsync()` here would be over-engineering for a channel URL that costs one `POST` to recreate.

## 6. Validation regex: `^https:\/\/smee\.io\/[A-Za-z0-9_-]+$`

**Decision**: Strict regex applied ONLY to the persisted file's contents (tier 3). Env / yaml (tier 1) trusted (Zod-validated at load).

**Rationale**:
- Q3→A refinement 1: "validate specifically as `https://smee.io/<id>`, not merely 'non-empty'." A non-smee URL in the file is useless to `SmeeWebhookReceiver` and would trip `webhook-setup-service.ts:204` regardless.
- `smee.io` channel IDs observed: `mNhnxyK56d9qkZo` (evidence from spec), `<generated by tests>`. The channel-ID generator uses a mixed-case alphanumeric alphabet. Underscore and hyphen included in the character class because they don't hurt (rejects everything else that could indicate corruption like path components, query strings, fragments, HTML fragments, or entire log lines mistakenly written to the file) and might future-proof against a smee.io alphabet widen.
- The strict regex is deliberately narrower than the URL that the receiver would accept: it MUST be `smee.io` (not `smee.example.com` or a forgery), MUST be HTTPS, MUST have exactly one path segment. Anything odder → re-provision.

**Alternative rejected**: `URL` parsing + host check. More lenient (accepts trailing slashes, query strings, port specifications, all of which would round-trip through the receiver differently and defeat idempotency). Regex is exact.

## 7. Startup ordering: `onReady` hook, fire-and-forget

**Decision**: Register the resolver kickoff in a `server.addHook('onReady', ...)` callback. The `.then(...)` on `resolver.resolve()` runs whenever the resolver completes; nothing awaits it.

**Rationale**:
- Q2→C: fully async, gated on the receiver-construction predicate (`!isWorkerMode && config.labelMonitor && config.repositories.length > 0`).
- The existing `SmeeWebhookReceiver.start()` and `WebhookSetupService.ensureWebhooks()` calls already live in an `onReady` hook (`server.ts:814-829`), so wiring the resolver into the same hook keeps the mental model coherent: "all smee-related side effects happen when the server is ready."
- `server.listen()` returns as soon as the bind completes, before `onReady` finishes running any pending hooks. Actually — `onReady` fires *before* `listen()` accepts connections in Fastify, but the hook body's async work (`fetch()`) doesn't block the hook's return: the hook returns a resolved promise after registering the `.then(...)` callback. Verified by convention: existing lines 814-829 register `receiver.start().catch(...)` and `ensureWebhooks(...).catch(...)` without awaiting them; the pattern is intentional.

**Alternative rejected**: Kick off the resolver from a `setImmediate()` inside `createServer()` before `server.listen()`. Works, but obscures the gating: the resolver would need to duplicate the `config.labelMonitor && config.repositories.length > 0` predicate check inline, or it would race with the label-monitor setup. The `onReady` placement puts the resolver right next to the receiver/setup code it feeds — one location, one predicate, one order.

**Alternative rejected**: `preReady` blocking hook. Contradicts Q2→C explicitly; adds startup latency on the failure path.

## 8. Non-generalization: no "resolver framework"

**Decision**: `SmeeChannelResolver` is a plain class with one purpose. Do NOT extract a generic `TieredResolver<T>` abstraction.

**Rationale**:
- The 4 tiers here (env, yaml, persisted, provision) are semantically specific to smee: two of them pass-through pre-Zod-validated inputs, one reads a specific file with a specific validation regex, one hits a specific HTTP endpoint. Nothing else in the orchestrator has this exact shape.
- `activation/index.ts` implements a similar "read existing key, or acquire new one" pattern, but its acquisition is a multi-request device-code poll — completely different shape. The two would not share a base class in any useful way.
- `CLAUDE.md` invariant: "Don't add features, refactor, or introduce abstractions beyond what the task requires." Three similar lines is better than a premature abstraction; here we have exactly one caller.

**When a framework becomes right**: if a second resolver appears with the same 4-tier shape (env → yaml → file → HTTP), extract at that point.

## 9. Non-change: `SmeeWebhookReceiver` and `WebhookSetupService`

**Decision**: Zero source changes to these files. Only the URL source changes.

**Rationale**:
- `SmeeWebhookReceiver` reconnect / SSE / event routing behavior is orthogonal. Adding provisioning logic here would couple two concerns and complicate the receiver's already-nontrivial reconnect state machine.
- `WebhookSetupService.ensureWebhooks(url, repositories)` is a stateless method — it takes the URL and does its job. No reason to make it URL-aware.
- The resolver → pipeline handoff is a clean boundary: resolver returns a URL string (or null), pipeline consumes it. Standard dependency direction.

## 10. Test strategy: mocked `fetch`, real filesystem in tmp dir

**Decision**:
- Unit tests (`smee-channel-resolver.test.ts`): pass a stub `fetch` and a stub `sleep` via `SmeeChannelResolverOptions` (test-only fields). Use `os.tmpdir()` + a unique subdir for `channelFilePath`. Assert on file contents + mode.
- Integration test (`server-smee-provisioning.test.ts`): drive `createServer()` with `channelFilePath` pointing at a tmpdir path and a `global.fetch` monkey-patch (Vitest `vi.stubGlobal('fetch', ...)`). Assert on the observable orchestrator state (`smeeReceiver` non-null, `ensureWebhooks` called with the provisioned URL) + on the file.

**Rationale**:
- The existing test in `services/__tests__/webhook-setup-service.test.ts` uses mocked `executeCommand` — the pattern is "stub the external boundary, exercise the internal logic against a real filesystem." Consistent.
- Test injection via constructor options (as opposed to `vi.mock()` module-level mocking) matches the pattern used by `phase-tracker-service.test.ts`, `activation/*.test.ts`, and other pure services in this package. It's the least-surprising pattern for maintainers reading the tests.

## 11. Rejected: pruning orphaned webhooks on the repo

**Decision**: Do NOT extend `WebhookSetupService.ensureWebhooks()` to remove "other smee.io webhooks" pointing at URLs we don't recognize.

**Rationale**:
- Q3→A refinement 2 explicitly rejects this. Spec `284-problem-when-multiple` documents that a single repo can be monitored by multiple clusters, each with its own channel. Pruning "foreign" smee webhooks would silently break another operator's cluster.
- The rare orphan (from Q3's re-provision-on-malformed path, or from an operator manually deleting the persisted file) is acceptable. FR-004's atomic write makes the malformed-file case approach never in practice.

## 12. Rejected: writing to `.generacy/config.yaml`

**Decision**: Never write the URL to `.generacy/config.yaml`. Persist only to `/var/lib/generacy/smee-channel`.

**Rationale**: See section 4 above and spec §Persistence. `.generacy/config.yaml` is committed to the project repo; smee channel URLs are unauthenticated capability URLs; committing one leaks it.

## 13. Rejected: fifth "in-memory only" tier

**Decision**: If persistence write fails after successful provision, drop the URL entirely. Skip receiver + skip `ensureWebhooks`.

**Rationale**:
- Q5→A: connecting the receiver to a URL we can't reproduce means every restart mints a new channel and creates a new GitHub webhook, accumulating orphans on the repo forever.
- Q5's option B ("use receiver, skip `ensureWebhooks`") was explicitly discarded as incoherent: a channel we just minted has no GitHub webhook pointing at it yet, so a connected receiver can never deliver an event — it would just produce a misleading `Connected to smee.io channel` log line.

## 14. Wizard-cluster first-boot behavior

**Decision**: On boot 1 of a wizard cluster (`GENERACY_BOOTSTRAP_MODE=wizard`, no repos configured, no credentials), the resolver never runs. On boot 2 (post-activation restart, repos and credentials now configured), the resolver runs, provisions a channel, persists it, and `ensureWebhooks` wires GitHub webhooks. From boot 3 onward, the persisted file is reused with zero HTTP calls.

**Rationale**:
- The gating predicate `!isWorkerMode && config.labelMonitor && config.repositories.length > 0` is inherited from `server.ts:464` (where `SmeeWebhookReceiver` is constructed today). On boot 1 of a wizard cluster, `config.repositories.length === 0` because activation hasn't completed. `SmeeWebhookReceiver` isn't constructed today for that boot either, so the resolver has nothing to feed. Consistent.
- The post-activation restart is a guarantee, not a hope: `entrypoint-post-activation.sh` triggers it. So "wait for boot 2" is not degraded behavior; it's the designed flow.

## Sources

- Spec: `specs/952-summary-no-automated-cluster/spec.md`
- Clarifications: `specs/952-summary-no-automated-cluster/clarifications.md`
- Reference implementation: `cluster-base/.generacy/setup.sh:165`
- Persistence pattern: `packages/orchestrator/src/activation/persistence.ts:25-36`
- Existing wire-up: `packages/orchestrator/src/server.ts:464, 487, 814-829`
- Related: spec `284-problem-when-multiple` (multiple clusters per repo)
- Related: #953 (adaptive polling), #954 (webhook-less telemetry), generacy-ai/cluster-base#81 (setup.sh path mismatch)
