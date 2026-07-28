# Research: Gate IDs must not collide across runs

**Feature**: #1053 — per-run discriminator on `gateKey`
**Branch**: `1053-problem-gateid-pure-function`

Research covers only the decisions that the plan chose to record with rationale, prior art, and rejected alternatives. Cross-referenced with `clarifications.md` Q1–Q5 and the plan's D-1–D-4.

## R-1: Run-discriminator identity — where the `runId` comes from

**Decision**: Use the auto-run id already minted by `/cockpit:auto` for its ledger (shape `christrudelpw-snappoll-1-20260727-200458` — cluster+repo+issue+timestamp). Thread as an explicit optional field on `GateOpenInputSchema` and `GateAckInputSchema`. Fall back to `INSTANCE_NONCE` when absent.

**Rationale**:

- **Run-lifetime, not process-lifetime, not epic-lifetime.** The auto-run id survives MCP-server restarts within a run because the auto-loop re-passes it on every wake tick. This is the exact scope US2 AC-3 requires — an MCP-server restart mid-run must not break within-run idempotency.
- **Takeover composes cleanly with #1015.** A `--takeover` under #1015 mints a fresh session identity, which mints a fresh auto-run id (fresh timestamp), which produces a fresh `gateId` by construction. US1's takeover trigger path holds without any extra logic.
- **Existing artifact.** The id is already minted for the auto-loop's ledger — no new identity source to design, name, own, or version.
- **Explicit-input pattern is the cheap escape from ambient state.** MCP tools that read ambient state (`INSTANCE_NONCE` alone) can't be tested for "different runs" without spinning up different servers; an explicit field is trivially varied in unit tests.

**Alternatives considered**:

- **`INSTANCE_NONCE` (MCP-server process nonce)** — rejected as primary. Scope is process-lifetime, not run-lifetime. An MCP-server restart mid-run (which happens: relay reconnect, container recycle, orchestrator crash-loop) would flip the discriminator and break US2 for the retry-after-restart case. `INSTANCE_NONCE` is fine as the *fallback* for non-auto callers (see R-2) — that path has no "run" boundary to preserve.
- **Tool-persisted disk file** — rejected. Introduces a new persistence surface with its own lifecycle: when does the file get created, when does it get deleted, what happens if it's stale, what happens if two MCP servers race to create it. Sibling #1051 explicitly avoided this under FR-007 ("no new persisted state"); #849's postmortem attributed the entire bug class to a stale Redis key.
- **`sessionId` field on `GateOpenInputSchema`** — rejected. `sessionId` today identifies the conversation/session, not the auto run. Under #1015 it is likely to *become* `INSTANCE_NONCE` — the same trap one level of indirection away, plus a silent semantic shift.

## R-2: Fallback source for non-auto callers

**Decision**: When no `runId` is passed on the tool input, mint a fallback from the module-level `INSTANCE_NONCE` (`packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts:72`). Log at `info` with `source: 'fallback-instance-nonce'`.

**Rationale**:

- Without an explicit fallback, non-auto callers silently keep today's colliding behaviour and the bug survives for exactly the manual path an operator would use to work around it. Q1's clarification explicitly called this out.
- `INSTANCE_NONCE` is per-MCP-process. For a manual `cockpit_gate_open` call, retries against the SAME server get the SAME `INSTANCE_NONCE` → the SAME `gateId` → within-caller idempotency preserved. Different MCP-server instances get different fallbacks — the correct behaviour because they ARE different runs from the tool's perspective.
- Structured log at `info` makes source-selection observable in the field. When triaging a future "why did this gate open twice" report, the log line disambiguates "caller sent different runIds" from "caller relied on fallback and hit a restart."

**Alternatives considered**:

- **`crypto.randomUUID()` per call** — rejected. Would break within-caller retry idempotency: two retries of the same manual call would produce different `gateId`s → two inbox rows. Exactly the bug Q4-A hoists `askedAt` to prevent.
- **Refuse the call when `runId` is missing** — rejected. Non-auto callers exist (`cockpit_gate_open` is callable directly from LLM tool-use paths outside the auto loop). A hard refusal would break those callers without a corresponding fix.

