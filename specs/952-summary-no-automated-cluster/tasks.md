# Tasks: Auto-provision smee.io channel on orchestrator startup

**Input**: Design documents from `/specs/952-summary-no-automated-cluster/`
**Prerequisites**: plan.md (required), spec.md (required), clarifications.md, research.md, data-model.md, contracts/{smee-channel-resolver,smee-channel-file,server-pipeline}.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (spec §User Stories US1 = auto-provision + persist smee channel)

## Phase 1: Config schema + env-var wiring

- [ ] T001 [US1] Add `channelFilePath: z.string().default('/var/lib/generacy/smee-channel')` field to `SmeeConfigSchema` in `packages/orchestrator/src/config/schema.ts` (~line 238–244) per data-model.md §5. No changes to existing `channelUrl` / `fallbackPollIntervalMs` fields; the Zod default keeps existing configs parsing unchanged (no migration).

- [ ] T002 [P] [US1] Wire `ORCHESTRATOR_SMEE_CHANNEL_FILE_PATH` env-var override in `packages/orchestrator/src/config/loader.ts`, mirroring the existing `smeeEnvUrl` pattern near line 133 (populate `config.smee.channelFilePath` if the env var is set). Test-only knob; not documented in the CLI scaffolder.

## Phase 2: Resolver service

- [ ] T003 [US1] Create `packages/orchestrator/src/services/smee-channel-resolver.ts` (~120 LOC) implementing the full contract in `contracts/smee-channel-resolver.md` and `data-model.md` §§1–4:
  - Export: `SMEE_URL_PATTERN = /^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/`, `ChannelSource` union (`'env-or-yaml' | 'persisted' | 'provisioned'`), `SmeeChannelResolverOptions`, `SmeeChannelResolverResult`, `SmeeChannelResolver` class.
  - `resolve()` implements the 4-tier precedence exactly as specified:
    - **Tier 1** (env-or-yaml): if `options.presetUrl` set → return `{ channelUrl: presetUrl, source: 'env-or-yaml' }`. No re-validation (trust Zod).
    - **Tier 2** (persisted): `readFile(channelFilePath, 'utf-8').trim()`. If matches `SMEE_URL_PATTERN` → log L1 info + return `{ source: 'persisted' }`. ENOENT → silent fall-through. Other read errors (EACCES/EIO/EISDIR/…) → warn once, fall through. Malformed content → log L3 warn `{ path, contentPreview }` (contentPreview truncated to 64 chars — never log a full stray URL/secret), fall through.
    - **Tier 3** (provision): `POST https://smee.io/new` with `redirect: 'manual'` and `signal: AbortSignal.timeout(5000)` (Q1→B). Read `Location` header; validate against `SMEE_URL_PATTERN`. On any failure (network, non-302, missing/malformed Location, AbortError) retry once after 1000 ms fixed delay (Q4→B, total attempts = 2). Both attempts fail → log L4 warn `{ attempts: 2, lastError }` + return `null`.
    - **Tier 3 persist**: `mkdir({ recursive: true })` on parent, `writeFile(tmp, url, { mode: 0o600 })`, `rename(tmp, path)` (no `fsync` — Q3→A backstop covers torn writes). Write failure → log L5 warn `{ path, error }` + return `null` (Q5→A drop-URL; do NOT return the in-memory URL). Success → log L2 info + return `{ source: 'provisioned' }`.
  - Constructor: `(logger: Logger, options: SmeeChannelResolverOptions)`. Test seams: `options.fetch` defaults to `globalThis.fetch`, `options.sleep` defaults to `setTimeout`-backed sleep.
  - Never throws — every failure mode folds into `return null` or a returned result.
  - Log-line vocabulary per `data-model.md` §9 (L1 info reuse-persisted, L2 info provisioned, L3 warn malformed, L4 warn exhausted, L5 warn write-fail).

## Phase 3: Resolver unit tests

- [ ] T004 [P] [US1] Create `packages/orchestrator/src/services/__tests__/smee-channel-resolver.test.ts` (~180 LOC) covering the T1–T14 test cases enumerated in `contracts/smee-channel-resolver.md` §"Testing contract":
  - T1 presetUrl short-circuits (no file read, no fetch).
  - T2 valid persisted file returns `source: 'persisted'` (no fetch, no write).
  - T3 malformed persisted file → L3 log with truncated contentPreview → fetch → overwrite → `source: 'provisioned'`.
  - T4 ENOENT → silent fall-through to tier 3 (no warn).
  - T5 EACCES → warn, fall through to tier 3.
  - T6 tier 3 first attempt fails, sleep(1000) is called via injected stub, second attempt succeeds.
  - T7 both attempts fail → L4 log + `null` return.
  - T8 302 with missing Location → treated as failure, retries.
  - T9 302 with wrong-shape Location (`https://evil.com/x`) → treated as failure, retries.
  - T10 provision succeeds, persist fails (e.g. write to a directory with mode 0000) → L5 log + `null` (does NOT return in-memory URL).
  - T11 fetch never resolves → `AbortSignal.timeout(5000)` fires → treated as failure, retries. Use injected `fetch` stub that returns a pending promise + Vitest fake timers to advance past 5000 ms.
  - T12 written file has mode 0600 (`fs.stat().mode & 0o777 === 0o600`).
  - T13 written file has exactly the URL, no trailing newline.
  - T14 file with trailing newline is trimmed on read, still matches regex, still returned.
  - Use `os.tmpdir()` + a per-test unique subdir for `channelFilePath` (real filesystem, mocked network) — pattern matches existing `phase-tracker-service.test.ts` / `activation/*.test.ts` in this package.

## Phase 4: Server-side pipeline wiring

