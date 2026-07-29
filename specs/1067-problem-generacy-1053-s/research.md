# Research: `runId` on gate-query MCP tools (Phase B of #1053 fix)

**Issue**: [#1067](https://github.com/generacy-ai/generacy/issues/1067)
**Branch**: `1067-problem-generacy-1053-s`

Six decisions taken during planning, each pinned to spec + clarifications.

---

## R1: Where in the URL builder does `runId` land?

**Decision**: In `cloud-gate-query-client.ts::buildUrl` — **no code change to `buildUrl` itself**. The existing loop at `cloud-gate-query-client.ts:206-208` already omits undefined values via `if (v !== undefined) base.searchParams.set(k, v)`. The `getGateStatus` implementation at `:342-350` simply adds `runId: input.runId` to the query object; when the caller omits `runId`, the loop skips it and the URL is byte-identical to today.

**Rationale**: Minimum diff surface area. FR-005 byte-compat is preserved trivially by the existing skip; no need to touch the URL builder. `buildUrl` is one of the code paths most likely to hide encoding bugs (`#` → `%23`, order drift); touching it for a no-op edit invites collateral risk.

**Alternatives considered**:
- **Threading `runId` as a first-class positional argument to `buildUrl`**: rejected — the current shape passes an arbitrary `Record<string, string | undefined>`, which is exactly the extension seam we want.
- **Building the URL manually with string concatenation**: rejected — loses `URLSearchParams` encoding of `owner/repo#N` → `owner/repo%23N`, which is the failure class Q5=C's snapshot fixture exists to catch.

---

## R2: Where does the parity regression live (which package)?

**Decision**: New file `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-tuple-identity.test.ts` (in the same directory as the existing per-tool parity tests). Fake-cloud fixture (in-memory `Map<gateKey, gateId>`) satisfies FR-006's three-tool matrix.

**Rationale**: The identity contract spans three tools whose sources all live in `packages/generacy/src/cli/commands/cockpit/mcp/`. Putting the matrix test elsewhere would require cross-package imports of `deriveGateKey`/`deriveGateId` (which already re-export cleanly). Existing `parity-gate-open.test.ts` / `parity-gate-status.test.ts` / `parity-gate-list.test.ts` are per-tool schema audits; the new file is intentionally cross-tool.

**Alternatives considered**:
- **Extend `parity-gate-status.test.ts` in place**: rejected — that file audits schema flatness (SC-006); mixing schema audits with identity matrix would obscure both.
- **Put the matrix in `packages/orchestrator/src/routes/__tests__/`**: rejected — the orchestrator route is only one of the three tools' back-ends; the identity is asserted at the MCP boundary where the derived `gateKey`/`gateId` first come into contact with each other.

---

## R3: How is FR-005's "byte-identical" verified — snapshot or structural?

**Decision**: **Both**, per clarification Q5=C. A checked-in canonical URL string as a snapshot (`contracts/cloud-url.md` names the exact string; the test asserts equality) AND a structural assertion that the query-string key set is exactly `{issueRef, gateType, generation}` with `runId` absent.

**Rationale** (from clarifications Q5):
- **Snapshot alone**: opaque failure. A diff of two URL strings makes the reader spot the delta by hand. Also brittle to future legitimately-additive parameters.
- **Structural alone**: misses percent-encoding drift on `owner/repo#N` and query-parameter-order drift — both of which FR-005's "byte-identical" language captures literally. A refactor that swaps `URLSearchParams` for manual concatenation would pass a structural assertion and surface as a cloud-side 400 far from the change that caused it.

The marginal cost is a few lines and one checked-in string. Both catch different classes of drift.

---

## R4: Log-line placement — pre-call, post-call, or both?

**Decision**: **Post-call only** for `cockpit_gate_status`; **no log line** for `cockpit_gate_list`. Fields: `{ event, runIdSource, mode: 'status', gateType, issueRef, resolvedStatus, gateId }`. Log MUST be emitted on the failure path too, with the error surfaced.

**Rationale** (from clarifications Q3=C + Q3 rider):
- Pre-call minimal (`{event, runIdSource, mode, issueRef}`) records what we *intended* to send. The operator's actual question is *did my `runId` reach the right doc*, which needs the outcome.
- Post-call rich answers "what did the runId actually match" — the load-bearing observability.
- Emitting on failure too: post-call-on-success-only makes a failing `runId` cycle indistinguishable from a cycle where the tool was never invoked. That is the interesting class to observe.
- Exclusion of `cockpit_gate_list` (Q1=C consequent): the list handler never forwards `runId`, so emitting `runIdSource` there would announce a provenance for a value that had no effect on the request.

**Alternatives considered**:
- **Pre-call minimal (A)**: rejected — cannot observe the outcome. Diagnostically less useful for exactly the case FR-008 exists to observe.
- **Both pre- and post-call**: rejected — double log noise for a single boundary event. Post-call subsumes pre-call information (it carries `runIdSource`) and adds outcome.

---

## R5: Do we duplicate the cloud's `runId ⇒ generation` refine on the orchestrator route?

**Decision**: **No**. The orchestrator route's `GateQueryStringSchema` accepts `runId?` as a passive pass-through. The cloud route (`generacy-cloud`, PR #892, merge `192fca7c`) authoritatively enforces `.refine((q) => q.runId === undefined || q.generation !== undefined, {message: 'runId requires generation'})`.

**Rationale**: If the orchestrator route ALSO enforced the refine, a list request carrying `runId` would produce a route-side 400 with `code: 'VALIDATION'` — masking the cloud's more informative RFC-7807 400 response. The caller observes the wrong error class. Worse: if the cloud contract ever loosens (list mode accepts `runId` as filter — the deferred generacy-cloud follow-up in Q1=C), the orchestrator's stale refine would silently block that behaviour. The list handler in `cockpit_gate_list.ts` is the last stop where `runId` is intentionally dropped (before the client call); adding a second guard at the route layer just breeds two sources of truth.

**Alternatives considered**:
- **Refine at both boundaries**: rejected — introduces the coupled-fault class described above.
- **Refine only at the route**: rejected — the client should still be safe against direct-invocation misuse; the handler drop is the primary guard.

---

## R6: How is the SC-004 end-to-end pinned — real cloud, fake cloud, or unit-level composition?

**Decision**: **Fake cloud persisting by 4-tuple**, in `mcp/__tests__/gate-open-then-status-runid.integration.test.ts`. In-memory `Map<gateKeyPreImage, gateId>` — same pattern as existing `mcp/__tests__/*.integration.test.ts` families. No real network I/O.

**Rationale**:
- **Real cloud in CI**: rejected — introduces staging-env flakiness into every PR; the test would fail whenever `api-staging.generacy.ai` degrades independently of this code.
- **Unit-level composition** (mock `getGateStatus` inline): rejected — bypasses the URL construction seam that Q2 fixes the parameter name on (`runId`, camelCase). SC-003 (the URL carries `runId=<X>`) is already unit-tested in `cloud-gate-query-client.runid.test.ts`; the integration test needs to prove the full chain from MCP schema → query-client URL → route parse → cloud client URL → fake cloud response → decoded ThreeState.

The fake cloud is deliberately a `Map` keyed by pre-image, not by cloud's actual `gateKey` derivation, so we can also assert that different `runId`s produce different persisted rows — the load-bearing US3 acceptance.

---

## Prior-art references

- **#1053** (write-side): `deriveGateKey` / `deriveGateId` already accept the optional 4-tuple in `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts`. Read-side must match by construction.
- **#1055**: added `runId` to `cockpit_gate_open` + `cockpit_gate_ack` schemas.
- **#1059** (post-mortem — cross-repo issue): documented the exact silent-failure mode a mis-ordered A/B/C rollout produces. This spec's Assumption 1 codifies the ordering guard.
- **generacy-cloud#892** (Phase A): cloud accepts `runId` on write + read (status mode). Merge `192fca7c`. Deployed `2026-07-29T04:07:07Z`.
- **`cockpit_gate_open.ts:80-97`**: pattern for the `runIdSource` log line — mirrored here with post-call placement and additional outcome fields.

---

## Open questions

None. All five clarification questions were answered on 2026-07-29 in batch 1 (see `clarifications.md`).

---

*Generated by /speckit:plan on 2026-07-29.*
