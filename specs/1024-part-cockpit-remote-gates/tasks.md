# Tasks: Cockpit gates — cluster-side end-to-end integration test (#1024)

**Input**: Design documents from `/specs/1024-part-cockpit-remote-gates/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/fake-peer-protocol.md, contracts/scenario-catalog.md, contracts/env-seams.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to — US1 (path provably wired), US2 (cloud can mirror shapes), US3 (restart/dedup verified end-to-end)

---

## Phase 1: Setup — verify sibling seam surface

Runs a quick presence-check on the seams the harness depends on. Findings drive whether FR-012 surgical fixes land in this PR (Phase 4) or the scenario is `.skip()`'d with a linking follow-up (per plan D-2 / `contracts/env-seams.md`).

- [ ] **T001** [US1] Verify sibling P1 landings against the seam checklist in `specs/1024-part-cockpit-remote-gates/contracts/env-seams.md` (S-1 through S-10). For each seam, record: **PRESENT** / **MISSING (≤20 LOC — land in this PR)** / **MISSING (>20 LOC — file follow-up + skip scenario)**. Concretely grep for:
    - S-1: `COCKPIT_ANSWERS_FILE` in `packages/orchestrator/src/routes/answers.ts` (or wherever #1021 landed the writer).
    - S-2: `'cluster.cockpit'` in the `ALLOWED_CHANNELS` tuple at `packages/orchestrator/src/routes/internal-relay-events.ts`.
    - S-3: retain-and-replay branch for `cluster.cockpit` in `internal-relay-events.ts` (or a `retained-cockpit-event.ts` sibling module).
    - S-4: `POST /cockpit/gates/:id/ack` route registration.
    - S-5: `COCKPIT_ANSWERS_FILE` read in `packages/generacy/src/cli/commands/cockpit/doorbell.ts`.
    - S-6: `--answers-file <path>` CLI flag on the same command (optional).
    - S-7: doorbell startup re-reads answers file from head (position model B per clarification Q1 → B).
    - S-9: `./gates` (or equivalent) subpath export in `packages/cockpit/package.json` `exports` field.
    - S-10: `gateOpenFixture`, `answerLineFixture`, `outcomeAckFixture` in `packages/cockpit/src/gates/`.

  Attach the audit table to the PR body. This determines what lands in Phase 4.

- [ ] **T002** [US1] Confirm `@generacy-ai/cockpit` is a resolvable workspace dep of `@generacy-ai/orchestrator`. Check `packages/orchestrator/package.json` — if missing, add `"@generacy-ai/cockpit": "workspace:*"` under `devDependencies` (harness-only usage). Run `pnpm install` if the dep line was added.

- [ ] **T003** [US1] Confirm `ws` + `@types/ws` are available to `@generacy-ai/orchestrator` (either directly or transitively via `@generacy-ai/cluster-relay`). If not directly resolvable, add `ws` and `@types/ws` under `devDependencies` of `packages/orchestrator/package.json`. Verify by attempting `import { WebSocketServer } from 'ws'` in a scratch file (delete after).

---

## Phase 2: Foundational — build the harness helpers

Test file cannot compose scenarios until these three helpers exist. All three are net-new files under `packages/orchestrator/src/__tests__/cockpit-gates/`.

- [ ] **T010** [P] [US1] Create `packages/orchestrator/src/__tests__/cockpit-gates/fake-peer.ts`. Implement `startFakePeer(opts)` and the `FakePeer` interface exactly per `data-model.md` §"FakePeer" and `contracts/fake-peer-protocol.md`:
    - `WebSocketServer` from `ws` on `port: 0` (random). Exposes `url = ws://127.0.0.1:<port>`.
    - `wss.on('connection', ...)`: parse each inbound frame with `RelayMessageSchema.safeParse` from `@generacy-ai/cluster-relay/messages`. On `handshake`, respond with a `heartbeat` frame (mirrors `packages/cluster-relay/tests/relay.test.ts:93-100`). On `event`, push to `received.events`. On `api_response`, push to `received.apiResponses` and resolve any pending `sendApiRequest` waiter keyed by `correlationId`.
    - `waitForEvent(channel, matcher?, timeoutMs = 5000)`: 20 ms polling loop over `received.events` filtered by `event === channel`. Reject with a descriptive error naming the channel + last-seen events on timeout.
    - `sendApiRequest(method, path, body, timeoutMs = 5000)`: mint a `correlationId` (`crypto.randomUUID()`), send an `api_request` frame on the currently-connected client, register a resolver that fires when a correlated `api_response` arrives.
    - `disconnectAllClients()`: `wss.clients.forEach(c => c.terminate())` — used for FR-004 (S1b).
    - `waitForReconnect(timeoutMs = 5000)`: resolves on the next `wss.on('connection', ...)` event after the current one.
    - `close()`: idempotent `wss.close()` + `await once(wss, 'close')`.
    - Invalid frames (fail `safeParse`) logged to `console.warn` (test-only) and dropped — do NOT crash the peer.

