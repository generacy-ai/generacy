# Tasks: Wire the smee doorbell end-to-end (#980)

**Input**: Design documents from `/specs/980-summary-978-shipped-working/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/*.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = channel delivery, US2 = startup resilience, US3 = no-regression)

## Phase 1: Config schema extension (FR-A wiring)

- [X] T001 [P] [US1] Extend `SmeeConfigSchema` in `packages/orchestrator/src/config/schema.ts` to add `workspaceMirrorPath: z.string().default('/workspaces/.generacy/cockpit/smee-channel')`. Doc-comment: mirror-write failures are best-effort; empty string disables the mirror.
- [X] T002 [P] [US1] Add `SMEE_WORKSPACE_MIRROR_PATH` env override in `packages/orchestrator/src/config/loader.ts`. Explicit empty string (`""`) must disable the mirror (do not fall through to the schema default).

## Phase 2: Orchestrator workspace-mirror write (FR-A, FR-008)

- [X] T010 [US1] Extend `SmeeChannelResolverOptions` in `packages/orchestrator/src/services/smee-channel-resolver.ts` with `workspaceMirrorPath?: string`. Add private `mirrorToWorkspace(url)` helper: `mkdir -p` the parent, atomic tmp+rename write with mode `0644`, bare-URL content (no trailing newline, symmetric with cluster-internal). Wrap in try/catch; on failure emit exactly one `logger.warn({ path, code: err.code, message: err.message }, 'Workspace mirror write failed — operator sessions may fall back to polling')` and swallow. Never throw from `mirrorToWorkspace`. Reference: `contracts/smee-channel-resolver.md`.
- [X] T011 [US1] Invoke `mirrorToWorkspace(url)` at three call sites in `SmeeChannelResolver.resolve()`:
    1. After `writePersistedFile(url)` succeeds on tier-3 provisioning — always attempt.
    2. After a tier-2 `readPersistedFile()` hit — guarded on "mirror missing OR content differs" (read the mirror path first; skip if bytes equal the persisted URL, `ENOENT` → write, other read errors → attempt write).
    3. On tier-1 preset (env / yaml) hit — same "missing or differs" guard.
    Skip all three when `workspaceMirrorPath` is `undefined` or empty string.
- [X] T012 [US1] Wire `workspaceMirrorPath: config.smee.workspaceMirrorPath` into the `SmeeChannelResolver` construction site in `packages/orchestrator/src/server.ts` (existing constructor around line ~573). Pass `undefined` when the config value is the empty string so the resolver's disabled path is exercised.
- [X] T013 [US1] Add tests in `packages/orchestrator/src/services/__tests__/smee-channel-resolver.test.ts` covering:
    1. Tier-3 provisioning + mirror success → mirror file exists, mode `0644`, bare-URL bytes.
    2. Tier-3 provisioning + cluster-internal write success + mirror `EACCES` → resolver returns `{ channelUrl, source: 'provisioned' }`, one warn log, mirror file absent.
    3. Tier-2 persisted-read + mirror missing → mirror written.
    4. Tier-2 persisted-read + mirror bytes equal persisted URL → mirror `writeFile` **not** called (assert on the spy).
    5. Tier-2 persisted-read + mirror bytes differ → mirror re-written.
    6. `workspaceMirrorPath: undefined` → no mirror write attempted, no warn, behavior identical to today.

## Phase 3: CLI channel-discovery extended lookup (FR-002)

- [X] T020 [US1] Extend `ChannelDiscoveryInput` in `packages/generacy/src/cli/commands/cockpit/doorbell/channel-discovery.ts` with `cwd?: string` (default `process.cwd()`) and `workspaceMirrorPath?: string` (default `/workspaces/.generacy/cockpit/smee-channel`). Extend `ChannelSource` union with `'workspace-walkup' | 'workspace-absolute'`. Reference: `data-model.md` and `contracts/channel-discovery.md`.
- [X] T021 [US1] Implement the four-stage lookup chain in `discoverChannelUrl(input)`:
    1. `env[COCKPIT_DOORBELL_SMEE_URL]` (unchanged).
    2. Walk-up scan from `cwd`: for each ancestor `d` until `path.parse(cwd).root`, `readFile(<d>/.generacy/cockpit/smee-channel)`. `ENOENT` → next ancestor. Non-`ENOENT` → one warn line, next ancestor. Content match → `{ source: 'workspace-walkup' }`. Malformed → one warn line, next ancestor.
    3. Absolute read of `workspaceMirrorPath`. Same `ENOENT` / warn / match rules.
    4. Cluster-internal `channelFilePath` (unchanged).
    Never throw. Complete miss returns `null` (doorbell then starts in poll-fallback, unchanged behavior).
- [X] T022 [US1] Add tests to `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/channel-discovery.test.ts` per `contracts/channel-discovery.md § Test scaffolding` (9 cases): env valid, env invalid → fall through, walk-up hit at cwd, walk-up hit at parent, absolute-path hit, cluster-internal hit, all-miss → `null`, walk-up malformed → falls through, `EACCES` on absolute → warn + falls through.

## Phase 4: CLI startup-retry envelope (FR-003, FR-004, FR-005)

- [X] T030 [US2] Create `packages/generacy/src/cli/commands/cockpit/doorbell/startup-retry.ts` with:
    - `type GhErrorClass = { kind: 'retriable'; hint: string } | { kind: 'permanent'; reason: string }`.
    - `export function classifyGhError(err: unknown): GhErrorClass` — pure function; evaluation order and hint/reason values as specified in `contracts/startup-retry.md § Error classifier`. Retriable first (node error codes → `socket hang up` → HTTP `429|500|502|503|504`), then permanent (`401 / Bad credentials`, `403 / SAML|scope|not accessible by`, `404 / Could not resolve to (an Issue|a Repository)`, `parsing|expected JSON|invalid character`), default `permanent / unknown`.
    - `export interface StartupRetryOptions<T>` and `export type StartupRetryOutcome<T>` as in `data-model.md § StartupRetrySchedule`.
    - `export async function runStartupRetry<T>(opts): Promise<StartupRetryOutcome<T>>` — initial window (default `2 * 60_000`, sleep on `rateLimitScheduler.getCurrentIntervalMs()`, call `noteResponseHeaders({})` between attempts), late-window (default `5 * 60_000` cadence), abort-signal-aware sleeps.
    - Stderr diagnostic lines exactly as specified: `startup-retry label=… reason=… attempt=1`, `startup-retry-exhausted label=… transitioning to late-startup retry`, `startup-retry-recovered label=…`, `permanent-error label=… reason=…`.
- [X] T031 [US2] Add tests in `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/startup-retry.test.ts` covering the 12 cases in `contracts/startup-retry.md § Test scaffolding`: first-attempt success; ECONNRESET → success; sustained HTTP 429 through initial window → success in late-window (fake timers); HTTP 401 → `bad-credentials`; HTTP 403 SAML → `scope-or-sso`; HTTP 404 → `not-found`; malformed JSON → `malformed-output`; unknown message → `unknown`; abort mid-initial-sleep → `aborted`; abort mid-late-sleep → `aborted`; classifier unit table; `runDoorbell` integration (`acquireEpicBus` throws ECONNRESET once then resolves, doorbell reaches steady state, `armed\n` emitted before the retry attempt).
- [X] T032 [US2] Integrate `runStartupRetry` at both startup call sites in `packages/generacy/src/cli/commands/cockpit/doorbell.ts`:
    - `runPollMode` (~line 149): wrap the `acquire(acquireOptions)` call with `label: 'acquireEpicBus'`.
    - `runSmeeMode` (~line 236): wrap `source.start()` with `label: 'resolveEpic'`.
    On both sites, dispatch on the outcome: `success` → continue as today; `permanent` → return a `{ kind: 'permanent-exit' }` marker; `aborted` → return `null`. Pass `input.deps.rateLimitScheduler!`, `input.stopSignalController.signal`, `input.stderr` (or `process.stderr` for smee mode), and `input.logger`. Do not remove the existing `acquireEpicBus` / smee-fallback flow — only the exception-to-exit(2) path changes.
- [X] T033 [US2] Collapse `permanent-exit` markers returned from `runPollMode` / `runSmeeMode` into `exit(3)` at the `runDoorbell` outer boundary. Verify the existing `exit(2)` code path remains **only** for argument-parse errors (search doorbell.ts for existing `exit(2)` sites and confirm none remain on transient-error branches). Update the doorbell command's `--help` / usage output only if it enumerates exit codes.

## Phase 5: Regression preservation & release wiring

- [X] T040 [P] [US3] Add a changeset at `.changeset/980-smee-doorbell-e2e.md` per the CLAUDE.md rules. Two package bumps: `@generacy-ai/orchestrator` → `minor` (new `workspaceMirrorPath` config surface + resolver behavior), `@generacy-ai/generacy` → `minor` (new discovery source labels + new `exit(3)` semantics visible to skill authors). Body: 1–2 sentence WHY, not WHAT. This is a **newly added** file — the CI changeset-bot gate greps `--diff-filter=A` and will fail otherwise.
- [X] T041 [US3] Verify no smee-less regression by running the doorbell against a cluster with no `COCKPIT_DOORBELL_SMEE_URL`, no `/workspaces/.generacy/cockpit/smee-channel`, and no `/var/lib/generacy/smee-channel`. Assert stderr emits `source=poll-fallback reason=startup-no-channel` and poll cadence / API-call count match #970 baseline (SC-005). Add a Vitest case in `doorbell/__tests__/channel-discovery.test.ts` if not already covered by T022 case 7.

## Phase 6: Verification

- [ ] T050 Execute `quickstart.md` steps 1–5 on a real smee-live preview cluster from an operator session that does **not** mount `generacy-data`:
    - Step 1: assert `/workspaces/.generacy/cockpit/smee-channel` exists, mode `644`, bare URL.
    - Step 2: doorbell selects `source=smee reason=startup-smee-selected` from operator cwd, no `poll-fallback` line (SC-001).
    - Step 3: `GH_HOST=nope.invalid` induces `enotfound`; assert `startup-retry` lines then recovery to `source=smee` after `unset GH_HOST` — no `exit(2)` (SC-002, SC-003).
    - Step 4: invalid `GITHUB_TOKEN` induces `HTTP 401`; assert `permanent-error label=resolveEpic reason=bad-credentials` and exit code `3` (SC-004).
    - Step 5: smee-less cluster → `source=poll-fallback` (SC-005).
    Capture the auto-runs ledger over a full multi-phase run and grep for `heartbeat · schedule-wakeup · fired · drain complete` on phase transitions — expect zero (SC-006).

## Dependencies & Execution Order

**Phase-level dependencies (sequential across phases):**
- Phase 1 (config schema) → Phase 2 (resolver consumes the schema field).
- Phase 3 (channel-discovery) is independent of Phases 1–2; can start in parallel once the design is fixed. Its default `workspaceMirrorPath` matches the schema default so operator sessions work even before the resolver ships.
- Phase 4 (startup-retry) is independent of Phases 1–3; touches disjoint modules.
- Phase 5 T040 (changeset) can start once Phases 2 + 3 + 4 have committed source; T041 depends on T022's smee-less test path.
- Phase 6 (verification) requires all prior phases merged and deployed to a preview cluster.

**Parallel opportunities:**
- **T001, T002, T020, T030** can all start concurrently (four disjoint files).
- **T013, T022, T031** are pure test writes on disjoint `__tests__/` files — parallel.
- **T010, T021, T032** each land in a distinct module — parallel once the interface changes are in.
- Serial edges: **T010 → T011 → T012 → T013**, **T020 → T021 → T022**, **T030 → T031 → T032 → T033**.

**Critical path (rough):** T001 → T010 → T011 → T012 → T040 → T050. Everything else parallelizes off that spine.

## Notes

- No `packages/claude-plugin-cockpit/commands/*.md` files are edited by this issue — no `playbook-verification.test.ts` re-pin required.
- No new dependencies. Reuses `rateLimitScheduler` (already wired), `node:fs/promises`, `node:path`, `zod`.
- `armed\n` stdout ordering and the `event.type\n` line shape are load-bearing for `agency#431`; preserve both in T032 (`armed\n` must precede any `startup-retry` stderr line).
- Vitest fake timers required for T031 case 3 (initial-window exhaustion → late-window recovery). Same pattern as `SourceSelector` re-promote tests.
