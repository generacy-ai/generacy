# Research: Cockpit MCP — `cockpit_gate_open` + `cockpit_gate_ack`

Feature: [#1022](https://github.com/generacy-ai/generacy/issues/1022)
Branch: `1022-part-cockpit-remote-gates`

This document records the technology and pattern decisions that back the plan.
Every decision has a **choice**, **rationale**, and **alternatives considered**
section. Cross-reference to spec clarifications in `clarifications.md` is called
out where relevant.

---

## R1: HTTP client library

**Choice**: Node ≥22 built-in `fetch` (undici under the hood), with `AbortController` for the 5s timeout.

**Rationale**:
- `packages/generacy/package.json` already pins `>=22`, so `fetch` is universally available.
- Two nearest in-cluster HTTP callers already use `fetch`:
  - `packages/control-plane/src/services/worker-scaler.ts:345+` — POST to orchestrator with API key.
  - `packages/orchestrator/src/routes/internal-relay-events.ts` — POST from control-plane over TCP loopback.
- Zero dependencies. `AbortController` is standard.
- `fetch` returns a `Response` with a stable `.status` and `.text()`/`.json()` — trivial to switch on the four HTTP status ranges the tool cares about.

**Alternatives considered**:
- `node:http` low-level (pattern used by `packages/activation-client` and `packages/credhelper-daemon`): rejected — those packages predate broad Node 22 availability. Requires manual body-buffering, manual timeout via `req.setTimeout()`, more test boilerplate.
- `undici.Client` (direct): rejected — same benefits as `fetch`, but adds an explicit import and dispatcher lifecycle we'd have to manage. `fetch` already uses it under the hood.
- `got` / `axios`: rejected — adds runtime deps for zero win. This package already avoids ad-hoc HTTP libs.

---

## R2: Base-URL discovery (spec Q2 → C)

**Choice**: `options.orchestratorUrl ?? process.env['ORCHESTRATOR_URL'] ?? 'http://127.0.0.1:3100'`.

**Rationale**:
- Verbatim shape of `worker-scaler.ts:345-346`, which spec FR-006 explicitly cites as the "existing in-cluster caller" pattern to match.
- Options-bag branch lets tests inject without shimming `process.env` (a persistent source of flake in the parity-\*.test.ts suites).
- Env-var branch preserves operator override without a rebuild.
- Loopback default matches the orchestrator's default listen address (`packages/orchestrator/src/server.ts` binds `127.0.0.1:3100` by default).

**Alternatives considered**:
- Options-bag only (no env fallback): rejected — breaks the parity-with-existing-callers requirement and forces cluster operators to rebuild to change the URL.
- Env-var only (no options-bag): rejected — forces tests to shim `process.env`, and the `worker-scaler.ts` precedent already established the options-bag override pattern.
- Read the orchestrator URL from `cluster.json` / activation state: rejected — that URL is the *cloud* URL, not the local orchestrator URL. Different concern.

---

## R3: Request timeout (spec Q5 → C)

**Choice**: 5s default, overridable via options-bag `orchestratorTimeoutMs`, no env var.

**Rationale**:
- Options-bag shares the same injection seam as R2 — one `BuildMcpServerDeps` extension, not two.
- 5s matches Fastify's default socket keepalive and Assumption #6 in the spec.
- No env var per Q5 rationale: the operational knob (`--gates=local`) already exists at the skill layer; a per-deployment timeout tunable would be operational overreach with no evidence of need.
- `AbortController` + `setTimeout` is the canonical pattern for `fetch`.

**Alternatives considered**:
- Hardcode 5s (Q5 → A): rejected — forces tests to wait 5s for the timeout branch or use fake timers, both of which are worse than a `timeoutMs: 5` injection.
- Env var `COCKPIT_GATE_TIMEOUT_MS` (Q5 → B): rejected per Q5 rationale — operability gain is theoretical, and the injection surface already covers the test seam.

---

## R4: Error-class mapping (spec Q1 → A, Q4 → B)

**Choice**:

| Scenario                                    | HTTP status | `ErrorClass`     |
|---------------------------------------------|-------------|------------------|
| 2xx                                         | 200–299     | (ok — no error)  |
| 400 Bad Request                             | 400         | `invalid-args`   |
| 404 Not Found (on `/cockpit/gates/:id/ack`) | 404         | `unknown-gate`   |
| 409 Conflict (idempotent-conflict variant)  | 409         | `invalid-args`   |
| Other 4xx                                   | 401–499     | `internal`       |
| 5xx Server Error                            | 500–599     | `transport`      |
| Network error / DNS / ECONNREFUSED / abort  | —           | `transport`      |
| Cluster-not-cloud-activated (any signal)    | —           | `transport`      |

**Rationale**:
- Aligns with the `toMcpResult` table already established in `errors.ts:96-193` (#928, spec's cited "Q4 → B" precedent).
- `transport` collapse for cloud-unavailability (Q1 → A) matches the CockpitExit code-1 → transport convention already used by every other cockpit MCP tool. `/cockpit:auto`'s local fallback pattern-matches on that one class.
- Preserves the bug (400) vs semantic (404) vs conflict (409) distinctions the codebase already commits to.
- `unknown-gate` already exists in the `ErrorClass` union (`errors.ts:18`) and semantically fits the 404-on-ack case (the caller ack'd a gate id the orchestrator doesn't know).

**Alternatives considered**:
- Collapse all 4xx to `invalid-args` (Q4 → A): rejected — loses semantic distinction the codebase already tracks.
- Collapse all 4xx to `internal` (Q4 → C): rejected — 400 is caller-fixable ("your record was wrong"), not internal.
- Add `cloud-inactive` class (Q1 → B/C): rejected — no dispatch branch would exercise the distinction; `transport` collapse is what the skill actually consumes.

---

## R5: Test injection seam

**Choice**: Extend `BuildMcpServerDeps` with three optional fields:

```ts
export interface BuildMcpServerDeps {
  runner?: CommandRunner;
  orchestratorUrl?: string;
  orchestratorTimeoutMs?: number;
  fetchImpl?: typeof fetch;   // test-only; production passes undefined → global fetch
}
```

Tests construct `buildMcpServer({ orchestratorUrl: 'http://mock', fetchImpl: fakeFetch })` and pass the returned server through the MCP SDK's in-process transport (matches `parity-claim.test.ts` pattern).

**Rationale**:
- One options interface, one injection surface — matches the existing `runner?: CommandRunner` shape used by every other tool for GH-wrapper injection.
- `fetchImpl` typed as `typeof fetch` gives full request/response typing in tests with zero cast noise.
- No global monkey-patch (`global.fetch = mock`) — every parity test can run in parallel without cross-contamination.

**Alternatives considered**:
- Global `vi.stubGlobal('fetch', fakeFetch)`: rejected — cross-test coupling risk; sibling parity tests already inject via `GhWrapper` for the same reason.
- `nock` / `msw`: rejected — new dep for a use case a 20-line fake fetch handles.
- Per-tool options-bag (separate `GateToolsDeps`): rejected per plan D-1 — no ergonomic way to thread per-call deps through `registerTool`'s closure.

---

## R6: MCP tool registration position

**Choice**: Register `cockpit_gate_open` and `cockpit_gate_ack` at the **end** of the `buildMcpServer` call chain in `server.ts` (after `cockpit_await_events`), grouped with an explanatory header comment documenting the Q3 → A exception to design invariant #1.

**Rationale**:
- Preserves stable registration order for the existing 12 tools — no diff churn in `tool-schema-audit.test.ts` for those.
- Header comment lives at the source of the exception, so future readers see the "why no CLI verb" note without hunting through docs.
- Alphabetical order is not enforced by any test; the existing order is grouped-by-topic (status/context → mutation → scope → claim/release → await-events), and gates naturally slot at the end alongside other cross-cutting tools.

**Alternatives considered**:
- Alphabetical: rejected — would shuffle existing registrations for zero test-detectable win.
- New sub-`registerGateTools(server, deps)` helper: rejected as premature — two tools do not justify an indirection layer.

---

## R7: Contract source-of-truth

**Choice**: The gate-record schema, ack payload shape, `gateId`/`generation` semantics, and NDJSON answer line format are **imported as-is from the epic**. The referenced authoritative doc is [`cockpit-remote-gates-plan.md`](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md) (spec § Summary).

**Rationale**:
- The epic explicitly says: "Implement against the contracts as written; propose contract changes on the epic before diverging." (spec § Summary).
- `contracts/cockpit_gate_open.md` and `contracts/cockpit_gate_ack.md` in this feature dir are **derived views** that document how *this MCP boundary* consumes those contracts (input validation, error mapping, response passthrough) — they do not define the wire shape.
- Local schemas in `gates/schemas.ts` MUST mirror the epic contracts as a shape check; any divergence is a bug caught by the orchestrator's own validation (which will 400).

**Alternatives considered**:
- Redefine the wire contracts in this feature branch: rejected — direct violation of spec § Context.
- Import the schema module from the orchestrator package to eliminate drift: **noted as follow-up** if a shared `@generacy-ai/gate-contracts` package materializes from the epic. For now, mirror the schema locally with a comment pointing at the epic doc.

---

## R8: No CLI verb (spec Q3 → A)

**Choice**: The two tools are MCP-only. No `generacy cockpit gate-open` / `gate-ack` subcommand is added.

**Rationale**:
- Documented exception to design invariant #1 (`server.ts` — "each MCP tool wraps a CLI verb"). The invariant exists to give operators a keyboard-friendly path for tools that are useful standalone; these two are only useful from within a driving `/cockpit:auto` session and would leak raw HTTP-client behavior if exposed.
- Zero-user-visible-benefit branches are exactly what invariants like this are meant to prevent from bloating the CLI.
- Mocked-orchestrator unit tests cover the same code paths a CLI would exercise.

**Alternatives considered**:
- Public CLI verbs (Q3 → B): rejected — operator hand-types a full gate record; unusable in practice.
- Hidden/`--internal` verbs (Q3 → C): rejected — redundant with the vitest coverage; hidden CLI surface still needs help text, tests, and lifecycle. Adds cost, gives no value.

---

## R9: Idempotency

**Choice**: The tools themselves are **not idempotent**; idempotency is the orchestrator's contract.

**Rationale**:
- `cockpit_gate_open` returns a new `gateId` per call by design (the epic contract owns the `gateId`/`generation` rules).
- `cockpit_gate_ack` posts an outcome; replaying the same `(gateId, outcome, detail)` is safe iff the orchestrator's ack route is idempotent. That guarantee lives on the orchestrator route issue, not here.
- The MCP tool does not retry on transport failure — the skill decides whether to retry via `AskUserQuestion` fallback (Q1 → A).

**Alternatives considered**:
- Add per-tool retry with backoff: rejected — would compound with the 5s timeout budget and obscure the transport-failure signal the skill relies on.
- Add local caching of the last ack response: rejected — no request-de-dup value; the orchestrator sees each POST regardless.

---

## Key sources / references

- Spec: `spec.md` (this feature).
- Clarifications: `clarifications.md` — Batch 1, five decisions.
- Sibling implementation (idempotent-tool pattern, options-bag injection): `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_claim.ts`, `.../cockpit_release.ts` — landed in #1015.
- Error envelope helper: `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts:96-193` — `toMcpResult` table (from #928).
- In-cluster HTTP caller precedent: `packages/control-plane/src/services/worker-scaler.ts:345-346`.
- Cited epic doc (authoritative wire contract, external): `https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md`.