- [ ] **T011** [P] [US1] Create `packages/orchestrator/src/__tests__/cockpit-gates/doorbell-driver.ts`. Implement `createDoorbellDriver(opts)` and the `DoorbellDriver` interface per `data-model.md` §"DoorbellDriver":
    - `spawn(nodeBin, [generacyBin, 'cockpit', 'doorbell', ...extraArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] })`. Default `nodeBin = process.execPath`, default `generacyBin = path.resolve(<repo-root>, 'packages/generacy/dist/bin/generacy.js')`.
    - Line-buffered stdout reader (`readline.createInterface({ input: child.stdout })`). Each line pushed to `stdoutLines`; if it parses as JSON with a `type` field, also push to `events`.
    - `waitForEvent(match, timeoutMs = 5000)`: 20 ms poll over `events` for a match predicate.
    - `stop(timeoutMs = 3000)`: `child.kill('SIGTERM')`; `await Promise.race([once(child, 'exit'), setTimeout(timeoutMs)])`; fallback to `SIGKILL` on timeout.
    - `restart(timeoutMs)`: `await this.stop(timeoutMs); await this.start();` — reuses stored options (**does not** reset `stdoutLines`/`events`; call site knows whether to inspect pre-restart or post-restart state).
    - `start()`: throws with a helpful message (include child stderr) if the child exits with non-zero before yielding its first stdout line.
    - Do NOT wire in `tsx` fallback (research.md R-3 rejected it) — the harness relies on the built `dist/bin/generacy.js`. Document this in a top-of-file comment.

- [ ] **T012** [P] [US2] Create `packages/orchestrator/src/__tests__/cockpit-gates/scenario-helpers.ts`. Implement `setupScenario(opts?)` and the `ScenarioContext` interface per `data-model.md` §"ScenarioContext":
    - `mkdtemp(path.join(os.tmpdir(), 'cockpit-gates-1024-'))` → sets `COCKPIT_ANSWERS_FILE` in `process.env` **before** orchestrator boot (writer reads it once at construction).
    - `startFakePeer()` → `peer.url`.
    - `createServer({ relay: { relayUrl: peer.url, apiKey: 'test-key', baseReconnectDelayMs: 50, maxReconnectDelayMs: 200, ... } })`. If any orchestrator config surface differs — check `packages/orchestrator/src/server.ts`'s `createServer` signature and adapt. `activation.cloudUrl` unset (activation-skip path).
    - Await `peer.waitForReconnect()` (first connection).
    - `createDoorbellDriver({ answersFilePath, env: { COCKPIT_ANSWERS_FILE: answersFilePath, ... } }).start()`.
    - `cleanup()` — idempotent: stop doorbell, close orchestrator, close peer, `rm(tempDir, { recursive: true, force: true })`. Delete the `COCKPIT_ANSWERS_FILE` env key after cleanup so it does not leak between scenarios in the same worker.
    - Also export a small `awaitCockpitEvents(sinceCursor)` helper that reaches into the in-process MCP event-bus registry (via the same accessor `cockpit_await_events` uses) — used by S2 assertion (d).

