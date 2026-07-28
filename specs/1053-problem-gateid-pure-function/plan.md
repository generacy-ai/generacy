# Implementation Plan: Gate IDs must not collide across runs

**Feature**: Add a per-run discriminator to `gateKey` so a `/cockpit:auto` re-run against an epic whose previous gates reached a terminal cloud status opens a fresh inbox-visible gate; preserve within-run idempotency; surface terminal-collision cloud drops as errors (follow-up).
**Branch**: `1053-problem-gateid-pure-function`
**Status**: Complete
**Spec**: [`spec.md`](./spec.md) · **Clarifications**: [`clarifications.md`](./clarifications.md)
**Issue**: [generacy-ai/generacy#1053](https://github.com/generacy-ai/generacy/issues/1053)

## Summary

The bug (`spec.md` §Field instance): `gateKey = ${issueRef}:${gateType}:${generation}` has no run/cluster/attempt/time discriminator. Once a gate reaches a terminal cloud status (`applied` / `superseded` / `failed`), the exact `(issueRef, gateType, generation)` triple can never open a gate again — cloud drops the frame, orchestrator gets `202 Accepted` and reports success, the operator sees "Open gate — needs your answer" against an inbox showing `0`. Verified end-to-end on `christrudelpw/snappoll#1` phase `P2` on 2026-07-27: sha256 of the four-days-earlier terminal `gateKey` matched byte-for-byte (`075855bf0c3fef1b7f52ed3a`).

**Fix scope ships US1 + US2 only** in this PR (clarifications Q2 → A: FR-004 + FR-005 + FR-007 are a backstop for a case FR-001 eliminates, and they must not gate the primary fix on generacy-cloud#887's cross-repo landing). US3 + US4 land in a follow-up PR once #887's synchronous rejection reply exists. This PR closes the primary defect — terminal collisions stop occurring — and leaves error-shape wiring for the follow-up.

**Load-bearing architectural choices** (from clarifications):

- **Q1 → A** — the run discriminator is the **auto-run id already minted by `/cockpit:auto` for its ledger** (shape `christrudelpw-snappoll-1-20260727-200458` — cluster+repo+issue+timestamp), threaded through as an explicit optional field on `GateOpenInputSchema` and `GateAckInputSchema`. Survives MCP-server restarts within a run because the auto-loop re-passes the id on every wake tick; a takeover (`#1015 --takeover`) mints a fresh timestamp → fresh id → US1 takeover trigger path holds by construction. Non-auto callers get a per-process fallback minted from `INSTANCE_NONCE`, logged at `info` level with the source name — without an explicit fallback, manual `cockpit_gate_open` callers silently keep today's colliding behaviour and the bug survives on the manual-workaround path.
- **Q2 → A (decoupled)** — FR-004 detection (terminal-collision cloud signal) is a backstop for a case FR-001 eliminates. Once the discriminator lands, terminal collisions stop occurring. FR-004 ships as a follow-up gated on **generacy-ai/generacy-cloud#887**. This PR ships FR-001 + FR-002 + FR-003 + FR-008 + FR-009 + FR-010 independently.
- **Q3 → A** — the discriminator folds into the `gateKey` pre-image string only. New shape `${issueRef}:${gateType}:${generation}:${runId}`. **Zero cloud-schema change** — the cloud hashes a longer opaque string, produces a different `gateId`, treats the frame as fresh. This is exactly what makes Q2's decoupling achievable: no cross-repo schema coordination needed to ship FR-001. Discriminator is recoverable (not indexed) from stored `gateKey` for debugging.
- **Q4 → A** — `askedAt` hoists above the retry boundary. Compute once per natural gate (cache keyed by `gateId`, scoped to the tool-server lifetime), reuse on every retry. US2 correctness must not depend on cloud `gateId`-keyed dedup (which under FR-004 is *the bug source*). Two retried frames become byte-identical, so exactly one inbox row appears even if cloud dedup were entirely broken. Cloud dedup remains a backstop we do not rely on.
- **Q5 → A** — new top-level `ErrorClass` value `'terminal-collision'` on the existing `ToolResult` discriminator (same shape as `'claim-conflict'` from #1015). Ships in the FR-004/FR-005/FR-007 follow-up PR, not this one.

**Fix shape** — six discrete edits across two packages:

1. `packages/cockpit/src/gates/schema.ts` — `deriveGateKey` gains a fourth optional parameter `runId?: string`. When present, appended as `:${runId}` to the pre-image; when absent, no change (existing behaviour preserved for `null`-runId callers). Zero change to `deriveGateId`. Type surface change is additive.
2. `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts` — mirror the `deriveGateKey` signature change (this file duplicates the derivation for MCP-boundary insulation per its own docstring). Add `runId?: z.string().min(1).optional()` to `GateOpenInputSchema` and `GateAckInputSchema` (both `.strict()`, so the schema won't reject the new field). `GateOpenWireSchema` and `GateOutcomeWireSchema` **unchanged** (Q3 → A: no wire field).
3. `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.ts` — pass `s.runId` through to `deriveGateKey`. On the missing-runId path, mint a fallback from the module-level `INSTANCE_NONCE` (imported from `../event-bus.js`), log at `info` with the source name (`explicit` vs `fallback-instance-nonce`), and pass it. Hoist `askedAt` above the retry boundary via a per-process `Map<gateId, isoString>` cache keyed by the DERIVED `gateId` so retries produce byte-identical frames.
4. `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_ack.ts` — accept and ignore `runId` at the input schema level (the ack path targets an existing `gateId`, so no derivation happens here). Schema is `.strict()`, so leaving `runId` off would reject callers that pass it; adding it as optional is the low-friction change.
5. `packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts` — the re-export block already forwards `GateOpenInputSchema`/`GateAckInputSchema`; no code change needed but the type surface widens.
6. `.changeset/1053-run-scoped-gate-key.md` — `@generacy-ai/cockpit` **minor** (new capability: `deriveGateKey` accepts `runId`) + `@generacy-ai/generacy` **minor** (new tool input field). Per CLAUDE.md gate.

**Design invariants** (upheld across US1/US2):

1. **Zero change to `deriveGateId`.** Hash function, output length, encoding, and 24-hex prefix all stable (FR-009). All existing gateId consumers (`GateOpenWireSchema.gateId.length(24)`, cloud doc id, log lines) keep working because the output shape is unchanged.
2. **Zero change to `GateOpenWireSchema` / `GateOutcomeWireSchema` field lists** (FR-010, Q3 → A). No `runId` field on the wire. Cloud sees only a hash it doesn't recognize → treats as fresh gate.
3. **Zero change to the 8-value `GateType` enum, `GateOption` schema, gate-outcome shape.** Bounds blast radius; keeps the frozen cross-repo contract intact.
4. **Within-run frames are byte-identical after `askedAt` hoist** (Q4 → A). US2 correctness does not depend on cloud dedup.
5. **Fallback for missing `runId` matches ambient state**, not a per-call random. `INSTANCE_NONCE` (from `event-bus.ts:72`) is stable for the MCP-server process lifetime — long enough that `cockpit_gate_open` retries from the SAME manual call site get the SAME fallback and thus the SAME `gateId`. Different manual calls in different MCP-server instances get different fallbacks (each their own `INSTANCE_NONCE`), which is the correct behaviour: they ARE different runs from the tool's perspective. Documented `info` log line makes the source-selection observable.
6. **`sessionId` field on `GateOpenInputSchema` unchanged.** Q1 rejected D (conflating `sessionId` with the run discriminator) explicitly. `sessionId` keeps its current role as the conversation/session identifier.

## Technical Context

**Language/Version**: TypeScript, Node.js ≥22 (matches `packages/generacy/package.json`, `packages/cockpit/package.json`).

**Primary Dependencies**:
- `zod` — already a direct dep of both `@generacy-ai/generacy` and `@generacy-ai/cockpit`; used to extend input schemas.
- `node:crypto` — built-in; unchanged (still `createHash('sha256')` in `deriveGateId`).
- `vitest` — test runner. Existing suites under `packages/cockpit/src/__tests__/gates-id.test.ts`, `packages/cockpit/src/gates/__tests__/schema.test.ts`, `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-ack.test.ts` extended for the new signature.

**Storage**: None new. Per-`gateId` `askedAt` cache is an in-memory `Map` on the tool module — process-lifetime scope, matching the run-lifetime semantics for auto-driven callers (auto-loop keeps the MCP server alive across wake ticks). Zero on-disk persistence — deliberately avoids the stale-key/TTL class of bug that #849/#1051 explicitly worked to eliminate.

**Testing**: `vitest`. New unit tests for the extended `deriveGateKey` signature + the `askedAt` hoist + the fallback-log behaviour. Integration coverage via the fake-relay harness landed by #1024 (see `packages/orchestrator/src/__tests__/cockpit-gates-integration.integration.test.ts` referenced in spec §Assumptions) for FR-008's round-trip regression.

**Target Platform**: CI runners (Linux, Node ≥22). No platform-specific code paths.

**Project Type**: Multi-package library fix. Touched packages:
- `packages/cockpit/src/gates/schema.ts` — signature extension to `deriveGateKey` (+ mirror update to the `gate-id.ts` re-export shim comment if needed).
- `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts` — mirror signature extension + input-schema field additions.
- `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.ts` — fallback minting + `askedAt` hoist + `runId` threading through the derivation call.
- `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_ack.ts` — accept-but-ignore `runId` on input.

**Performance Goals**: Zero measurable impact. `deriveGateKey` becomes a `${issueRef}:${gateType}:${generation}:${runId}` template literal (one extra string concat); `deriveGateId` unchanged (single sha256 hash). The `askedAt` cache adds one `Map` lookup + one `Map.set` per open call — sub-microsecond, no allocations on the hit path.

**Constraints**:
- No cross-repo schema coordination (Q3 → A). Cloud sees no schema change.
- No new persisted state (Q1 → A, rejecting option C). No disk file, no Redis key, no cross-run persistence surface.
- No change to `deriveGateId` output shape (FR-009).
- No change to any frozen wire field (FR-010).
- Test coverage MUST include the field-instance replay: `phase-queue:P2` for `christrudelpw/snappoll#1` before → distinct `gateId` after (SC-005).

**Scale/Scope**: ~120 LOC added across 4 files. Total additions: 1 new test file (or extensions to two existing), 4 modified source files, 1 changeset. **No user-facing surface change** — the fix is internal to the MCP-tool derivation path. `/cockpit:auto` skill-side wiring (FR-006) lands in a sibling `agency/packages/claude-plugin-cockpit` PR; this spec captures the requirement, that repo owns the concrete handler.

## Project Structure

```
packages/
  cockpit/
    src/gates/
      schema.ts                            # MODIFIED: deriveGateKey accepts optional runId parameter (single source)
      gate-id.ts                           # unchanged (back-compat re-export shim)
      index.ts                             # unchanged (already re-exports deriveGateKey/deriveGateId)
    src/__tests__/
      gates-id.test.ts                     # MODIFIED: add runId-appended derivation cases
    src/gates/__tests__/
      schema.test.ts                       # MODIFIED: add runId parameter unit cases
  generacy/
    src/cli/commands/cockpit/mcp/
      gates/schemas.ts                     # MODIFIED: mirror deriveGateKey signature + add runId? to input schemas
      tools/cockpit_gate_open.ts           # MODIFIED: mint fallback runId, hoist askedAt, thread runId to derivation
      tools/cockpit_gate_ack.ts            # MODIFIED: accept-and-ignore runId on input (schema.strict compat)
      schemas.ts                           # unchanged (already re-exports the internal schemas)
      __tests__/
        parity-gate-ack.test.ts            # MODIFIED: assert runId acceptance doesn't break existing ack contract
        cockpit-gate-open-runid.test.ts    # NEW: 4 scenarios — explicit runId, fallback, askedAt hoist, ack passthrough

specs/1053-problem-gateid-pure-function/
  plan.md                                  # this file
  research.md                              # NEW (this phase)
  data-model.md                            # NEW (this phase)
  contracts/
    gate-key-derivation.md                 # NEW (this phase): extended deriveGateKey signature contract
    mcp-tool-input.md                      # NEW (this phase): extended GateOpen/GateAck input schema contract
    terminal-collision-error.md            # NEW (this phase): FR-004/FR-005/FR-007 follow-up PR contract (informational)
  quickstart.md                            # NEW (this phase): reproduce + verify

.changeset/
  1053-run-scoped-gate-key.md              # NEW: minor for @generacy-ai/cockpit + @generacy-ai/generacy
```

## Constitution Check

*No `.specify/memory/constitution.md` exists (verified — `.specify/` only holds `templates/`). Standard project conventions apply:*

- ✅ **Changesets (CLAUDE.md gate)**: Non-test edits under `packages/cockpit/src/` and `packages/generacy/src/` trigger the gate. One changeset: `.changeset/1053-run-scoped-gate-key.md`. Bump level:
  - `@generacy-ai/cockpit` — **minor**. New public capability: `deriveGateKey` accepts an optional `runId` parameter (backwards-compatible; existing callers unaffected).
  - `@generacy-ai/generacy` — **minor**. New public MCP-tool input surface: `GateOpenInputSchema.runId` and `GateAckInputSchema.runId` — both optional, backwards-compatible.
- ✅ **Every touched non-test package listed**: `@generacy-ai/cockpit`, `@generacy-ai/generacy`. Single changeset lists both.
- ✅ **No new dependencies**: `zod`, `node:crypto` already present in both packages.
- ✅ **Never-merge-on-red**: unaffected (this is a defect fix landing under `workflow:speckit-bugfix`).
- ✅ **Cross-repo wire contract stability** (SC-006): `GateOpenWireSchema` field-set is unchanged. Cloud `gateOpenPayloadSchema` needs no update. The `gateKey` string content changes (one extra `:${runId}` suffix), but the field TYPE stays `z.string().min(1)`.
- ✅ **No new persisted state** (composes with #849 / #1051 invariant): the fallback-runId cache and the `askedAt` cache are both in-memory `Map`s, process-lifetime only.

## Deferred Clarifications — Plan-Phase Decisions

Five clarifications resolved in `clarifications.md` (Q1–Q5). Four implementer-selectable decisions recorded here:

### D-1: Where the fallback `runId` comes from when no `runId` is passed

**Choice**: **`INSTANCE_NONCE` from `event-bus.ts:72`** (16 hex chars, per-MCP-process, `crypto.randomBytes(8)`).

**Rationale**:
- Existing module-level constant, already used by the cursor-encoding path (see `encodeCursor` in `event-bus.ts:83-90`) and #1015's claim payload. Zero new persistence surface.
- Process-lifetime scope matches the intent: retries against the SAME MCP-server process from a non-auto caller get the SAME fallback and thus the SAME `gateId` → within-caller idempotency preserved. Different MCP-server instances (which are effectively different callers) get different fallbacks — the correct behaviour.
- Q1 rejected `INSTANCE_NONCE` as the *primary* discriminator specifically because process-lifetime ≠ run-lifetime for auto-driven runs (an MCP-server restart mid-run would break US2). That constraint does NOT apply to non-auto manual callers, where the "run" IS the single MCP invocation.

**Rejected alternative**: A per-call `crypto.randomUUID()`. Would break within-call idempotency for retries — the exact bug Q4-A hoists `askedAt` to prevent.

### D-2: Scope of the `askedAt` cache — `Map` vs. LRU vs. per-request

**Choice**: **Unbounded `Map<gateId, string>` module-level, process-lifetime.**

**Rationale**:
- The auto-loop drives one MCP-server per run. Number of natural gates per run is O(phases × gates-per-phase) ≈ tens to low hundreds. Memory pressure is negligible (~24 bytes per key + 24 bytes per ISO string = <10 KB).
- LRU eviction would reintroduce the exact bug Q4-A closes: if a retry arrives after eviction, the second frame gets a new `askedAt`, ceases to be byte-identical, and US2's within-run correctness stops being guaranteed by the tool. We would be back to "correctness depends on cloud dedup by `gateId`."
- Process-lifetime scope aligns with the fallback-runId scope from D-1 (both use `INSTANCE_NONCE` semantics implicitly).

**Rejected alternative**: LRU with 1000-entry cap. Bounded memory, but the eviction case reintroduces cloud-dedup dependency. Not worth the memory optimization for the size involved.

### D-3: `runId` field position on `GateOpenInputSchema` / `GateAckInputSchema`

**Choice**: **Optional field on both schemas**, `runId: z.string().min(1).optional()`.

**Rationale**:
- `GateOpenInputSchema` and `GateAckInputSchema` both use `.strict()` (see `schemas.ts:106` and `:151`). Callers that pass a `runId` today would get `invalid-args` at the boundary. Adding the field as optional makes the schema forward-compatible with the auto-loop's new caller shape without breaking existing callers that omit it.
- The `GateAckInputSchema` addition is defensive: the ack path does not derive a `gateKey` (it targets an existing `gateId`), but the auto-loop passes the same envelope shape to both tools and would trigger `.strict()` rejection if `runId` weren't allowed. Accept-and-ignore is the minimal change.
- Optional-only: no `.default(...)` — the tool's fallback logic runs when `runId === undefined`, not when Zod pre-fills it, keeping the source-of-fallback observable in `cockpit_gate_open.ts` rather than in the schema layer.

**Rejected alternative**: Add `runId` only to `GateOpenInputSchema`. Would break the auto-loop skill's envelope shape on `cockpit_gate_ack` invocations. Cost of the extra field on the ack input is one line; benefit is envelope symmetry.

### D-4: Test-suite placement — pure unit vs. integration harness

**Choice**: **Both.** Unit tests at `packages/cockpit/src/__tests__/gates-id.test.ts` (pure `deriveGateKey`/`deriveGateId` cases) + a new tool-level unit at `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/cockpit-gate-open-runid.test.ts` (askedAt hoist, fallback logging, ack passthrough). **The end-to-end FR-008 assertion (open → apply → re-open, distinct `gateId` in inbox) rides on the fake-relay integration harness landed by #1024** — this spec extends that suite rather than re-building it.

**Rationale**:
- SC-001 requires an inbox-visible gate on the second open — only reachable end-to-end via the fake peer.
- SC-002 requires exactly one frame at the relay for two same-run opens — only meaningful with the peer counting frames.
- Pure-function unit tests catch the derivation bug per-commit (fast feedback); integration catches the wire contract regression.

**Rejected alternative**: Unit-only. Would satisfy SC-001/SC-002 arithmetically (via `deriveGateKey` output assertion) but not observationally (no proof the resulting frame reaches the peer with the expected `gateId`).

## Success Metrics — How the Plan Maps to `spec.md` §Success Criteria

| SC | Metric | How the plan satisfies it |
|----|--------|---------------------------|
| SC-001 | Re-run of an epic whose prior gates reached `applied` results in a fresh inbox-visible gate — 100% | `deriveGateKey` includes `runId`. `#1024` harness: drive `phase-queue:P2` for `christrudelpw/snappoll#1` to `applied` in Run A with `runId="RA"`; re-enter in Run B with `runId="RB"`; assert `deriveGateId(gateKey_B) !== deriveGateId(gateKey_A)` and the peer sees a new `gate-open` frame. |
| SC-002 | Within-run duplicate inbox entries for the same natural gate — 0 | Two `cockpit_gate_open` calls in the same simulated run with the SAME `runId` produce identical `gateId`s AND byte-identical `askedAt` (per D-2's cache), so exactly one frame arrives at the peer. Test: `cockpit-gate-open-runid.test.ts` scenario 2 (askedAt hoist). |
| SC-003 | `cockpit_gate_open` returns `status: 'ok'` and is subsequently dropped by cloud terminal-collision — 0 | **Follow-up PR** (FR-004/FR-005/FR-007) gated on generacy-cloud#887. Not scored by this PR. |
| SC-004 | Auto-run stalls attributable to terminal-gate collisions after fix — 0 | Observational; measured post-ship over N `/cockpit:auto` runs. The primary defect (identical `gateId` on re-run) is eliminated by construction — a fresh `runId` produces a fresh `gateId`. |
| SC-005 | Field-instance reproduction (`christrudelpw/snappoll#1` P2 collision) not reproducible after fix | Manual: re-run `/cockpit:auto --gates=ui christrudelpw/snappoll#1` post-fix; new `runId` on the fresh timestamp → new `gateId` → fresh inbox row. See `quickstart.md`. |
| SC-006 | Cross-repo wire contract drift — 0 | `GateOpenWireSchema` field-set unchanged (Q3 → A). `deriveGateKey` output type unchanged (`string`). Cloud parser continues to accept the frame. Only the `gateKey` string content is longer. |
| SC-007 | Dropped `gate-outcome` acks surface as errors — 100% | **Follow-up PR** (FR-007). Not scored by this PR. |

## Testing Strategy

Three layers:

1. **Pure-derivation unit tests** (extend `packages/cockpit/src/__tests__/gates-id.test.ts`) — 4 cases:
   - `deriveGateKey(ref, type, gen)` (no `runId`) — unchanged output; back-compat assertion.
   - `deriveGateKey(ref, type, gen, "RA")` and `(..., "RB")` — different pre-images.
   - `deriveGateId(deriveGateKey(ref, type, gen, "RA"))` — 24-char hex, matches spec's field-instance derivation with the appended runId.
   - The #1053 field-instance replay: `christrudelpw/snappoll#1:phase-queue:P2` (no runId) still hashes to `075855bf0c3fef1b7f52ed3a`; the runId-suffixed variant does NOT (regression guard against reverting the fix).

2. **Tool-level unit tests** (new `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/cockpit-gate-open-runid.test.ts`) — 4 scenarios:
   - Explicit `runId` on input → `gateKey` in POSTed body contains the suffix.
   - No `runId` on input → tool mints fallback from `INSTANCE_NONCE`, logs `info` with `source: 'fallback-instance-nonce'`, and threads it through.
   - Two calls in a row with the same input → identical `askedAt` in both POSTed bodies (askedAt hoist).
   - `cockpit_gate_ack` with `runId` on input → tool accepts (no `.strict()` rejection), the ack POST body is unchanged (runId is not on the wire ack).

3. **End-to-end integration** (extend `packages/orchestrator/src/__tests__/cockpit-gates-integration.integration.test.ts` from #1024) — 1 new scenario:
   - Drive `phase-queue:P2` for `christrudelpw/snappoll#1` to `applied` via the fake peer with `runId="RA"`. Re-emit with `runId="RB"`. Assert the peer sees TWO distinct `gate-open` frames with different `gateId`s, both marked `open` at the peer's view of the inbox. FR-008 acceptance test.

Test-only additions do not trigger the changeset gate (per CLAUDE.md exemption), but non-test source edits do (see Constitution Check).

## Sequencing

- **T-1** (independent) — Extend `deriveGateKey` in `packages/cockpit/src/gates/schema.ts`. Extend `packages/cockpit/src/__tests__/gates-id.test.ts` (pure-derivation tests, layer 1).
- **T-2** (depends on T-1) — Mirror the signature in `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts`. Add `runId?` to `GateOpenInputSchema` + `GateAckInputSchema`. Extend `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-ack.test.ts` for the ack passthrough case.
- **T-3** (depends on T-2) — Modify `cockpit_gate_open.ts`: mint fallback `runId`, hoist `askedAt` above the retry boundary, thread `runId` into `deriveGateKey`. Add `cockpit-gate-open-runid.test.ts` (layer 2).
- **T-4** (depends on T-2, parallel with T-3) — Modify `cockpit_gate_ack.ts`: accept-and-ignore `runId` on input.
- **T-5** (depends on T-3 + T-4) — Extend `#1024` integration harness with the round-trip `phase-queue:P2` re-emission scenario (layer 3, FR-008).
- **T-6** — Write `.changeset/1053-run-scoped-gate-key.md`.

T-3 and T-4 are parallel-safe (touch disjoint files). T-5 and T-6 wait on both.

## Out of Scope for This PR

*(Restated from `spec.md` §Out of Scope + Q2-A decoupling:)*

- **FR-004 / FR-005 / FR-007 — terminal-collision detection and error surfacing.** Gated on **generacy-cloud#887**. Follow-up PR under `workflow:speckit-bugfix`; will add the `'terminal-collision'` `ErrorClass` value and the cluster-side detection wiring. Contract shape captured in `contracts/terminal-collision-error.md` for coordination.
- **FR-006 — `/cockpit:auto` skill-side handler for the error class.** Lives in `agency/packages/claude-plugin-cockpit/commands/auto.md`. Sibling repo. Ships when the FR-004/005/007 follow-up ships.
- Retroactive cleanup of the terminal doc that caused the field instance (`075855bf0c3fef1b7f52ed3a`). Forward-only fix; the doc becomes structurally unreachable.
- Any change to `deriveGateId`'s hash function, output length, or encoding (FR-009).
- Any change to `GateType` enum, `GateOption` schema, gate-outcome enum, or wire field lists beyond the additive input-schema `runId?` (FR-010).
- Cross-cluster gate coordination beyond what #1005's serial-per-repo model already guarantees.
- Cloud-side TTL / GC for accumulated terminal gate docs — that becomes a cloud storage design question if volume rises; this fix accepts one-terminal-doc-per-run-per-natural-gate.
- Changes to `cockpit_gate_list` / `cockpit_gate_status` — Q2 → A chose the synchronous rejection mechanism, not poll-based detection, so no read-side extension is needed.
