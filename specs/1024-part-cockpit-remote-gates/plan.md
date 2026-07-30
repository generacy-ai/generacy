# Implementation Plan: Cockpit gates — cluster-side end-to-end integration test

**Feature**: Prove the cluster-side path of the Cockpit Remote Gates epic end-to-end with a fake relay peer; close any inter-P1 seams found.
**Branch**: `1024-part-cockpit-remote-gates`
**Status**: Complete
**Spec**: [`spec.md`](./spec.md) · **Clarifications**: [`clarifications.md`](./clarifications.md)
**Epic plan**: [`cockpit-remote-gates-plan.md`](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md)

## Summary

Issue #1024 is the last item in P1 of the **Cockpit Remote Gates** epic. It does not add product surface; it produces a runnable **integration harness** that composes the four preceding P1 siblings (contracts #1020, orchestrator routes + `cluster.cockpit` channel + answers-file writer #1021, MCP `cockpit_gate_open`/`cockpit_gate_ack` #1022, doorbell answers-file tail #1023) against a **fake relay peer** and asserts the eight cross-component scenarios in Scope + FR-013–FR-015.

**Hybrid process model** (clarification Q3 → C, FR-001): orchestrator (Fastify) and the cockpit MCP event-bus registry are booted **in-process under Vitest**; the doorbell is launched as a **real child process** (`spawn()` of `packages/generacy/dist/bin/generacy.js cockpit doorbell` under Node) so FR-007's kill-and-restart assertion actually exercises the spawn/exit lifecycle.

**Fake peer** is a thin `ws`-based WebSocket server that speaks the existing `RelayMessageSchema` union — no new wire protocol, no changes to `packages/cluster-relay/`. The orchestrator's `RelayBridge` is pointed at `ws://127.0.0.1:<port>` under test env.