**Blockers**: T010, T011, T012 can be built in parallel — different files, no cross-dependency. All three block Phase 3.

---

## Phase 3: Core implementation — write the 8-scenario test file

<!-- Depends on Phase 2 complete: fake-peer.ts, doorbell-driver.ts, scenario-helpers.ts must exist and compile. -->

Single file: `packages/orchestrator/src/__tests__/cockpit-gates-integration.integration.test.ts`. Each scenario is its own top-level Vitest `it(...)` inside one `describe('Cockpit gates integration', ...)` block. Per-scenario isolation via `beforeEach`/`afterEach` calling `setupScenario()` / `cleanup()`. Timeout per test: 15 s (Node ≥22 default is too low for spawn + WS handshake — set explicitly via `vi.setConfig({ testTimeout: 15000 })` or per-test `{ timeout: 15000 }`).

**File preamble (mandatory)** — add a comment block at the top explaining SC-004: "Wire shapes single-sourced from `@generacy-ai/cockpit/gates`. Reviewer: reject this PR if any inline `z.object({...})` / literal schema shape appears in this file for gate contracts."

- [ ] **T020** [US1] **S1a — Gate open → `cluster.cockpit` event** (FR-003). Import `gateOpenFixture` from `@generacy-ai/cockpit/gates`. Build a gate-open body, `fetch(orchestratorUrl + '/cockpit/gates', { method: 'POST', body: JSON.stringify(body) })`, expect status 200. Then `peer.waitForEvent('cluster.cockpit', d => d.kind === 'gate-open')` and `expect(event.data.gate).toEqual(body)` (byte-equal per FR-003). Use the discriminator field name pulled from a shared constant in `@generacy-ai/cockpit/gates` — do not hard-code `'gate-open'` if a named export exists.

