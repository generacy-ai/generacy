# Feature Specification: Gate IDs must not collide across runs — a terminal gate blocks reopening the same (issueRef, gateType, generation)

**Branch**: `1053-problem-gateid-pure-function` | **Date**: 2026-07-27 | **Status**: Draft | **Issue**: [#1053](https://github.com/generacy-ai/generacy/issues/1053)

## Summary

`gateId = sha256(`${issueRef}:${gateType}:${generation}`).slice(0, 24)` has **no run, cluster, attempt, or time discriminator**. Once a gate reaches a terminal status in the cloud (`applied` / `superseded` / `failed`), that exact triple can **never open a gate again** — the cloud refuses to reopen the terminal doc, the orchestrator gets `202 Accepted` and reports success, and the operator sees "Open gate — needs your answer" against an inbox that shows `0` items. The run stalls indefinitely. For gate types whose `generation` is stable across runs (`phase-queue` uses the phase number → `P2` is `P2` forever on that epic), this collision is not a rare corner — it is the default outcome of re-running any epic that previously reached that phase. The fix must (a) add a per-run discriminator to `gateKey` so re-emission across runs opens a fresh gate, (b) preserve within-run idempotency (retried `gate-open` for the same natural gate still dedupes), (c) surface terminal-collision rejections from the cloud as errors at the `cockpit_gate_open` call site instead of masking them as success, and (d) never leave the run silently stranded when a gate cannot be opened remotely.

## Problem

`gateId` is a pure function of `(issueRef, gateType, generation)` with **no run, cluster, attempt, or time discriminator**. Once a gate reaches a terminal status in the cloud, that exact triple can **never open a gate again** — the cloud correctly refuses to reopen a terminal doc, and the operator sees nothing.

Frozen contract, `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts:58-72`:

```
gateKey = `${issueRef}:${gateType}:${generation}`   // issueRef is owner/repo#N
gateId  = sha256(gateKey) hex, first 24 chars
```

`generation` is documented as "the gateType-specific discriminator (batch id, head SHA, phase number, draft hash, occurrence counter, drain counter…)". For several gate types that value is **stable across runs** — `phase-queue` uses the phase number, so `P2` is `P2` on every run of that epic, forever.

## Field instance — verified end to end

`/cockpit:auto --gates=ui christrudelpw/snappoll#1`, 2026-07-27, after a cluster restart at 19:22:55Z.

The run reached the P2 phase-queue gate and emitted it:

```
20:10:46.032  snappoll-orchestrator-1
  POST /cockpit/gates  gateId=075855bf0c3fef1b7f52ed3a  type=gate-open  → 202 Accepted
```

The cloud dropped it 141 ms later:

```
20:10:46.173  api-staging
  [relay] Ignoring gate-open for terminal gate 075855bf0c3fef1b7f52ed3a (status: applied) from G8IVwqHzfLlumsBCZk0j
```

Because that gateId already existed from **four days earlier**:

| field | value |
|---|---|
| doc | `organizations/vnVZdzlNYc7IykLrPjW5/cockpitGates/075855bf0c3fef1b7f52ed3a` |
| `gateKey` | `christrudelpw/snappoll#1:phase-queue:P2` |
| `status` | `applied` (terminal) |
| `createdAt` | `2026-07-23T15:18:38.174Z` |

Collision verified arithmetically:

```
sha256("christrudelpw/snappoll#1:phase-queue:P2")[:24] = 075855bf0c3fef1b7f52ed3a
stored doc id                                          = 075855bf0c3fef1b7f52ed3a   MATCH
```

Meanwhile the auto session reports the gate as open and waiting:

> **Open gate — needs your answer**
> Phase queue: P2 for christrudelpw/snappoll#1 — in the generacy.ai inbox

and the inbox shows `All gates 0 · snappoll 0`. The run cannot proceed and the operator has nothing to act on.

Four `gate-outcome` acks were dropped the same way in the same window (`bf72bd9a…`, `93c59471…`, `466bda9f…`, `704eb45b…`), all for gates already `applied`.

## Why this is structural, not a restart artifact

The restart only made it *visible* — it caused the orchestrator to walk an epic whose gates were already terminal. The defect fires whenever the same `(issueRef, gateType, generation)` recurs:

- re-running an epic that previously completed
- re-queuing a phase after a cancelled or failed run
- any `--gates=ui` run over an epic previously driven with `--gates=local` where the gate was answered and applied
- a second cluster taking over the same repo (see #1005 serial-per-repo model)

Every one of these produces a permanently un-openable gate. There is no retry, no expiry, and no operator-visible error.

## Proposed fix

1. **Add a per-run discriminator to `gateKey`.** The natural candidate is the auto-run id already minted for the ledger (`christrudelpw-snappoll-1-20260727-200458`), or a cluster-scoped run/session id. `gateKey = `${issueRef}:${gateType}:${generation}:${runId}`` keeps determinism within a run (idempotent re-emission still dedupes, which is the property the frozen contract exists to preserve) while guaranteeing a fresh identity across runs.

   Note this must be decided deliberately: the current design *relies* on cross-emission determinism so a retried `gate-open` is idempotent. Scope the discriminator so idempotency holds within a run and only breaks between runs.

2. **Fail loudly on terminal collision.** `cockpit_gate_open` currently treats `202 Accepted` as success. The cloud already knows the gate was dropped — see the companion generacy-cloud issue — so once the API returns that signal, the tool must surface it rather than reporting the gate open.

3. **Do not silently strand the run.** If a gate cannot be opened remotely, `--gates=ui` should either fall back to a local prompt or escalate, not idle forever waiting for an answer that can never arrive.

## Acceptance criteria

- [ ] Re-running an epic/phase whose previous gate reached `applied` opens a NEW gate that appears in the inbox.
- [ ] Re-emitting the same gate within a single run remains idempotent (no duplicate inbox entries).
- [ ] A terminal-collision rejection from the cloud surfaces as an error at the `cockpit_gate_open` call site, not a success.
- [ ] `--gates=ui` never reports "needs your answer" for a gate the cloud rejected.
- [ ] Regression test: open → apply → re-open the same `(issueRef, gateType, generation)`; assert the second open is visible and distinct.

## Related

- Companion visibility bug in generacy-cloud (filed alongside this).
- #1005 — serial-per-repo cluster model; cluster takeover is one of the trigger paths above.


## User Stories

### US1: Re-running an epic reopens gates that previously reached terminal status

**As** an operator re-running (or resuming, or taking over) `/cockpit:auto` against an epic whose previous run drove some gates to a terminal outcome (`applied` / `superseded` / `failed`),
**I want** each natural gate the second run reaches to open a NEW inbox entry I can act on,
**So that** the run makes progress instead of stalling on an invisible gate that was already answered days ago in a prior run.

**Acceptance Criteria**:
- [ ] Given a `phase-queue` gate for `christrudelpw/snappoll#1` phase `P2` that reached `applied` in Run A, when Run B re-enters that phase, the second `cockpit_gate_open` call produces a `gateId` distinct from Run A's, and that new gate appears in the inbox as `Open`.
- [ ] The behaviour holds for every gate type whose `generation` is stable across runs today — most acutely `phase-queue` (phase number), `scope-drained` (`<owner>/<repo>#<issue>:<counter>` where counter resets per-run), and any other gateType where the discriminator can repeat across independent auto runs against the same epic.
- [ ] Trigger paths covered: (a) plain re-run of a completed epic, (b) requeue of a cancelled/failed run, (c) `--gates=ui` re-entry over an epic previously driven with `--gates=local` where the gate was applied, (d) a second cluster taking over the same repo (per #1005's serial-per-repo takeover model — the takeover cluster gets a new run identity, so its gates must not collide with the previous cluster's terminal ones).

### US2: Re-emitting the same natural gate within a run stays idempotent

**As** the cockpit auto loop,
**I want** to retry `cockpit_gate_open` for the same natural gate (same phase, same epic, same current auto-run) and see the SAME `gateId` returned every time,
**So that** transient failures — relay disconnects, orchestrator restarts within a run, network retries, MCP client retries — do not create duplicate inbox entries the operator would have to disambiguate.

**Acceptance Criteria**:
- [ ] Two `cockpit_gate_open` calls within a single auto run for the same `(issueRef, gateType, generation)` produce the same `gateId` on both calls.
- [ ] The inbox shows exactly ONE row for that natural gate over the lifetime of the run — no duplicate row, no shadow row, no orphaned row that the operator has to guess whether to answer.
- [ ] Idempotency is scoped to a "run" as defined by the discriminator chosen in FR-001 (auto-run id, cluster session id, or equivalent); it does not need to persist beyond that run's boundary — US1 covers the cross-run case.

### US3: Terminal-collision rejections from the cloud surface as errors, not success

**As** the LLM driving `/cockpit:auto`,
**I want** `cockpit_gate_open` to return an error (with a class the auto loop can branch on) when the cloud drops the gate frame because a doc for that `gateId` already exists in a terminal state,
**So that** the auto loop does not tell me "gate is open, wait for the answer" for an inbox entry that will never exist.

**Acceptance Criteria**:
- [ ] When the cloud emits its `[relay] Ignoring gate-open for terminal gate <gateId>` rejection for a `gate-open` the cluster POSTed, the `cockpit_gate_open` tool call returns `status: 'error'` (not `status: 'ok'`) with a distinguishable error class (per FR-004).
- [ ] The tool's caller-facing status is never `'open'` or `'retained'` for a gate the cloud rejected — either it succeeded and the inbox row exists, or the tool returned an error the auto loop can handle.
- [ ] The error carries enough detail for the auto loop to distinguish "terminal collision — this gate was already answered in a prior run" from other cloud-side failure modes (transport error, malformed record, cloud 5xx). The auto loop's response strategy differs — a terminal collision means "generate a fresh run identity and retry"; a transport error means "back off and retry the same frame".

### US4: No silent stall — every un-openable gate produces an operator-visible signal

**As** an operator watching `/cockpit:auto`,
**I want** the run to either (a) succeed in opening a gate the inbox can display, (b) fall back to a local prompt I can answer in-terminal, or (c) escalate with a message that names the failure, on every gate the run reaches,
**So that** the run never sits in the "Open gate — needs your answer" state against an inbox that will never receive the gate.

**Acceptance Criteria**:
- [ ] When `cockpit_gate_open` returns the terminal-collision error class from US3, the auto loop's behaviour is one of: (a) mint a fresh run discriminator and retry (so US1 applies and the second open succeeds), (b) fall back to a local prompt for that gate, or (c) surface the failure to the operator with a message that identifies which gate could not be opened and why.
- [ ] No code path leaves the auto loop reporting "waiting for your answer" while the cloud has definitively rejected the gate.
- [ ] The four dropped `gate-outcome` acks observed in the field instance (same window, same collision class) receive the same treatment — a terminal-collision rejection on a `gate-outcome` (`cockpit_gate_ack`) also surfaces as an error, not silent success.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The `gateKey` derivation in `deriveGateKey` (currently `${issueRef}:${gateType}:${generation}` at `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts:67-73`) must incorporate an additional per-run discriminator such that two independent auto runs against the same `(issueRef, gateType, generation)` produce different `gateId`s. The discriminator must be constant across all `cockpit_gate_open` calls within a single run so within-run idempotency (US2) is preserved. | P1 | The natural candidate is the auto-run id already minted for the ledger (e.g. `christrudelpw-snappoll-1-20260727-200458`), or a cluster session id. Scope must be "run-lifetime, not process-lifetime, not epic-lifetime" — a run that respawns its MCP server midway must keep the same discriminator; a fresh run against the same epic must get a new one. Exact identity source is a clarification point (see Assumptions §1). |
| FR-002 | The wire contract change in FR-001 must be reflected in every co-signed contract mirror (cloud `gateOpenPayloadSchema`, `docs/cockpit-remote-gates-plan.md § Wire contracts`, `generacy-cloud/specs/843-part-cockpit-remote-gates/contracts/gates-wire.md`) so the cluster and cloud stay field-for-field compatible. The frozen `gateId` length (24 hex chars, sha256-prefix) stays the same; only the pre-image `gateKey` gains a component. | P1 | Cross-repo coordination. A cluster-only change that expands `gateKey` without updating the cloud's parser would produce cloud-side warn-drops rather than terminal-collision drops — a regression on top of a bug. |
| FR-003 | Retried `cockpit_gate_open` calls with the same semantic input within a single run must produce byte-identical `gateOpenWire` records (same `gateId`, same `gateKey`, same `askedAt` — the `askedAt` default of `new Date().toISOString()` at `cockpit_gate_open.ts:72` is the current within-run non-determinism; the fix must either (a) hoist `askedAt` above the retry boundary, or (b) accept that within-run duplicates differing only in `askedAt` still land on the same cloud doc via `gateId`-keyed dedup — both are acceptable and orthogonal to the collision fix, but the choice must be explicit). | P2 | Adjacent invariant. If the collision fix breaks within-run idempotency because `askedAt` changes per call, US2 fails via a different mechanism. |
| FR-004 | The cluster must detect the cloud's terminal-collision rejection and surface it as an error at the `cockpit_gate_open` call site. Because the cloud currently returns `202 Accepted` for a frame it will silently drop (see companion generacy-cloud bug referenced in the issue), the detection mechanism requires either (a) a cloud API change to signal terminal collision synchronously (preferred; tracked by the companion issue), (b) an out-of-band cluster-side probe via `cockpit_gate_list` / `cockpit_gate_status` after POST, or (c) a `cluster.cockpit`-channel relay event carrying the drop. This spec REQUIRES the outcome (error surfaces at the tool call site) and treats mechanism selection as a plan-phase decision. | P1 | US3. The current tool implementation at `cockpit_gate_open.ts:107-114` returns `status: 'ok', status: 'retained' | 'open'` on the strength of the orchestrator's `202` — this must not stay true for a frame the cloud dropped. |
| FR-005 | The tool's error return for terminal collision must be distinguishable from generic transport errors by class or code — e.g. a new `ToolResult` error class `'terminal-collision'` distinct from `'transport'` / `'invalid-args'` / `'internal'`, or a stable error code inside `detail`. | P1 | US3 AC-3. The auto loop's remediation for a terminal collision (mint a new run id and retry) is different from remediation for a transport error (back off and retry with the same frame). |
| FR-006 | The auto loop (`/cockpit:auto` skill) must handle the FR-005 terminal-collision error class without silently reporting "waiting for your answer". Acceptable handlers: (a) auto-generate a fresh run discriminator, retry once, and proceed; (b) fall back to a local prompt for that gate; (c) escalate to the operator with a message naming the gate. | P1 | US4. This is a skill-side change in a separate repo (`agency/packages/claude-plugin-cockpit`); this spec captures the requirement, the concrete handler shape is decided in that repo's plan. |
| FR-007 | The equivalent detect-and-surface treatment (FR-004 + FR-005) must extend to `cockpit_gate_ack` (`gate-outcome` frames). The four dropped `gate-outcome` acks observed in the field instance were dropped by the same `terminal gate` gate; the ack path must surface these too instead of returning success. | P1 | US4 AC-3. Currently `cockpit_gate_ack.ts` shares the same fire-and-forget shape as `cockpit_gate_open.ts` and would exhibit the same silent-drop pathology. |
| FR-008 | A regression test must cover the round-trip: open a gate → drive it to `applied` → re-open the same `(issueRef, gateType, generation)` in a distinct simulated run → assert the second open produces a distinct `gateId` visible in the inbox, and that a within-run retry of the second open produces the same `gateId` (idempotency preserved). | P1 | Acceptance criterion 5 from the issue. Sits either in `packages/generacy/src/cli/commands/cockpit/mcp/gates/__tests__/` (unit against `deriveGateKey`) or against the integration harness landed by #1024 (end-to-end via the fake relay peer) — likely both. |
| FR-009 | Zero change to the deterministic `sha256(gateKey).slice(0, 24)` derivation (`deriveGateId` at `schemas.ts:75-77`). The fix operates entirely on the `gateKey` pre-image; the hash function, prefix length, and encoding are stable. | P2 | Bounds blast radius. All existing gateId consumers (`GateOpenWireSchema.gateId.length(24)`, `cockpit_gate_ack`, cloud doc id, log lines) keep working as long as the output shape is unchanged. |
| FR-010 | Zero change to the 8-value `GateType` enum, the `GateOption` schema, the `GateOpenWireSchema` shape (beyond any additive field the run discriminator demands, if the plan chooses to expose it as a first-class wire field rather than fold it into `gateKey` composition), or the ack shape. | P2 | Compatibility. The remote-gates epic (#1020–#1024) has landed; a churn on the frozen contracts imposes cross-repo cost. Any additive field is a `minor` bump, no removed or renamed fields. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Re-run of an epic whose prior gates reached `applied` results in a fresh inbox-visible gate | 100% | Regression test (per FR-008): drive `phase-queue:P2` gate for `christrudelpw/snappoll#1` to `applied` in simulated Run A, re-enter the same phase in simulated Run B, assert the second `cockpit_gate_open` returns `status: 'ok'` with a NEW `gateId` and the mock relay sees exactly one `gate-open` frame with that new id. |
| SC-002 | Within-run duplicate inbox entries for the same natural gate | 0 | Test: two `cockpit_gate_open` calls for the same `(issueRef, gateType, generation)` inside the same simulated run produce identical `gateId`s and (per the fake-peer integration harness from #1024) exactly one `gate-open` frame arrives at the relay peer, not two. |
| SC-003 | `cockpit_gate_open` calls that return `status: 'ok'` and are subsequently dropped by the cloud terminal-collision path | 0 | Test: simulate the cloud dropping a `gate-open` (whichever mechanism the plan picks under FR-004); assert the tool returns `status: 'error'` with the FR-005 error class, and the `data.status` field is never `'open'` or `'retained'` on that call. |
| SC-004 | Auto-run stalls attributable to terminal-gate collisions after the fix ships | 0 | Observational: over the N `/cockpit:auto` runs following the fix, count runs whose logs show `[relay] Ignoring gate-open for terminal gate` matched to a run that reports "waiting for your answer" indefinitely. Target is zero — collisions may still occur transiently if the run discriminator changes mid-run for any reason, but no run should idle indefinitely. |
| SC-005 | Field-instance reproduction (issue #1053 evidence, `christrudelpw/snappoll#1` phase P2 P2 collision) reproducible after the fix | Not reproducible | Manual: re-run `/cockpit:auto --gates=ui christrudelpw/snappoll#1` post-fix against an epic previously driven to `applied` on phase P2; assert the P2 gate opens fresh in the inbox and the run proceeds past it. |
| SC-006 | Cross-repo wire contract drift | 0 | Static: after the fix, `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts`'s `deriveGateKey` output and `GateOpenWireSchema` shape match the cloud's `gateOpenPayloadSchema` and the doc mirror in `docs/cockpit-remote-gates-plan.md § Wire contracts` field-for-field. |
| SC-007 | Dropped `gate-outcome` acks surface as errors | 100% | Test: simulate the cloud dropping a `gate-outcome` frame for an already-terminal gate; assert `cockpit_gate_ack` returns `status: 'error'` with the FR-005 error class, matching the treatment of `cockpit_gate_open` in SC-003. |

## Assumptions

- **[NEEDS CLARIFICATION §1]** The concrete identity to use as the run discriminator in FR-001. Candidates: (a) the auto-run id already minted by `/cockpit:auto` for its ledger (`christrudelpw-snappoll-1-20260727-200458` shape — timestamp-suffixed, cluster-and-repo-scoped); (b) the cluster session id `INSTANCE_NONCE` already threaded through the MCP server (`packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts:72`, per #1015 planning notes); (c) a fresh discriminator minted by the tool itself and persisted for the run duration; (d) the `sessionId` already passed by the plugin to `cockpit_gate_open` (`GateOpenInputSchema.sessionId` at `schemas.ts:102`). Choice affects the wire-contract surface, whether the discriminator flows explicitly through the tool input or is derived from ambient state, and how takeover (#1015) interacts (a takeover MUST produce a fresh discriminator, otherwise US1's takeover trigger path fails).
- **[NEEDS CLARIFICATION §2]** The detection mechanism for terminal-collision under FR-004. The cloud currently returns `202 Accepted` and drops the frame later on the relay side — synchronous detection requires a cloud API change (companion issue referenced in #1053). Options: (a) block on companion; (b) cluster-side poll via `cockpit_gate_list` / `cockpit_gate_status` after POST until the status resolves or a timeout fires; (c) consume the cloud's drop-signal off `cluster.cockpit` if the companion adds one. The spec fixes the outcome (FR-004 + FR-005); the plan phase picks the mechanism.
- The `generation` field currently accepts `string | number` (`GateOpenInputSchema.generation` at `schemas.ts:90`) and is coerced to a string before hashing. The fix must not require callers to change what they pass as `generation` — the run discriminator lives alongside it inside `deriveGateKey`, not folded into it.
- The `gateType` enum values that reproducibly collide across runs today are `phase-queue` and `scope-drained` (both use stable per-epic discriminators). Other gate types with stable-across-runs discriminators — if any exist — inherit the fix by construction because it applies to every `deriveGateKey` call, not per-gateType.
- The `--gates=local` path is unaffected — it never emits `gate-open` frames to the cloud, so the collision path does not apply. The `--gates=ui` path is the sole reproducer.
- Companion generacy-cloud fix (visibility of dropped frames, referenced in the issue) is a sibling change tracked independently. This spec does not depend on it landing first for FR-001–FR-003 (the discriminator fix works whether or not the cloud API signals collision synchronously) but does depend on it (or an equivalent detection mechanism) for FR-004–FR-007.
- Skill-side handler wiring for FR-006 lives in `agency/packages/claude-plugin-cockpit/commands/auto.md` — a sibling repo. This spec captures the requirement; the concrete handler lands in a companion `agency` PR. The MCP-tool contract (FR-004 + FR-005) is the interface the two sides meet on.
- Within-run retries of `cockpit_gate_open` happen (a) via MCP client retry on transport error and (b) via auto-loop wake-tick re-emission when the retain queue drains after a relay reconnect. Both must produce the same `gateId` for US2 to hold; both invoke the same tool, so a run-scoped discriminator satisfies both by construction.
- #1015 (active-driver claim) and this spec compose cleanly: the claim's per-scope singleton means only one auto-run drives an epic at a time, so the run discriminator's lifetime maps one-to-one to the claim's holding session. A takeover (`--takeover`) mints a fresh session, therefore a fresh discriminator, therefore a fresh gate — which is US1's takeover trigger path.

## Out of Scope

- The companion generacy-cloud visibility fix (surfacing the drop back to the cluster / operator on the cloud side). Referenced by the issue; tracked as a separate cloud PR. This spec's FR-004 requires the cluster to surface the drop; whether the cloud API changes to signal it synchronously is a cloud-side decision.
- Changing the `deriveGateId` hash function, output length, or encoding (per FR-009). The 24-hex-char sha256 prefix stays; only the input string changes.
- Retroactive cleanup of the terminal doc that caused the field-instance collision (`075855bf0c3fef1b7f52ed3a`). The fix is forward-only — after it ships, that terminal doc becomes unreachable by construction (the new discriminator produces a different `gateId`), so no migration is needed.
- Retiring or repurposing the `sessionId` field on `GateOpenInputSchema`. If the plan chooses `sessionId` as the run discriminator (Assumptions §1 option d), that is an internal wiring change; if it picks a different discriminator, `sessionId` keeps its current role. Either way the field stays in the wire contract.
- Any change to the 8-value `GateType` enum, `GateOption` schema, gate-outcome shape, or the ack tool's outcome enum (per FR-010). The fix operates on identity derivation and error handling only.
- Cross-cluster gate coordination beyond the trigger paths already enumerated in US1. Under #1005 the serial-per-repo model guarantees no two clusters concurrently drive the same repo; this spec assumes that invariant and does not attempt to disambiguate concurrent runs across clusters.
- Auto-cleanup of terminal gate docs on the cloud side (TTL, garbage collection). If the collision volume becomes a cloud-side storage concern in the future, that is a separate design; this spec accepts that terminal docs accumulate one-per-run-per-natural-gate.
- Changes to `cockpit_gate_list` or `cockpit_gate_status` beyond what FR-004's mechanism selection may need. If the plan picks a poll-based detection mechanism, those tools may need minor extension — spec-out at plan time.
- Any change to `/cockpit:auto`'s ledger schema, wake-tick cadence, or claim behaviour (#1015). The run discriminator this spec introduces may share an identity with `/cockpit:auto`'s existing run id (Assumptions §1 option a), but the ledger and claim shapes are not modified.

---

*Generated by speckit*