**Assertions single-source** their contract shapes from `packages/cockpit/src/gates/` (FR-009 / SC-004) — the harness imports the fixture builders exported by the contracts sibling (#1020). No inline schema literals.

**Documented invocation** (FR-011 / SC-005): a `quickstart.md` in this spec directory + a README section in `packages/cockpit/src/gates/` describe the message shapes the harness exchanges, keyed by contract name, so P2's cloud-side fake-cluster tests (generacy-cloud) can mirror the exact bytes.

**Design invariants**:
1. **No cloud dependency, no live GitHub, no smee** — the fake peer replaces all three (FR-002, FR-010).
2. **Wire shapes are single-sourced**: the harness imports fixture builders from `packages/cockpit/src/gates/` — a `grep`-based gate on the test file enforces zero inline schema literals (SC-004).
3. **Answers file path is per-test**: the routes sibling (#1021) accepts `COCKPIT_ANSWERS_FILE` (or a config seam of the same shape) that redirects the default `/workspaces/.generacy/cockpit/answers.ndjson` into a per-test temp directory (spec Assumption §100). If that seam did not land, this issue adds it — per FR-012 ("fix integration gaps in the P1 siblings as part of this issue").
4. **Retain-and-replay for `cluster.cockpit`** mirrors the existing `cluster.vscode-tunnel` pattern in `routes/retained-tunnel-event.ts` (spec Assumption §101). Assertions verify observed behavior, not the retention implementation.
5. **Both dedup layers are asserted** (FR-008, clarification Q2 → C): the harness asserts (a) the answers file contains exactly one line per `deliveryId` **and** (b) the doorbell + `cockpit_await_events` bus each emit exactly one entry per `deliveryId` across a restart. Either layer failing produces a distinct assertion failure attributable to the responsible sibling.
6. **Position model on doorbell restart** (FR-007, clarification Q1 → B): no on-disk sidecar. The doorbell always re-reads from head and skips already-acked `deliveryId`s by consulting the ack registry / MCP event-bus. Assertions target the observed emit count, not an offset file.

## Technical Context

**Language/Version**: TypeScript, Node.js ≥22 (matches `packages/generacy/package.json`, spec Assumption §102).
**Primary Dependencies**:
- `vitest` (test runner, already used across `packages/orchestrator/src/__tests__/`).
- `ws` + `@types/ws` (WebSocket server for the fake peer — already a dependency of `packages/cluster-relay`; add to the harness package's dev-deps if the harness lives outside cluster-relay).
- `@generacy-ai/cockpit` — imports the `gates/` fixture builders (#1020).
- `@generacy-ai/cluster-relay` — imports `RelayMessageSchema`, message types.
- `fastify` (in-process orchestrator boot — via existing `createServer()` in `packages/orchestrator/src/server.ts` or a lighter fixture that only wires the gate routes).
- `node:child_process` (`spawn()` for the doorbell).
- `node:fs/promises` (per-test temp directory, answers-file assertions).
- Zero cloud/GitHub dependencies. No `firebase-tools`, no Docker.

**Storage**: The harness writes to a per-test temp directory (`os.tmpdir()`-based, cleaned in `afterEach`). Answers-file location redirected via `COCKPIT_ANSWERS_FILE` (or equivalent seam from #1021). No Firestore, no Redis, no cluster registry mutations.
**Testing**: `vitest` — mirrors `packages/orchestrator/src/__tests__/relay-integration.integration.test.ts` (uses `WebSocketServer` from `ws`, a `MockRelayClient` pattern, `waitFor()` polling helper).
**Target Platform**: CI runners (Linux, Node ≥22). Same runners as the rest of `pnpm test` (FR-010).
**Project Type**: Single-package test harness. Sits inside `packages/orchestrator/src/__tests__/` (established location for cross-orchestrator integration tests) with a small helper module under `packages/orchestrator/src/__tests__/cockpit-gates/` for the fake-peer utility and per-scenario builders. **Alternative considered and rejected**: separate `packages/cockpit-gates-harness/` package — adds workspace overhead for one file (see research.md §D-1).
**Performance Goals**: SC-006 — median CI run **under 30 s**, p95 **under 90 s**. Chosen budget accommodates: orchestrator boot (~2–4 s cold), doorbell spawn (~1 s), 8 scenarios × ~2 s each (WebSocket setup + assertion polling). Slower than the sibling unit tests but well within the "integration test" bucket that already exists (e.g., `relay-integration.integration.test.ts` runs ~15–25 s locally).
**Constraints**: No network egress (`ws://127.0.0.1:<port>` only). No live smee channel. No live GitHub App / installation-token calls (FR-010). Must not depend on Firebase emulators or Docker.
**Scale/Scope**: One integration test file (~500–800 LOC) with 8 scenarios (5 happy-path + 3 failure-mode) + a fake-peer helper module (~150 LOC) + a `spawn()` doorbell driver helper (~100 LOC). Total additions: ~2 new source files, 1 test file, 1 quickstart.md, 1 README addendum in `packages/cockpit/src/gates/`, 1 changeset. **Zero product-code additions** unless FR-012 seams (see below) require them.

## Constitution Check

*No `.specify/memory/constitution.md` exists in this repo (verified — `.specify/` only holds `templates/`). Standard project conventions apply:*

- ✅ **Changesets** (CLAUDE.md gate): the test file itself is `*.integration.test.ts` — under the CLAUDE.md **test-only exemption** ("Test-only changes under `packages/*/src/` are exempt — the gate skips diffs whose in-scope files are all `*.test.ts` / `*.spec.ts` / `__tests__/`"). **However**, this PR will touch **non-test files** in two situations, both of which trigger the gate and require a changeset:
  1. FR-012 seam fixes in `packages/orchestrator/src/routes/` (e.g., answers-file path env var, `cluster.cockpit` allow-list addition, retain-and-replay wiring) that need to land here rather than in #1021 — see the D-2 decision below.
  2. Any documentation exported from `packages/cockpit/src/gates/README.md` — README changes under `src/` are non-test and count.

  Bump level: **`patch`** by default (integration harness + doc addendum + surgical seam fixes are not new user-facing capability). If FR-012 requires a new **public** export from `packages/cockpit/src/gates/` or a new orchestrator route path, upgrade to **`minor`** (per CLAUDE.md "new capability → minor"). One changeset file: `.changeset/1024-cockpit-gates-integration.md`.
- ✅ **No new dependencies**: `ws`, `vitest`, `fastify` are all already present.
- ✅ **`cluster.*` channel namespace**: this harness asserts against the new `cluster.cockpit` channel that #1021 adds to `ALLOWED_CHANNELS` in `routes/internal-relay-events.ts`. If #1021 landed without adding the allow-list entry, this issue adds it (FR-012).
- ✅ **Never-merge-on-red**: unaffected.
- ✅ **Observer independence** (upheld from #1015): the harness does not touch cockpit claim state.

## Deferred Clarifications — Plan-Phase Decisions

Four clarifications were resolved in `clarifications.md` (Q1–Q4). Three additional implementer-selectable decisions are recorded here:

### D-1: Harness location

**Choice**: Live inside **`packages/orchestrator/src/__tests__/cockpit-gates-integration.integration.test.ts`** with helpers under `packages/orchestrator/src/__tests__/cockpit-gates/`.

**Rationale**:
- Mirrors `packages/orchestrator/src/__tests__/relay-integration.integration.test.ts` — the established location for cross-orchestrator integration tests that speak the relay protocol against a `ws` server (this file was the template for the fake-peer helper).
- Orchestrator's `pnpm test` script already runs `.integration.test.ts` files under `__tests__/`; SC-001 (CI green) is satisfied by convention, no new script wiring.
- Alternative (a separate `packages/cockpit-gates-harness/` package) rejected: adds workspace-graph overhead + a new tsconfig/build target for one test file. The test *does* need to import from `packages/cockpit/src/gates/` (FR-009), but `@generacy-ai/cockpit` is already a workspace dep of `@generacy-ai/orchestrator` (verified below).
- Alternative (`packages/cockpit/src/__tests__/`) rejected: cockpit is a CLI package with no HTTP surface; hosting an orchestrator-boot integration test there inverts the dependency arrow.

**Import shape**:
```ts
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import {
  gateOpenFixture,
  answerLineFixture,
  outcomeAckFixture,
  parseGateOpenEvent, // etc.
} from '@generacy-ai/cockpit/gates';   // exported by #1020
import { createServer } from '../server.js';
```

**File layout** (see Project Structure below):
```text
packages/orchestrator/src/__tests__/
├── cockpit-gates-integration.integration.test.ts     # THE 8-scenario test file
└── cockpit-gates/
    ├── fake-peer.ts        # WebSocketServer helper (handshake, event ingest, api_request send)
    ├── doorbell-driver.ts  # spawn/kill/restart helper for the doorbell child process
    └── scenario-helpers.ts # per-scenario builders (open→observe, answer→observe, ack→observe)
```

### D-2: Where FR-012 seam fixes land

**Choice**: Seams discovered during harness development that require **≤ 20 LOC of surgical fix** land in **this PR**. Anything larger (a new route path, a new schema field, a new relay-channel emitter, a refactor) is filed as a **follow-up issue and referenced from the PR body**, then unblocked by re-baselining once the sibling merges.

**Rationale**:
- The issue text is explicit: "Fix any integration gaps discovered in the P1 issues as part of this issue" (FR-012).
- But the spec's own Out-of-Scope list forbids contract redesign ("Contract redesign … contract changes are proposed on the epic before diverging"). Surgical missing-hookup fixes (an env-var read, an allow-list entry, a missing `await`) are integration wiring; they are not contract changes.
- The 20 LOC threshold matches how the repo has historically handled cross-issue seam fixes (e.g., #598 wizard-mode relay bridge, #596 code-server probe) — small fixes ride the discovering PR; anything bigger gets its own issue.
- SC-003 requires that a deliberate 1-line breakage in **each** of the four siblings produces a failing scenario in this harness. That itself is evidence the harness *found* the seam; the fix location follows the ≤20 LOC rule.

**Expected FR-012 candidates** (verified during harness build — not decided in advance):
- `COCKPIT_ANSWERS_FILE` env var / config seam in `routes/answers.ts` (from #1021) — if missing, add.
- `cluster.cockpit` in `routes/internal-relay-events.ts` `ALLOWED_CHANNELS` — if missing, add.
- Retain-and-replay branch for `cluster.cockpit` in `routes/internal-relay-events.ts` — if missing and #1021 requires it, add.
- Doorbell recognizing the answers-file path from an env var — if missing, add.

Any seam fix lands with a one-line comment linking to the sibling issue (`// see #1021 — env-var seam for test-mode answers-file location`).

### D-3: Fake-peer connection model

**Choice**: The fake peer is a **`WebSocketServer` on a random port** to which the orchestrator's `RelayBridge` connects as a **real client**. The orchestrator is booted with a `relay.relayUrl = ws://127.0.0.1:<port>` config override; no mocking of `ClusterRelay` internals.

**Rationale**:
- Exercises the full outbound relay codepath: `RelayBridge.start()` → `ClusterRelay.connect()` → handshake → `event` dispatch → retention-on-disconnect logic in `routes/internal-relay-events.ts`. Verified against the pattern in `packages/cluster-relay/tests/relay.test.ts` which uses `WebSocketServer` from `ws` with `port: 0` (random).
- Alternative (a `MockRelayClient` implementing the `ClusterRelayClient` interface, as in `relay-integration.integration.test.ts`) rejected: skips the wire-framing seam, and #1024's whole raison d'être is closing wire-framing seams between the four P1 siblings and the cloud (P2). A mocked client would let a JSON serialization drift pass the harness.
- The fake peer's inbound handling: parses each received `RelayMessage`, records `event` messages of channel `cluster.cockpit` into an in-memory array the assertions read, and responds to `api_request` frames with a controllable delay + status (default: forward to a nested Fastify handler that maps `POST /cockpit/answers` to a bare 200; the answers-file writer is exercised end-to-end because the orchestrator's `RelayBridge` receives the `api_request` from the fake peer and dispatches it through the normal HTTP path).

## Project Structure

### Documentation (this feature)

```text
specs/1024-part-cockpit-remote-gates/
├── plan.md                     # This file
├── spec.md                     # Feature specification (read-only)
├── clarifications.md           # Batch 1 clarifications (read-only)
├── research.md                 # Phase 0 output (new)
├── data-model.md               # Phase 1 output (new)
├── contracts/
│   ├── fake-peer-protocol.md   # Wire messages the fake peer exchanges (new)
│   ├── scenario-catalog.md     # 8-scenario contract (new)
│   └── env-seams.md            # COCKPIT_ANSWERS_FILE and siblings (new)
├── quickstart.md               # Operator + P2 mirror-doc (new)
└── checklists/                 # Empty (no checklist requested)
```

### Source Code (repository root)

New files (harness + helpers, all under `packages/orchestrator/src/__tests__/`):

```text
packages/orchestrator/src/__tests__/
├── cockpit-gates-integration.integration.test.ts   # NEW — 8 Vitest scenarios (5 happy + 3 failure)
└── cockpit-gates/
    ├── fake-peer.ts                                 # NEW — WebSocketServer wrapper, handshake, ingest, api_request send
    ├── doorbell-driver.ts                           # NEW — spawn/kill/restart the doorbell bin, NDJSON stdout capture
    └── scenario-helpers.ts                          # NEW — per-scenario builders using @generacy-ai/cockpit/gates fixtures
```

Documentation additions:

```text
packages/cockpit/src/gates/README.md                # NEW/MODIFIED — wire-shape reference table keyed by contract name (P2 mirror)
```

Possible surgical FR-012 seam fixes (only if not landed by siblings; ≤20 LOC each per D-2):

```text
packages/orchestrator/src/routes/answers.ts          # MODIFY — read COCKPIT_ANSWERS_FILE env override (if #1021 missed it)
packages/orchestrator/src/routes/internal-relay-events.ts # MODIFY — add 'cluster.cockpit' to ALLOWED_CHANNELS (if #1021 missed it) + retain-and-replay branch
packages/orchestrator/src/routes/retained-tunnel-event.ts # POSSIBLE MODIFY — factor a per-channel retention helper if cluster.cockpit needs it (deferred to sibling if >20 LOC)
packages/generacy/src/cli/commands/cockpit/doorbell.ts    # MODIFY — read COCKPIT_ANSWERS_FILE env override (if #1023 missed it)
```

Changeset:

```text
.changeset/1024-cockpit-gates-integration.md         # NEW — patch (or minor if a new public export was needed)
```

**Structure Decision**: Test file + `cockpit-gates/` helper folder live inside `packages/orchestrator/src/__tests__/` — matching the sibling `packages/orchestrator/src/__tests__/relay-integration.integration.test.ts` layout. This co-locates the harness with the code it exercises most (orchestrator routes + `RelayBridge`) and reuses the orchestrator's existing Vitest + tsconfig setup. No new workspace package, no new build target. The `@generacy-ai/cockpit` import (for the gates fixture builders) is a workspace dep already resolvable from `@generacy-ai/orchestrator`.

## Constitution Re-Check (Post-Design)

- ✅ **Test-only rule**: the harness file itself is exempt from the changeset gate. Any FR-012 seam fix under `packages/*/src/` is non-test and triggers the gate — the changeset covers it.
- ✅ **No new dependencies**: `ws`, `vitest`, `fastify`, `@generacy-ai/cockpit`, `@generacy-ai/cluster-relay` all already resolvable.
- ✅ **Wire-shape single-sourcing**: enforced by importing from `packages/cockpit/src/gates/` (FR-009). SC-004 grep gate to be added to the test file preamble (as a comment for reviewers) and implicitly enforced by the reviewer + the sibling's own contract tests.
- ✅ **CI runtime budget**: 30 s median / 90 s p95 (SC-006). Sibling `relay-integration.integration.test.ts` runs comfortably within this range; the 8-scenario harness adds child-process spawn overhead but only once per test.
- ✅ **Retain-and-replay pattern reuse**: `routes/retained-tunnel-event.ts` provides the template; if `cluster.cockpit` needs a per-channel retention slot, D-2 governs whether the extraction happens here or in a follow-up.
- ✅ **Observer independence** (from #1015): the harness never calls `cockpit_claim` / `cockpit_release`, so it cannot regress that invariant.

## Complexity Tracking

No constitution violations. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| (none)    | —          | —                                    |

## Next Step

Run `/speckit:tasks` to generate the ordered task list.