- [ ] **T021** [US1] **S1b — Retain-and-replay across disconnect** (FR-004). Sequence per `contracts/fake-peer-protocol.md` §"Retain-and-replay":
    1. `peer.disconnectAllClients()`.
    2. POST a fresh gate-open via `fetch(...)`.
    3. `peer.waitForReconnect()` (orchestrator's reconnect loop dials back — recall the harness sets `baseReconnectDelayMs: 50` in `setupScenario`).
    4. `peer.waitForEvent('cluster.cockpit', d => d.kind === 'gate-open')` — assert the event surfaces on the new connection.
    5. `expect(peer.received.events.filter(e => e.event === 'cluster.cockpit')).toHaveLength(1)` — no double-replay.

    If seam S-3 (`contracts/env-seams.md`) was recorded as ">20 LOC missing" in T001, replace this task's body with `it.skip('S1b — retain-and-replay across disconnect', ...)` and add an inline `// TODO(#<followup>): unskip after #1021 lands retain-and-replay for cluster.cockpit`.

- [ ] **T022** [US1] [US3] **S2 — Answer down-path (file + stdout + bus)** (FR-005). All four side-effects in one scenario (per `contracts/fake-peer-protocol.md` §"Frame: api_request"):
    - `sendApiRequest('POST', '/cockpit/answers', answerLineFixture({ deliveryId: 'delivery-1', gateId }))` — expect `resp.status === 200`.
    - `readFile(answersFilePath, 'utf8')` — expect exactly 1 non-empty line, JSON-parses to the same `GateAnswer` shape.
    - `doorbell.waitForEvent(e => e.type === 'gate-answer' && e.deliveryId === 'delivery-1')` — expect within 5 s.
    - `awaitCockpitEvents(sinceCursor)` — expect a matching bus entry.

- [ ] **T023** [US1] **S3 — Ack → outcome relay event** (FR-006). Build outcome ack body with `outcomeAckFixture({ gateId, outcome: 'applied' })`. POST to `/cockpit/gates/:id/ack` (path per `contracts/env-seams.md` S-4). Expect status 200. `peer.waitForEvent('cluster.cockpit', d => d.kind === 'outcome')` and `expect(event.data.outcome).toEqual(body)` byte-equal (FR-006).

    If seam S-4 was recorded as missing in T001, `.skip()` with follow-up link.

- [ ] **T024** [US3] **S4 — Restart replay of unacked answers exactly once** (FR-007). Sequence:
    1. Inject one answer via `sendApiRequest` (no ack posted).
    2. `doorbell.waitForEvent(e => e.type === 'gate-answer' && e.deliveryId === 'delivery-restart')` — assert initial emit.
    3. `doorbell.restart()` — SIGTERM, respawn with the same env (per data-model.md §"DoorbellDriver").
    4. Poll for the restart-replay emit — assert `doorbell.events.filter(e => e.type === 'gate-answer' && e.deliveryId === 'delivery-restart')` has length **2** across the full lifetime (one pre-restart, one post-restart, no more).
    5. Also assert the in-process MCP event-bus surfaces the replayed entry exactly once (a fresh `awaitCockpitEvents` cursor from after the restart yields one entry for `delivery-restart`).

    If the assertion of "exactly one replay" reveals that #1023's position model is not B (per clarification Q1 → B) — i.e., an on-disk sidecar was written that skips replay entirely, or replay happens more than once — this is a **contract change** owned by #1023's PR (per `env-seams.md` S-7). Do not paper over in this PR — file the follow-up.

- [ ] **T025** [US3] **S5 — `deliveryId` dedup end-to-end (both layers)** (FR-008). Sequence:
    1. `sendApiRequest` with `answerLineFixture({ deliveryId: 'delivery-dup' })`.
    2. `sendApiRequest` **again** with the same `deliveryId` (call `answerLineFixture` twice with the same override — second call yields a distinct object with the same `deliveryId`).
    3. Assert the answers file has exactly **1** line for this `deliveryId` (layer a — writer dedup).
    4. Assert the doorbell has emitted exactly **1** `gate-answer` event with that `deliveryId` (layer b — in-process dedup).
    5. Assert `awaitCockpitEvents` surfaces exactly **1** bus entry.

    Both layer failures produce distinct assertion messages — do not collapse them into one `expect`.

- [ ] **T026** [US1] **F1 — Malformed answer NDJSON line skipped-and-logged** (FR-013). Per `contracts/fake-peer-protocol.md` §"F1":
    1. `await appendFile(answersFilePath, 'this is not json\n')` — direct file write, bypassing the peer.
    2. `sendApiRequest('POST', '/cockpit/answers', answerLineFixture({ deliveryId: 'delivery-after-garbage' }))`.
    3. `doorbell.waitForEvent(e => e.type === 'gate-answer' && e.deliveryId === 'delivery-after-garbage')` — assert doorbell alive and processing subsequent lines.
    4. Optional but recommended: `expect(doorbell.stdoutLines.some(l => l.includes('malformed') || l.includes('parse'))).toBe(true)` — verify the doorbell logged the drop (defensive against silent-swallow).

- [ ] **T027** [US1] **F2 — Invalid gate-open body → 4xx + no relay event** (FR-014). Per `contracts/fake-peer-protocol.md` §"F2":
    1. `fetch(orchestratorUrl + '/cockpit/gates', { method: 'POST', body: JSON.stringify({}) })` — deliberately missing required fields.
    2. Assert `resp.status` is 4xx (400–499).
    3. `await sleep(200)` — grace window for any accidental async event to leak.
    4. `expect(peer.received.events.filter(e => e.event === 'cluster.cockpit')).toHaveLength(0)`.

- [ ] **T028** [US1] [US3] **F3 — Answers-file rotation preserves unacked lines** (FR-015). Per `contracts/fake-peer-protocol.md` §"F3":
    1. Inject `answerLineFixture({ deliveryId: 'delivery-pre-rotation' })` via `sendApiRequest`.
    2. `doorbell.waitForEvent(e => e.deliveryId === 'delivery-pre-rotation')`.
    3. `rename(answersFilePath, answersFilePath + '.1')` + `writeFile(answersFilePath, '', 'utf8')`.
    4. Inject `answerLineFixture({ deliveryId: 'delivery-post-rotation' })`.
    5. `doorbell.waitForEvent(e => e.deliveryId === 'delivery-post-rotation')` — assert doorbell tolerated the rotation.

**Parallelism**: T020–T028 all edit the **same file** (`cockpit-gates-integration.integration.test.ts`), so they run **sequentially**, not in parallel. Order does not matter functionally; T020 → T021 → T022 → … is a sensible authoring order that mirrors the scope list.

---

## Phase 4: FR-012 surgical seam fixes

<!-- Only tasks whose T001 audit flagged "MISSING (≤20 LOC — land in this PR)" get expanded into concrete tasks below. Delete or `.skip()` tasks whose seams are PRESENT or exceed 20 LOC. Each landing fix must include an inline comment: `// see #<sibling-issue> — <one-line reason>` per plan D-2. -->

- [ ] **T030** [US1] **(Conditional on T001 finding — S-1 missing)** Add `COCKPIT_ANSWERS_FILE` env override to the answers-file writer in `packages/orchestrator/src/routes/answers.ts` (or the actual sibling file if the writer landed elsewhere). Read `process.env.COCKPIT_ANSWERS_FILE` at writer construction; fall back to `/workspaces/.generacy/cockpit/answers.ndjson`. ≤5 LOC. Inline comment: `// see #1021 — env-var seam for test-mode answers-file location`.

- [ ] **T031** [US1] **(Conditional on T001 finding — S-2 missing)** Add `'cluster.cockpit'` to the `ALLOWED_CHANNELS` tuple in `packages/orchestrator/src/routes/internal-relay-events.ts` (currently at lines 9–15 per research.md R-2). 1 LOC + inline comment: `// see #1021 — cluster.cockpit channel added by cockpit remote gates epic`.

- [ ] **T032** [US1] **(Conditional on T001 finding — S-3 hookup missing but ≤20 LOC)** Add the `else if (event === 'cluster.cockpit')` branch to `internal-relay-events.ts` mirroring the `cluster.vscode-tunnel` retention pattern in `routes/retained-tunnel-event.ts`. If the retention state module (`retained-cockpit-event.ts`) exists, wire the hookup only. If the whole retention module also needs writing (>20 LOC), do NOT do it here — `.skip()` T021 (S1b) with a follow-up link per plan D-2.

- [ ] **T033** [US1] **(Conditional on T001 finding — S-5 missing)** Add `COCKPIT_ANSWERS_FILE` env read to `packages/generacy/src/cli/commands/cockpit/doorbell.ts` (in `doorbellCommand()` or the helper it calls to locate the tail target). Fall back to the production path. ≤5 LOC. Inline comment: `// see #1023 — env-var seam for test-mode answers-file location`.

- [ ] **T034** [US2] **(Conditional on T001 finding — S-9 missing)** Add `./gates` to the `exports` field of `packages/cockpit/package.json` so `import { ... } from '@generacy-ai/cockpit/gates'` resolves from `@generacy-ai/orchestrator`. ≤5 LOC package.json edit.

**Skip guidance**:
- If S-4 (ack route) is missing: `.skip()` T023 (S3), file a follow-up in the #1021 conversation, note in PR description. Harness ships at 7/8 scenarios asserted (documented deviation from SC-002 = 8/8).
- If S-7 (doorbell startup re-read) is behaviorally wrong: `.skip()` T024 (S4), file a follow-up in the #1023 conversation. Do **not** paper over — the point of the harness is to surface this exact class of contract drift.
- If S-10 (fixture builders) is missing: prefer landing them in `packages/cockpit/src/gates/fixtures.ts` (~30–50 LOC) as a co-authored fixup in #1020's PR conversation. As a last resort, inline them in `scenario-helpers.ts` behind a giant `// TODO(#1020)` and file the follow-up before merging.

**Parallelism**: T030–T034 touch different files → run in parallel where all needed. Mark each with [P] if scheduling.

---

## Phase 5: Documentation

- [ ] **T040** [P] [US2] Author `packages/cockpit/src/gates/README.md` — wire-shape reference table keyed by contract name (FR-011 / SC-005). Content mirrors `contracts/fake-peer-protocol.md` in this spec directory but written for cross-repo consumption by generacy-cloud (P2). Include:
    - The four RelayMessage frames the harness exchanges: gate-open event, outcome-ack event, `POST /cockpit/answers` api_request, api_response.
    - The `data.kind` discriminator convention on `cluster.cockpit` events.
    - The connection lifecycle (handshake → heartbeat → steady state).
    - A pointer back to `specs/1024-part-cockpit-remote-gates/quickstart.md` for the operator-facing invocation.

    If `packages/cockpit/src/gates/` doesn't exist yet (sibling #1020 not landed), file this file at `packages/cockpit/README.md` with an `## Gates protocol` section instead — same content, different resting place — and file a follow-up to migrate it once #1020 lands.

- [ ] **T041** [P] [US2] Sanity-check that `specs/1024-part-cockpit-remote-gates/quickstart.md` (already authored during `/plan`) accurately describes the final harness invocation (`pnpm --filter @generacy-ai/orchestrator test -- cockpit-gates-integration`), the env-var override (`COCKPIT_ANSWERS_FILE`), and the doorbell-bin build prerequisite (`pnpm --filter @generacy-ai/generacy build`). Update if any command drifted during implementation.

---

## Phase 6: Changeset

- [ ] **T050** [US1] Add `.changeset/1024-cockpit-gates-integration.md`. Bump level per plan Constitution Check (CLAUDE.md gate):
    - **Default: `patch`** for `@generacy-ai/orchestrator` (integration harness + surgical seam fixes are not new user-facing capability). Include `@generacy-ai/cockpit` **patch** iff T040 landed a README addition or new export inside `packages/cockpit/src/`.
    - **Upgrade to `minor`** iff FR-012 required a **new public export** from `packages/cockpit/src/gates/` (e.g., a fixture builder that didn't exist before) or a **new orchestrator route path** — per CLAUDE.md "new capability → minor".
    - **Add every package whose non-test `src/` changed** — per CLAUDE.md "The gate only checks that *some* changeset was added, so a changeset missing a package still passes CI but silently ships that package unreleased — get this right by hand."
    - Include a one-line "what changed" description referencing #1024 for release notes.

  The test file itself is exempt from the changeset gate (`*.integration.test.ts` under `__tests__/`). This changeset is only required because Phase 4 seam fixes and/or the T040 README addition touch non-test files under `packages/*/src/`. If both Phase 4 and T040 landed zero `src/` edits, this task is unnecessary — verify with `git diff --diff-filter=A --name-only origin/develop` before deciding. If genuinely no `src/` edits: `pnpm changeset --empty`.

---

## Phase 7: Verification

- [ ] **T060** [US1] Run the full suite: `pnpm --filter @generacy-ai/orchestrator test -- cockpit-gates-integration`. Assert every scenario in Phase 3 passes (skipping only those flagged by T001 with a linking follow-up). Record median + p95 wall-clock across 3 runs; both must satisfy SC-006 (median <30 s, p95 <90 s). If runtime blows the budget, follow `contracts/scenario-catalog.md` §"Scenario runtime budget" — consider `describe.sequential` sharing an orchestrator instance across scenarios that don't need isolation.

- [ ] **T061** [US1] **SC-003 breakage rehearsal** — during PR review, apply the deliberate 1-line breakage from `contracts/scenario-catalog.md` for **each** of the four P1 siblings (#1020, #1021, #1022, #1023) and rerun the harness. For each: (a) confirm at least one scenario fails with a message attributable to that sibling (not a generic timeout in an unrelated scenario), (b) restore the code, (c) attach the failure output to the PR description as evidence for SC-003. This is a manual step performed by the PR author or a reviewer — record the four sets of output.

- [ ] **T062** [US2] **SC-004 wire-shape single-source check** — grep the test file: `rg "z\\.object\\(" packages/orchestrator/src/__tests__/cockpit-gates-integration.integration.test.ts` should return **zero** matches. Same for any literal `{ kind: 'gate-open', ... }` shape not derived from a fixture builder or discriminator constant. Attach the grep output (0 matches) to the PR body.

- [ ] **T063** [US1] Type-check + lint the new files: `pnpm --filter @generacy-ai/orchestrator typecheck` (or the equivalent script). If the workspace has an ESLint rule against `console.warn` in production code, verify the `fake-peer.ts` fallback logging is scoped to test-only files by convention (all three helpers are under `__tests__/`, so they should be exempt).

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:

1. **Phase 1 (Setup / seam audit)** — T001, T002, T003 all before Phase 2. T001 is the load-bearing task; T002 and T003 can run in parallel with T001.
2. **Phase 2 (Foundational helpers)** — T010, T011, T012 run in parallel with each other. All three block Phase 3.
3. **Phase 3 (8-scenario test file)** — T020–T028 all edit one file, so run sequentially (functional order does not matter — pick the authoring order that groups related fixtures). Blocked by Phase 2.
4. **Phase 4 (FR-012 seam fixes)** — T030–T034 run in parallel where all three needed; land alongside Phase 3 as scenarios reveal missing seams. Fixes may unblock previously `.skip()`'d scenarios in Phase 3 — re-enable those tests as fixes land.
5. **Phase 5 (Documentation)** — T040, T041 in parallel. Can start any time after Phase 2; ready-to-commit only after Phase 3 stabilizes (docs match the final invocation).
6. **Phase 6 (Changeset)** — T050 waits for Phase 4 outcome (bump level depends on what landed). Skip entirely if no non-test `src/` edits.
7. **Phase 7 (Verification)** — T060 → T061 → T062 → T063. T060 blocks T061 (breakage rehearsal needs a green baseline).

**Parallel opportunities**:
- Phase 2: T010, T011, T012 (three distinct files, no cross-imports).
- Phase 4: T030, T031, T033, T034 (three distinct files).
- Phase 5: T040 and T041 (different files).

**Story alignment**:
- **US1 (path provably wired)** — T001, T002, T003, T010, T011, T020–T028, T030–T034, T050, T060, T061, T063.
- **US2 (cloud can mirror shapes)** — T012, T034, T040, T041, T062.
- **US3 (restart/dedup verified)** — T022, T024, T025, T028.

## Notes

- **Test-file location rationale** — plan D-1: co-located with `packages/orchestrator/src/__tests__/relay-integration.integration.test.ts` because that's the established location for cross-orchestrator integration tests speaking the relay protocol against a `ws` server.
- **No re-pin of `playbook-verification.test.ts`** — this issue does NOT edit any `packages/claude-plugin-cockpit/commands/*.md` file (verified via grep on spec.md, plan.md, and issue body).
- **No worktree**: the harness lands in the primary work-tree branch `1024-part-cockpit-remote-gates`. Nothing here needs isolation.