- [ ] T005 [US1] Refactor `packages/orchestrator/src/server.ts` per `contracts/server-pipeline.md`:
  - Inside `createServer()`, define a closure `startSmeePipeline(channelUrl: string): void` capturing `labelMonitorService`, `config`, `server.log`, `githubTokenProvider`, `clusterGithubUsername`. Body: build `watchedRepos`, construct `SmeeWebhookReceiver`, assign to enclosing `smeeReceiver`, log info `Smee webhook receiver configured { channelUrl }`, fire-and-forget `receiver.start().catch(logError)`, and if `config.webhookSetup.enabled` construct `WebhookSetupService` and fire-and-forget `ensureWebhooks(channelUrl, config.repositories).catch(logError)`.
  - Inside the existing gate `if (!isWorkerMode && config.labelMonitor && config.repositories.length > 0)` at ~`server.ts:464`:
    - When `config.smee.channelUrl` is set → call `startSmeePipeline(config.smee.channelUrl)` synchronously (preserves today's construction ordering; existing tests continue to pass).
    - When `config.smee.channelUrl` is unset → register an `onReady` hook that re-checks the predicate inline (belt-and-braces, per contract §Site B), constructs `new SmeeChannelResolver(server.log, { channelFilePath: config.smee.channelFilePath })`, calls `resolver.resolve()` fire-and-forget (never awaited), and in the `.then()`: on non-null result → info log `Resolved smee channel URL — starting pipeline { channelUrl, source }` + `startSmeePipeline(result.channelUrl)`; on null → warn log `No smee channel URL available — cluster is webhook-less, falling back to polling`. Outer `.catch()` logs `Unexpected error resolving smee channel URL` as belt-and-braces.
  - Delete the now-redundant `if (smeeReceiver) { smeeReceiver.start().catch(...); }` block at `server.ts:814-818` and the inline `WebhookSetupService` + `ensureWebhooks` call at `server.ts:820-829` — both call sites converge on `startSmeePipeline`, which handles `.start()` and `ensureWebhooks` itself. The graceful-shutdown block at `server.ts:866-868` (`if (smeeReceiver) smeeReceiver.stop()`) is unchanged.

## Phase 5: Server integration test

- [ ] T006 [P] [US1] Create `packages/orchestrator/src/__tests__/server-smee-provisioning.test.ts` (~70 LOC) covering I1–I6 from `contracts/server-pipeline.md` §"Test contract":
  - I1 sync path: `config.smee.channelUrl` set → `smeeReceiver` is non-null after `createServer()` (before `onReady` runs); resolver is NOT constructed.
  - I2 async path succeeds: `config.smee.channelUrl` unset, stub `fetch` (via `vi.stubGlobal('fetch', …)`) returns a 302 with valid `Location` → after `server.listen()` + resolver `.then()` fires, `smeeReceiver` is non-null, `ensureWebhooks` was called with the provisioned URL, file at `channelFilePath` (pointed at tmpdir) contains the URL with mode `0600`.
  - I3 worker-mode skip: `createServer({ config: workerModeConfig })` → resolver never invoked.
  - I4 wizard-mode skip: `config.repositories = []` → resolver never invoked, no file created.
  - I5 fire-and-forget invariant: stubbed `fetch` returns a promise that never resolves → `server.listen()` returns within 100 ms; `smeeReceiver` stays null indefinitely; no test hang.
  - I6 persisted-file reuse across restarts: first `createServer()` provisions + writes; second `createServer()` with same `channelFilePath` and no preset → tier 2 hits, zero `fetch` calls, `smeeReceiver` non-null with the same URL.
  - Use `os.tmpdir()` + a per-test unique subdir for `channelFilePath`. Wire it into the config via `ORCHESTRATOR_SMEE_CHANNEL_FILE_PATH` env-var override or by overriding `config.smee.channelFilePath` directly at test-setup time.

## Phase 6: Changeset (required by CLAUDE.md CI gate)

- [ ] T007 [US1] Add `.changeset/952-orchestrator-smee-auto-provision.md` with a `minor` bump for `@generacy-ai/orchestrator` (new capability — auto-provisioning resolver). No other packages touched, so this is the only entry. One-sentence summary along the lines of *"orchestrator: auto-provision a smee.io channel on startup when none is configured, persist it to `/var/lib/generacy/smee-channel`, and let the existing webhook-setup flow wire the GitHub webhook."*

## Dependencies & Execution Order

- **T001** must land before **T003** (resolver reads `config.smee.channelFilePath`) and before **T005** (server.ts reads the same field).
- **T002** can land in parallel with **T001** (different file; independent).
- **T003** must land before **T004**, **T005**, and **T006** (they all import from `smee-channel-resolver.ts`).
- **T004** (`[P]`) and **T005** are independent once T003 lands — different files, no shared state; **T004** and **T006** cannot both run in parallel with each other because both require the resolver source to compile, but **T004** and **T005** can run in parallel.
- **T006** must land after **T005** (integration test drives the refactored `createServer()` flow).
- **T007** can be authored at any point but MUST be present in the final PR (CLAUDE.md changeset gate greps `--diff-filter=A` against base; editing an existing changeset does not satisfy it).

**Parallel opportunities**:
- T001 + T002 (Phase 1) — different files.
- After T003 lands: T004 (unit test) can run in parallel with T005 (server refactor).
- T007 (changeset) can be authored at any point, in parallel with anything.

**Suggested serial ordering** (single-agent, matches plan.md phase order):
T001 → T002 → T003 → T004 → T005 → T006 → T007.

---

*Generated by `/tasks` — 2026-07-16. Standard mode (workflow:speckit-bugfix, no `epic-grouping:*` label detected).*