## R-3: Wire representation — string composition vs. explicit field

**Decision**: Fold `runId` into the `gateKey` pre-image string only. New shape `${issueRef}:${gateType}:${generation}:${runId}`. No `runId` field on `GateOpenWireSchema` or the cloud's `gateOpenPayloadSchema`.

**Rationale**:

- **Zero cloud-schema change.** The cloud hashes a longer opaque string it treats as bytes, derives a different `gateId`, and treats the frame as a fresh gate. This is the property that makes Q2's decoupling achievable — no cross-repo schema coordination is required to ship the primary fix. The cloud is `sha256(gateKey).slice(0,24)`-agnostic to what's inside `gateKey`.
- **Recoverable, not indexed.** `gateKey` is stored on the cloud doc, so `christrudelpw/snappoll#1:phase-queue:P2:<runId>` is available for debugging via doc inspection. It's not queryable by `runId` alone — but Q3-A's clarification confirmed that's sufficient. Add an explicit `runId` wire field later only if cloud-side analytics need an index.
- **Compatible with FR-010's "zero removed or renamed fields" invariant** by construction. No wire-field addition, no wire-field removal.

**Alternatives considered**:

- **Add explicit `runId` field to `GateOpenWireSchema`** — rejected as the primary approach. Would allow cloud-side filtering/analytics by run, at the cost of coordinated cloud schema update, mirror-file update, and cross-repo release synchronization. Not worth the ~1× benefit for the primary fix; can be layered on later.
- **Both — fold into `gateKey` AND surface as a wire field** — rejected. Belt-and-suspenders that costs one more field for observability we don't yet need. If the future case appears, the additive field is cheap to add.
- **Recompute cloud-side from ambient frame state** (`sessionId` + `serverTime`) — rejected as a straw-man. Couples cloud identity derivation to cluster-side state the cloud can't verify; fragile.

## R-4: `askedAt` handling — hoist vs. rely on cloud dedup

**Decision**: Hoist `askedAt` above the retry boundary. Cache per-`gateId` in a module-level `Map`, reuse on every retry. Two retried frames become byte-identical.

**Rationale**:

- **US2 correctness must not depend on cloud `gateId`-keyed dedup.** That same dedup mechanism is the bug source under FR-004. If we relied on it for within-run idempotency, we'd be tying US2 to a mechanism the primary fix is specifically working around.
- **Byte-identical frames are self-evidently idempotent.** Two `POST /cockpit/gates` calls with the same body produce the same outcome at any relay / orchestrator / cloud layer, regardless of what those layers do with dedup. Robust to future changes in either direction.
- **Cache lifetime matches run lifetime by construction.** The auto-loop drives one MCP-server per run; the process-lifetime cache aligns with the run boundary (the MCP server dies at run end). Non-auto callers get within-caller idempotency at MCP-server granularity, which is the correct scope.

**Alternatives considered**:

- **Accept per-call `askedAt`; rely on cloud `gateId`-keyed dedup** — rejected. Option B's own description contained the disqualifying argument: it makes US2 depend on the mechanism FR-004 is working around.
- **Drop `askedAt` from `GateOpenWireSchema`** — rejected. Would break FR-010's "zero removed or renamed fields" invariant. Also loses the cluster-side timing signal (useful for latency debugging).
- **LRU-cap the cache** — rejected. Eviction reintroduces the same problem for late retries (a retry that arrives after eviction gets a fresh `askedAt`, ceases to be byte-identical, US2 correctness stops holding). Memory cost of unbounded (see plan D-2) is negligible.

## R-5: Fix scope — ship FR-004+ now vs. defer

**Decision**: Ship FR-001 + FR-002 + FR-003 + FR-008 + FR-009 + FR-010 in this PR. Defer FR-004 + FR-005 + FR-007 to a follow-up gated on **generacy-ai/generacy-cloud#887**. Defer FR-006 to a companion `agency/packages/claude-plugin-cockpit` PR.

