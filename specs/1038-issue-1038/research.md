# Research: Cockpit gates — read-only status query + stable sweep generation derivation

Feature: [#1038](https://github.com/generacy-ai/generacy/issues/1038)
Branch: `1038-issue-1038`

This document records the technology and pattern decisions that back the plan.
Every decision has a **choice**, **rationale**, and **alternatives considered**
section. Cross-references to spec clarifications and to sibling P1 issues
(#1020, #1021, #1022, #1024) are called out where relevant.

---

## R1: Transport for the cluster → cloud gate-status query

**Choice**: Direct HTTPS from the orchestrator to `GENERACY_API_URL` (path `GET /api/clusters/:clusterId/cockpit/gates`), authenticated with the cluster API key at `/var/lib/generacy/cluster-api-key` (`Authorization: Bearer <key>`). Wraps `node:https.request` with an `AbortController` for the 5s per-attempt timeout.

**Rationale**:
- Two sibling cluster→cloud HTTPS clients already exist with the same auth story:
  - `packages/control-plane/src/services/cloud-pull-client.ts` (#766) — `POST /api/clusters/:id/credentials/:credId/pull` for JIT git tokens.
  - `packages/activation-client/src/client.ts` (#500) — `POST /api/clusters/device-code` for activation.
- HTTPS is available whenever the cluster API key file exists, which is precisely the invariant every post-activation cluster satisfies. It does **not** depend on relay connectivity — the exact race the query needs to survive.
- `node:https` is a Node built-in; no dep. Auth is a single `Authorization` header. Body parsing is a single `res.on('data')` → `JSON.parse`. All previously debugged in the two sibling clients.

**Alternatives considered**:
- **New relay message pair (`gate_query_request` / `gate_query_response`)**: rejected — doubles the correlation-id state machine (cloud must dispatch the request against its own routes; existing `ApiRequestMessage` is cloud → cluster only). No advantage over HTTPS given the relay already runs over TLS.
- **`fetch` on the orchestrator side**: rejected — the orchestrator already uses `node:http` / `node:https` for internal calls (health probes, control-plane socket calls); staying consistent within the orchestrator package is simpler than mixing patterns. The MCP tool side uses `fetch` (see R3) because that side already established the pattern in #1022.
- **Route via the control-plane** (`packages/control-plane/src/services/`): rejected — control-plane owns cluster-internal state (credentials, code-server, tunnel). Gate queries are read-only orchestrator concerns; the write path already lives in `packages/orchestrator/src/routes/cockpit-gates.ts`. Splitting sides would obscure the epic's per-package ownership.

---

## R2: Retry policy — where it lives and what schedule

**Choice**: Retry lives **inside the MCP tool handler** (`tools/cockpit_gate_status.ts`, `tools/cockpit_gate_list.ts`) via a shared `gates/retry.ts` helper. Schedule: **3 attempts total** (initial + 2 retries) at `0ms → 1500ms → 3500ms`. Total wall-clock budget ≤5s per Q3 → D. On exhaustion, emit `{ status: 'error', class: 'query-unreachable', detail: <last-error-message>, hint?: '...' }`.

**Rationale**:
- Q3 → D fixes both parameters: ~3 attempts, ~5s budget. `0/1500/3500` fits neatly (max total 5000ms) and puts the initial attempt at zero cost.
- Placing the retry in the tool handler (not the shared HTTP client) mirrors the "HTTP client speaks HTTP + status codes; tool handler owns policy" split explicitly documented in `mcp/gates/client.ts` header (from #1022). The existing write-path client is single-call by design; the query tools need retry; the tools own it.
- Retry triggers on: `transport`-class errors from the HTTP client, HTTP 502/503/504, and network errors (ECONNREFUSED, ENOTFOUND, EPIPE, timeout). Does NOT trigger on: 4xx (caller bug — surface immediately), 200-with-malformed-body (orchestrator bug — surface immediately). This distinction preserves the fail-fast on real bugs while riding out transient races.
- A shared `retry.ts` helper is a plain async function `withRetry(fn, { schedule, shouldRetry })`. Pure; unit-testable with fake timers.

**Alternatives considered**:
- **Retry inside `query-client.ts`**: rejected — the client's single-call contract is what makes it testable in isolation. Mixing retry policy into the transport layer leaks concerns.
- **Retry inside `cloud-gate-query-client.ts` (orchestrator side)**: rejected — the tool boundary is where MCP callers see the error class; retrying below that boundary would still bubble the class change up, so it's redundant. The MCP-side retry also survives orchestrator-side transport failure modes (e.g., orchestrator restart), which an orchestrator-side retry would not.
- **Exponential backoff to a 10s budget**: rejected — spec Q3 → D says ~5s. Longer holds up the sweep for no coverage of the identified startup race.
- **Single attempt (Q3 → A directly)**: rejected — Q3 → D was chosen because startup is exactly when the relay/cloud might be transiently unreachable; single attempt would incorrectly abort on those cases.

---

## R3: HTTP client library (MCP-side)

**Choice**: Node ≥22 built-in `fetch` (undici under the hood) with `AbortController` for the per-attempt timeout. Same as sibling #1022's write-path client.

**Rationale**:
- Consistency with `mcp/gates/client.ts` — same package, same `BuildMcpServerDeps` (`fetchImpl`) injection seam, same 5s default.
- Zero dependencies; `AbortController` is standard.
- `fetch` returns a stable `Response` with `.status` and `.text()` / `.json()` — trivial to dispatch on the four HTTP status ranges the tool cares about.

**Alternatives considered**:
- **`node:https` directly**: rejected on the MCP side (used only on the orchestrator side per R1) — the MCP side already uses `fetch` for #1022; mixing would create two test injection patterns in one folder.
- **Reuse `mcp/gates/client.ts`**: rejected — observer independence (FR-012) requires the query path to be separately importable. Sharing the client would mean the static import-scan test cannot prove the query tools do not touch the write path.

---

## R4: Base-URL discovery (MCP-side)

**Choice**: Reuse the existing `BuildMcpServerDeps` fields from #1022: `options.orchestratorUrl ?? process.env['ORCHESTRATOR_URL'] ?? 'http://127.0.0.1:3100'`. No new options fields.

**Rationale**:
- The query tools are additional consumers of the same in-cluster orchestrator; the URL surface is identical.
- Extending the options bag with a `orchestratorQueryUrl` would fork the injection seam for no operational reason.
- The 5s default timeout (`orchestratorTimeoutMs`) already applies — one setting, both surfaces.

**Alternatives considered**:
- **New `orchestratorQueryUrl` field**: rejected — same URL in practice; splits config for no reason.
- **Read from `cluster.json`**: rejected — that's the *cloud* URL. The MCP tool needs the local orchestrator URL. Different concern.

---

## R5: Error-class mapping (MCP-side)

**Choice**:

| Scenario                                           | HTTP status | `ErrorClass`         |
|----------------------------------------------------|-------------|----------------------|
| 2xx success (`status: open \| answered \| absent`) | 200         | (ok — no error)      |
| 400 Bad Request (bad query params)                 | 400         | `invalid-args`       |
| 404 (path unmatched — orchestrator bug)            | 404         | `internal`           |
| Other 4xx (401/403/405/410/422/429)                | 401–499     | `internal`           |
| 5xx after 3 retries                                | 500–599     | `query-unreachable`  |
| Network / DNS / timeout after 3 retries            | —           | `query-unreachable`  |
| 2xx with non-JSON body                             | 200         | `internal`           |
| 2xx missing required fields                        | 200         | `internal`           |
| Cluster not cloud-activated (any signal)           | —           | `query-unreachable`  |

**Rationale**:
- Note the divergence from `mcp/gates/client.ts` (the write-path client): **5xx and network errors map to `query-unreachable` on this path, not `transport`**. That's the whole point of the new error class — read-fail must be distinct from write-fail so the sweep can dispatch differently (abort vs. `AskUserQuestion` fallback).
- 404 collapses to `internal` (not `unknown-gate` as on the write path) because the query does not accept a `gateId` in its path — a 404 here means the orchestrator route is not registered, which is a build/deploy bug, not a caller-visible condition.
- FR-013 says `absent` is NOT an error — the orchestrator returns HTTP 200 with `{ status: 'absent', gateId: null }` and the tool passes that through as `ToolOkResult`. The absent-vs-error distinction is preserved at the HTTP layer.

**Alternatives considered**:
- **Reuse the `mcp/gates/client.ts` mapping**: rejected — that would map 5xx to `transport`, which the sweep pattern-matches on to trigger the `AskUserQuestion` fallback (a write-only fallback). Query failures need a distinct class per Q3 → D.
- **Introduce two classes (`query-transport`, `query-not-activated`)**: rejected per the same rationale as #1022 R4 alternatives — no downstream dispatch branch would exercise the distinction.

---

## R6: Test injection seam

**Choice**: Reuse the `BuildMcpServerDeps` shape from #1022 (`orchestratorUrl`, `orchestratorTimeoutMs`, `fetchImpl`). Tests construct `buildMcpServer({ orchestratorUrl: 'http://mock', fetchImpl: fakeFetch })` and drive the two new tools through the same in-process MCP transport pattern as `parity-gate-open.test.ts` / `parity-gate-ack.test.ts`. Retry-schedule tests use vitest fake timers on `gates/retry.ts` directly.

**Rationale**:
- One options interface, zero new fields.
- `fetchImpl` is a per-request seam, so retry-schedule tests can assert exact call counts by counting invocations of the injected `fetch`.
- Retry helper is a pure function of `(fn, schedule)`. Fake timers exercise the schedule deterministically; no real sleeps.

**Alternatives considered**:
- **Global `vi.stubGlobal('fetch', ...)`**: rejected — cross-test coupling risk; existing parity tests already inject per-instance for the same reason.
- **`msw`/`nock`**: rejected — a ~30-LOC fake fetch handles it.

---

## R7: `generation` derivation — canonicalization for `clarification` gates (Q1 → A)

**Choice**: New pure helper `computeClarificationAnswerSetHash({ questions })` in `packages/cockpit/src/gates/clarification-hash.ts`. Canonicalization:

```ts
export interface ClarificationQuestion {
  questionNumber: number;
  questionText: string;
}

export function computeClarificationAnswerSetHash(input: {
  questions: readonly ClarificationQuestion[];
}): string {
  const sorted = [...input.questions].sort((a, b) => a.questionNumber - b.questionNumber);
  const canonical = JSON.stringify(
    sorted.map((q) => ({ questionNumber: q.questionNumber, questionText: q.questionText })),
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12);
}
```

Consumers then pass the returned string as the `batchId` to the existing `deriveClarificationGeneration({ batchId })`. **`deriveClarificationGeneration` signature is unchanged**; the new helper is additive.

**Rationale**:
- Q1 → A locks the hash inputs to "sorted-by-question-number list of `{ questionNumber, questionText }`". Objectified as an interface for TypeScript ergonomics; JSON-canonical serialization (via `JSON.stringify` on a projected shape that includes only the two allowed fields) prevents extra fields leaking into the hash.
- Explicit projection over `map((q) => ({ questionNumber: q.questionNumber, questionText: q.questionText }))` rather than passing `q` directly — so callers with a richer `Question` type (e.g., including `answerText`, `askedAt`) don't accidentally salt the hash with un-agreed fields.
- 12 hex chars = 48 bits — collision-safe for the population (any realistic project has O(hundreds) of clarification gates over its lifetime; birthday-collision at 4k open gates is ~2⁻²⁴). Also keeps the `gateKey` short in logs.

**Alternatives considered**:
- **Extend `deriveClarificationGeneration` to accept `questions[]`**: rejected — breaks existing call sites, forces a coordinated migration in fixtures + parity tests for zero win.
- **`sha256` full 64 chars**: rejected — 48 bits is already collision-safe for the population; longer keys are unreadable in log lines.
- **Salt with the `issueRef`**: rejected — the `gateKey` already carries `issueRef`, so double-salting adds no distinguishing power.
- **Serialize with a stable canonical-JSON library (`json-stable-stringify`)**: rejected — added dependency for a shape (`[{questionNumber, questionText}, ...]`) that has no nested-object key-ordering ambiguity. Sorted numeric key + straight `JSON.stringify` is deterministic.

---

## R8: `generation` derivation — `implementation-review` (FR-007)

**Choice**: Reuse the existing `deriveImplementationReviewGeneration({ headSha })` in `packages/cockpit/src/gates/generation.ts` — no signature change. Document it as canonical in `contracts/generation-derivation.md`. Add a parity fixture test asserting sweep-derived `gateId` equals live-derived `gateId` for the same `(issueRef, headSha)`.

**Rationale**:
- The helper already takes exactly the input the spec (FR-007) requires — the PR head SHA. Head SHA is durable and monotonic (a new SHA is a legitimately new gate).
- No code change is needed for the derivation; the change is proving-out sweep/live parity via a fixture test.

**Alternatives considered**:
- **Include the PR base SHA in the discriminator**: rejected — head SHA alone identifies the review target; base changes typically produce a new head (rebase/merge). Adding base would create false generations on unchanged reviews.

---

## R9: `generation` derivation — other gate types (FR-008)

**Choice**: `artifact-review`, `manual-validation`, `escalation`, `phase-queue`, `filing`, and `scope-drained` helpers **already exist** in `packages/cockpit/src/gates/generation.ts`. Document them as canonical in `contracts/generation-derivation.md`. This spec adds parity fixture tests for `artifact-review` and `manual-validation` (SC-002 fixture matrix). `phase-queue`, `filing`, and `scope-drained` are declared **out of scope for SC-002 coverage** per spec Out-of-Scope § — they are covered by their existing #1020 fixtures only.

**Rationale**:
- Spec FR-008 says: "Implement if reachable in scope; otherwise file follow-ups." The already-existing helpers satisfy the derivation part; the fixture-parity assertion (agency sweep vs live path) is the missing piece.
- Grouping `phase-queue`, `filing`, `scope-drained` as "no SC-002 coverage" is explicit and gives the reviewer a clean scope boundary. Follow-up issues (if needed) can raise their coverage without contract change.

**Alternatives considered**:
- **Cover every gate type in SC-002**: rejected — spec explicitly limits SC-002's fixture matrix to `clarification` and `implementation-review`. Broadening would either miss the sweep call sites (which don't touch phase-queue etc.) or invent scenarios that add test churn without preventing bugs.

---

## R10: Cloud-status → query-response mapping (Q2 → C)

**Choice**: The **orchestrator route** performs the seven-to-three collapse (per `contracts/gate-query.md`), not the MCP tool. Cloud returns raw status; orchestrator maps and returns the MCP-facing three-state envelope.

Mapping (Q2 → C, load-bearing):

| Cloud status | MCP-facing status |
|--------------|-------------------|
| `open`       | `open`            |
| `answered`   | `answered`        |
| `delivered`  | `answered`        |
| `applied`    | `answered`        |
| `superseded` | `absent`          |
| `failed`     | `absent`          |
| `expired`    | `absent`          |
| (no match)   | `absent`          |

**Rationale**:
- The collapse is a **cluster-side contract concern** (the MCP tool caller — the sweep — needs the three-state signal). Doing it in the orchestrator means the cluster→cloud wire carries the more informative status verbatim (useful for future observability), while the MCP surface stays stable.
- Alternatives that put the collapse in the MCP tool would leak seven raw statuses across the orchestrator ↔ MCP boundary — an unnecessary interior surface. Doing it in the cloud would force cloud-side coupling to cluster-side dispatch semantics.

**Alternatives considered**:
- **MCP tool does the collapse**: rejected — leaks seven-state vocab to the tool boundary for no gain; the orchestrator route is a natural single seam.
- **Cloud does the collapse**: rejected — couples cloud-side response shape to cluster-side sweep semantics; makes future cluster-side additions (e.g., a fourth `unknown` state) cloud-migration blockers.

---

## R11: `cockpit_gate_list` return set (Q5 → A)

**Choice**: The **orchestrator route** applies the "non-terminal, project-wide" filter and returns only `open | answered | delivered` cloud statuses (project-wide). Terminal statuses (`applied | superseded | failed | expired`) are dropped as history. The MCP-facing envelope maps each entry per R10's collapse table (so callers see `open | answered`; `delivered` collapses to `answered`).

**Rationale**:
- Project-wide scope is a **cloud-side query concern** — the orchestrator sends `projectId` in the request (derived from `cluster.json`); the cloud query selects across all clusters in the project. Serial-cluster takeover is safe by construction.
- Non-terminal filter runs before the seven-to-three collapse: `applied` gates are dropped (terminal), whereas `delivered` gates pass through and map to `answered`.

**Alternatives considered**:
- **Cluster-scoped list**: rejected per Q5 → A — takeover across clusters would miss predecessor gates.
- **Configurable via input flags**: rejected per Q5 → D — surface size grows for no downstream branch; caller filters `gateType` on the client side after receiving the small non-terminal set.

---

## R12: Observer independence (FR-012, SC-005)

**Choice**: Static import-scan regression test (`__tests__/observer-independence.test.ts`) that reads each of `tools/cockpit_gate_status.ts` and `tools/cockpit_gate_list.ts` as text and asserts:

1. No import from `./gates/client.js` (the write-path HTTP client).
2. No import from `./tools/cockpit_gate_open.js` or `./tools/cockpit_gate_ack.js`.
3. No import from `../routes/retained-cockpit-events.js` (relative to `packages/generacy`).
4. No import from any file with `retain` in its path.

Pattern mirrors #1015's `observer-independence.test.ts` for `cockpit_status`/`cockpit_context`.

**Rationale**:
- Static regex-based import scan is bulletproof: no matter how much a future refactor tries to share code, the test fires the moment a forbidden import lands.
- The list of forbidden imports is grounded in the concrete write-path files that exist today (from #1022). If a new write-path module lands, that PR adds it to the forbidden list.

**Alternatives considered**:
- **Runtime-behavior assertion (spy on `POST /cockpit/gates`)**: rejected — brittle; refactors that move write logic to a new file would silently pass. Static import scan catches structural regression.
- **Type-level assertion (a `type Reads = never` phantom)**: rejected — TypeScript types are erased at runtime, so nothing prevents an import-only-for-types.

---

## R13: `query-unreachable` error class — where it dispatches downstream

**Choice**: New member of the `ErrorClass` union in `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts`. Consumer dispatch (spec Out-of-Scope): the agency sweep's `--gates=ui` code path aborts the current scope on `query-unreachable` (skill responsibility, tracked in generacy-ai/agency#450). This spec ships the class + surface only.

**Rationale**:
- Introducing the class here (rather than reusing `transport`) is the mechanical requirement that makes the sweep's downstream fail-loud possible. Without a distinct class the sweep cannot distinguish "orchestrator write path is temporarily unavailable, use `AskUserQuestion`" from "gate-status read is unavailable, abort".
- The class name (`query-unreachable`) chosen over alternatives (`read-unreachable`, `gate-query-failed`) because it mirrors the `transport` class's shape (single-word failure category) and matches the spec-clarified error-class name in Q3 → D.

**Alternatives considered**:
- **Reuse `transport`**: rejected — spec Q3 → D explicitly requires a distinct class so downstream dispatch differs.
- **Introduce `read-unreachable` + `write-unreachable`** (rename `transport`): rejected — churn for zero gain; existing `transport` semantics are load-bearing across every other MCP tool.

---

## R14: JSON Schema mirror & cross-repo doc sync (FR-010)

**Choice**: Publish `contracts/gate-query.md` + `contracts/gate-query.schema.json` in this feature's `specs/` dir **and** mirror them into `specs/1020-part-cockpit-remote-gates/contracts/` in the same PR. The generacy-cloud repo, which mirrors epic contracts by path, consumes the `1020-*` copy.

**Rationale**:
- Sibling #1020 (`packages/cockpit/src/gates/`) is the epic's contract-authoritative sub-issue. Its `specs/1020-*/contracts/` folder is the mirror source of truth generacy-cloud reads.
- Keeping the primary copy under `1038-*` and the mirror under `1020-*` in the same PR makes drift impossible (a reviewer sees both files at once).
- Non-Zod JSON Schema mirror is required for the generacy-cloud consumer per #1020's plan (which does not depend on `@generacy-ai/cockpit` npm).

**Alternatives considered**:
- **Publish only under `1020-*`**: rejected — this feature owns the query contracts; putting them in a sibling's dir hides the ownership.
- **Skip the JSON Schema mirror**: rejected — the generacy-cloud consumer path is documented in #1020; missing the mirror would silently break it.

---

## Key sources / references

- **Spec** (`spec.md`): FRs and SCs.
- **Clarifications** (`clarifications.md`): Batch 1, five decisions (Q1–Q5).
- **Sibling contracts docs**:
  - `specs/1020-part-cockpit-remote-gates/contracts/gate-record.schema.json` — GateRecord source of truth.
  - `specs/1022-part-cockpit-remote-gates/contracts/error-mapping.md` — sibling error-mapping table (this feature's Table R5 is a divergence, documented in R5 rationale).
  - `specs/1024-part-cockpit-remote-gates/contracts/env-seams.md` — env seams pattern.
- **Existing code**:
  - `packages/cockpit/src/gates/schema.ts` — `deriveGateKey`, `deriveGateId` (Assumption 5).
  - `packages/cockpit/src/gates/generation.ts` — `deriveClarificationGeneration`, `deriveImplementationReviewGeneration`, ...
  - `packages/generacy/src/cli/commands/cockpit/mcp/gates/client.ts` — write-path HTTP client (#1022).
  - `packages/generacy/src/cli/commands/cockpit/mcp/server.ts` — MCP-tool registration site.
  - `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts` — `ErrorClass` union.
  - `packages/orchestrator/src/routes/cockpit-gates.ts` — existing `POST` routes (unchanged by this feature except for adding a `GET` handler in the same file).
  - `packages/control-plane/src/services/cloud-pull-client.ts` — cluster→cloud HTTPS client precedent (#766).
  - `packages/activation-client/src/client.ts` — device-flow cluster→cloud client (#500).
- **Cited epic doc** (external, authoritative wire contract): `https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md`.