**Rationale**:

- **FR-004 is a backstop for a case FR-001 eliminates.** Once the per-run discriminator lands, terminal collisions stop occurring. Blocking the primary fix on the cloud PR would gate this repo's release on a cross-repo dependency for a case that stops firing.
- **The independent-ship path is strictly better** than the ship-both-mechanisms hybrid (Q2 rejection D). Doubling the implementation cost buys nothing.
- **Cost of the split** is one additional PR and one coordination point (landing order: cloud #887 → cluster FR-004/005/007 → agency FR-006).

**Alternatives considered**:

- **Ship everything together** — rejected. Introduces a hard cross-repo dependency. The primary fix should not wait.
- **Ship poll-based detection now, migrate to synchronous later** — rejected (Q2 rejection D). Doubles the implementation cost, pays for two mechanisms.

## R-6: Test-suite placement

**Decision**: Unit tests for pure derivation in `packages/cockpit/src/__tests__/gates-id.test.ts`. Tool-level tests for fallback + `askedAt` hoist in a new `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/cockpit-gate-open-runid.test.ts`. End-to-end FR-008 assertion via the #1024 fake-relay integration harness at `packages/orchestrator/src/__tests__/cockpit-gates-integration.integration.test.ts`.

**Rationale**:

- SC-001 ("fresh inbox-visible gate") requires the peer's view of the inbox, not just a `gateId` bytecmp. Only the integration harness proves the frame reaches the peer with the expected id.
- SC-002 ("exactly one frame at the relay per within-run open") is only meaningful with the peer counting frames.
- Pure-derivation unit tests give fast per-commit feedback and catch trivial regressions (someone reverts the `runId` append) before the slower integration suite runs.

**Alternatives considered**:

- **Unit-only.** Would satisfy SC-001/SC-002 arithmetically (via `deriveGateKey` output assertion) but not observationally. The integration harness is already landed by #1024; extending it is cheap.
- **Integration-only.** Slow feedback per commit; no clear regression trail if `deriveGateKey` is reverted without touching the tool wiring.

## Prior art referenced

- **#1020 — Cockpit remote gates shared wire contracts.** Owns the canonical `deriveGateKey` / `deriveGateId` in `packages/cockpit/src/gates/schema.ts`. Frozen wire schemas whose field lists this fix does not touch.
- **#1015 — Active-driver claim per cockpit scope.** Source of the `'claim-conflict'` `ErrorClass` value, the precedent for the FR-005 follow-up's `'terminal-collision'` value. Also the source of `INSTANCE_NONCE` reuse.
- **#1022 / #1023 — Remote-gate MCP tools + doorbell.** Source of the current `cockpit_gate_open.ts` and `cockpit_gate_ack.ts` shapes.
- **#1024 — Cluster-side end-to-end integration harness.** Owns the fake-relay peer this fix's FR-008 test rides on.
- **#849 — Pause-paired resume-dedupe clear.** Precedent for "no new persisted state" as a design invariant.
- **#1051 (planning phase — active-driver claim adjacent).** Same invariant, same reason (stale-key/TTL bug class).
- **#1038 — Query-unreachable error class.** Precedent for adding a new `ErrorClass` value (`'query-unreachable'`) alongside the existing set — same pattern the FR-005 follow-up will use.

## Sources

- Spec: `specs/1053-problem-gateid-pure-function/spec.md`
- Clarifications: `specs/1053-problem-gateid-pure-function/clarifications.md`
- Frozen wire contract (cluster mirror): `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts:58-77`
- Frozen wire contract (canonical): `packages/cockpit/src/gates/schema.ts:108-127`
- Current tool implementation (open): `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.ts`
- Current tool implementation (ack): `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_ack.ts`
- Error-class enum: `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts:22-35`
- `INSTANCE_NONCE`: `packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts:72`
- Field-instance evidence: `spec.md` §Field instance — verified end to end (2026-07-27, `christrudelpw/snappoll#1` P2)
