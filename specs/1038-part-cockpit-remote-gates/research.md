# Research: Cockpit gates — read-only status query + stable generation derivation

**Issue**: [#1038](https://github.com/generacy-ai/generacy/issues/1038)
**Companion**: [plan.md](./plan.md), [spec.md](./spec.md), [clarifications.md](./clarifications.md)
**Design doc**: [tetrad-development/docs/cockpit-remote-gates-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md)

This file records the technology decisions the plan is built on, with the alternatives that were considered and rejected. Each decision heading is `R<N>`; `/tasks` and the eventual PR body reference these anchors.

---

## R1 — Query transport: reuse the relay, don't open a second wire

**Decision**: Cluster→cloud gate-status query rides a **new relay envelope pair** — `gate_query_request` (cluster→cloud) / `gate_query_response` (cloud→cluster) — added to `RelayMessageSchema` in `packages/cluster-relay/src/messages.ts`. The orchestrator's `GET /cockpit/gates` route delegates to a new `GateStatusQueryService` that maintains a correlation-id → pending-promise map, sends the request via the existing `ClusterRelayClient`, and awaits the correlated response with a per-attempt timeout.

**Rationale**: The spec's single-transport invariant (Assumptions §96) is the whole point of this feature — the sweep's cost model already includes "relay is up because we can open gates," so tying the query to the same wire means one degraded-mode story instead of two. A new envelope name (rather than reversing `api_request`/`api_response`) makes the direction and semantics explicit at the type level — every existing consumer of the union that touches `api_request` handles the cloud→cluster direction; overloading it with cluster→cloud request semantics would silently invert the dispatcher's contract in `packages/cluster-relay/src/proxy.ts:141`.

**Alternatives rejected**:
- **Direct HTTPS from cluster to cloud** (bypass relay, mirror the `packages/activation-client` pattern). Rejected: violates spec §96 single-transport invariant. Also means we take a second dep on cloud URL resolution + cluster API key management on the query path, which the relay already solved once.
- **Reuse `api_request`/`api_response` in reverse**. Rejected: the existing envelope's `path`/`method`/`headers`/`body` fields describe an HTTP request to be dispatched at the *other* end. Cluster-side we already have `handleApiRequest` (proxy.ts:141) that treats `api_request` as inbound-from-cloud and dispatches to a local HTTP target. Reversing the semantic without a rename would require branching on "which side am I" everywhere the message is handled, and would break the cluster-relay dispatcher's route-table contract.
- **Piggyback on the `cluster.cockpit` event channel** (fire-and-forget event + poll for reply on a status channel). Rejected: query/reply is inherently synchronous; simulating request/response over an event stream requires the same correlation-id map, plus a second retention story for "the query I sent while the relay was flapping."

**Key files**:
- `packages/cluster-relay/src/messages.ts` — envelope + Zod schema + union.
- `packages/orchestrator/src/services/gate-status-query.ts` (new) — correlation-id map + retry loop.
- `packages/orchestrator/src/routes/cockpit-gates.ts` — GET handler delegates here.
- Existing pattern: `packages/orchestrator/src/services/relay-bridge.ts` — how the relay client is wired into the orchestrator and how inbound messages fan out. The new service subscribes to a filter on `parseRelayMessage()` → `type === 'gate_query_response'`.

---

## R2 — Query response shape: three-state, not raw cloud enum

**Decision**: `cockpit_gate_status` returns `{ gateId, status: 'open' | 'answered' | 'absent' }` with the following mapping from the cloud's seven-value gate-status enum (Q2→C):

| Cloud status | Query response | Sweep action |
|---|---|---|
| `open` | `open` | skip drafting |
| `answered`, `delivered`, `applied` | `answered` | skip drafting |
| `superseded`, `failed`, `expired` | `absent` | free to re-draft (dead gate) |
| *no matching gate* | `absent` | draft normally |

**Rationale**: The three-state contract keeps the sweep's decision matrix trivially binary ("has anyone drawn this gate lately?" → yes / yes-but-answered / no-or-dead), avoiding an ever-growing case switch on the caller side whenever the cloud enum grows. Collapsing terminal-negative into `absent` (rather than surfacing them as first-class query states) matches operator intent: a `superseded` gate SHOULD be re-drawn if the natural gate still exists.

**Alternatives rejected**:
- Return the raw cloud enum verbatim. Rejected: leaks cloud enum churn into every sweep-caller update; also FR-001 pins the three-state contract.
- Collapse `delivered` into `open` (still awaiting cluster application). Rejected: sweep must NOT re-draft while an answer is in flight — that would produce the exact duplicate row this feature exists to prevent.

---

## R3 — Failure mode: bounded retry then `class: 'query-unreachable'`

**Decision**: On transport failure (relay down, timeout, cloud-side error), the query retries with bounded backoff — **~3 attempts spanning ~5s total** — then throws a distinct MCP tool error with `class: 'query-unreachable'` (Q3→D). The tool NEVER returns `absent` on transport failure.

Retry cadence baseline: 500ms → 1.5s → 3s (jitter ±10%). Per-attempt timeout: 5s (matches the existing `resolveGateOptions` default). Total wall time before failure: ~5s including the last attempt's timeout — enough to ride the startup relay-not-connected race, short enough that the sweep's per-issue budget isn't blown when cloud is truly down.

**Rationale**: The sweep runs at cluster boot, exactly when the relay is most likely to be transiently un-handshaked. Fail-open (Option B → return `absent`) would restore the duplicate-drafting behaviour this feature exists to fix. Fail-closed with a distinct error class lets the sweep loop treat cloud-unreachable as a *retryable, non-drafting* condition — the caller aborts, the auto-loop wakes up next tick, the relay is up, the sweep tries again.

**Alternatives rejected**:
- Fail-loud on first attempt (Option A). Rejected: the very common startup race causes false red every single boot.
- New fourth `'unknown'` status (Option C). Rejected: still requires every caller to switch on the fourth state; error classes are the existing mechanism for "signal the caller to abort without hiding the reason."
- Longer retry budget (~30s). Rejected: sweep per-issue budget target is sub-second; a 30s block per stuck issue defeats the sweep's purpose.

**Error class registration**: `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts` — append `'query-unreachable'` to `ErrorClass`. No changes to `wrapToolBoundary` (transient rethrows are caught + mapped inside the two new tools, not at the boundary).

---

## R4 — Sweep primitive is `cockpit_gate_list` by (issueRef, gateType) prefix

**Decision**: The startup sweep's primary skip-drafting check is `cockpit_gate_list(issueRef)` filtered client-side by `gateType`, NOT `cockpit_gate_status(gateId)` (Q4→B). If any returned gate for `(issueRef, gateType)` is currently `open`, the sweep skips drafting regardless of `generation` match.

**Rationale**: This kills the cutover duplicate for pre-existing `generation=1` gates without either a cloud migration or a permanent legacy-ID compatibility shim. The full-`gateId` `cockpit_gate_status` is still useful (US2 — restart-safe identity, plus operator debugging), but it's the *secondary* primitive.

**Cost analysis**: An 8-item scope with a mix of gate types produces one `cockpit_gate_list(issueRef)` call per issue → 8 relay round-trips → ~4s (below the 5s per-attempt budget × parallel = comfortably within the sweep window). No fan-out per gate-type.

**Alternatives rejected**:
- Full `gateId` match only. Rejected: pre-existing `generation=1` rows would return `absent` on the first sweep after this lands, producing one round of duplicate drafts per scope (the very regression this issue is filed to prevent).
- Compat shim in `deriveGateId` returning both IDs. Rejected: leaves permanent legacy-ID overhead in the derivation surface; opaque to future readers of the code.
- One-time cloud migration. Rejected: cross-repo change, blocking dep; the prefix-list approach makes it unnecessary.

---

## R5 — Clarification generation: canonical JSON hash of sorted question identity

**Decision**: `deriveClarificationGeneration` accepts `{ questions: Array<{ questionNumber: number; questionText: string }> }` (Q1→A) and returns `sha256(canonicalJson(sortBy(questions, q => q.questionNumber))).slice(0, 24)`.

**Canonical JSON**: `JSON.stringify(sortedQuestions)` with:
- Array sorted ascending by `questionNumber` before serialization.
- Each object serialized with keys in a **fixed order**: `{"questionNumber":<n>,"questionText":<s>}` — implemented via explicit `sorted.map(q => ({questionNumber: q.questionNumber, questionText: q.questionText}))` before `JSON.stringify` to guarantee key order regardless of caller construction.
- No trailing whitespace / no pretty-print.
- `questionText` is emitted verbatim (Unicode preserved; JSON.stringify handles escaping deterministically).

**Rationale**: The FR-007 constraint "same round of asks → same generation" requires that two independent computations of the same set of `(questionNumber, questionText)` pairs — one in the live path (this repo, at draft time) and one in the sweep path (agency, at boot) — produce byte-identical bytes for hashing. Sorted-by-number + fixed-key-order + no-formatting is the minimal canonicalization that guarantees this without pulling a canonical-JSON library.

Drafted **answers** are deliberately excluded from the hash: two rounds of the sweep against the same open batch (before the operator answers) must produce the same generation; if answers were in the hash, the second sweep during an in-flight partial answer would see a different generation and open a duplicate.

**Alternatives rejected**:
- Include `answerText | null` in the hash (Option B). Rejected: contradicts "same batch of asks → same generation"; each partial answer would shift the generation and re-draft.
- Comment body / timestamp of the batch-comment (Option C). Rejected: not durable — comment-body edits by the operator would shift the generation; also unreadable from the cluster (requires a GitHub round-trip on every sweep call).
- `Batch N — <ISO date>` header from `clarifications.md` (Option D). Rejected: `clarifications.md` lives on the feature branch, may not have merged, and does not carry per-question identity.

**Where the questions come from at hash time**:
- **Live path** (this repo): from the drafted batch that the LLM produced before calling `cockpit_gate_open`. The MCP tool has the questions in hand.
- **Sweep path** (agency, out of scope here but same helper): from parsing the current unanswered batch off GitHub (`<!-- generacy-stage:clarification -->` comment marker + parse rules; sweep already reads these to decide *which* gates to open). Both paths call `deriveClarificationGeneration({questions})` on the same list → same hash.

---

## R6 — Implementation-review generation: existing `headSha` helper is already correct

**Decision**: Reuse the existing `deriveImplementationReviewGeneration({headSha})` unchanged (`packages/cockpit/src/gates/generation.ts:24`). Sweep and live paths both derive `headSha` from `git rev-parse` against the PR under review; both must derive from the *same* PR head at the same moment in time (cluster is source of truth for the PR's current head; agency reads via the same `gh pr view --json headRefOid` mechanism).

**Rationale**: FR-008 asks only that generation be derived from durable GitHub state; head SHA is already durable + already exposed. No shape change needed. The parity fixture in `gates-generation.test.ts` extends to cover this path (SC-002 covers both `clarification` and `implementation-review`).

**Edge case — force-pushed PR head**: A force-push after the sweep-derived generation was hashed but before the live path opens the gate would produce a *different* `gateId`. This is intentional: the review's substantive content changed, so the gate SHOULD get a fresh row. The old row moves to `superseded` cloud-side (which query maps to `absent` per R2 → sweep re-drafts the new head), which is the correct behaviour for a materially changed review request.

---

## R7 — `cockpit_gate_list` returns non-terminal, project-wide

**Decision**: `cockpit_gate_list(issueRef)` returns all gates for the issue where cloud status ∈ `{open, answered, delivered}` — terminal statuses (`applied | superseded | failed | expired`) are excluded server-side. Scope is **project-wide** (any cluster in the same project). Response shape: `{ gates: Array<{ gateId, gateType, status: 'open' | 'answered' }> }` (mapped through R2's collapsing rule; `delivered` collapses to `answered` on the cluster boundary too, since the caller doesn't need to distinguish).

**Rationale** (Q5→A):
- **Non-terminal only** — terminal statuses are history, not sweep-relevant; excluding them shrinks the payload for common cases (dozens of dead gates on a long-lived issue).
- **Project-wide** — a serial-cluster takeover MUST see the predecessor cluster's still-open gates, otherwise the takeover would re-draft everything. Cluster-scoped filtering would silently regress this.
- **Filtering client-side by `gateType`** rather than a `gateType` query parameter — keeps the cloud responder shape simple (project + issueRef → list); per-type filter is a trivial `.filter()` at the caller, and lets the operator's list-open-gates view get the full picture with the same call. If the payload proves too large in practice, `gateType` as an optional query parameter is an easy additive follow-up.

**Alternatives rejected**:
- Only `open` gates. Rejected: an `answered` (cluster-side ack not yet applied) gate is still non-drafting-eligible; excluding it would produce duplicates during the answer application window.
- Cluster-scoped filtering. Rejected: silently breaks takeover.
- Configurable via input flags. Rejected: adds surface area for no clear caller need in v1.

---

## R8 — No CLI twin for the two new MCP tools

**Decision**: `cockpit_gate_status` and `cockpit_gate_list` do NOT ship `generacy cockpit gate-status` / `generacy cockpit gate-list` CLI verbs. They are only meaningful inside an active `/cockpit:auto` session (or, for `gate-list`, an operator debugging a stuck scope from Claude Code with the MCP server already loaded).

**Rationale**: Matches the existing precedent set by `cockpit_gate_open` / `cockpit_gate_ack` (mcp/server.ts:194-204 comment). Opening a gate outside an auto-loop is a bug; likewise, listing gates from a CLI shell — outside the context of a sweep or ack-decision — has no natural use case. The two MCP tools cover the operator-debugging use case (US3) via Claude Code's `/mcp` tool list. Mocked-orchestrator unit tests (in `mcp/__tests__/`) exercise the same code paths a CLI twin would.

**Alternatives rejected**:
- Ship a `generacy cockpit gate-list --issue` verb for operator debugging outside Claude. Rejected: adds an entrypoint that must be maintained + tested + argument-parsed, for a use case the MCP tool already covers. Revisit if operator feedback demands a shell verb after ship.

---

## R9 — Where to put the retry loop: query-side, not tool-side

**Decision**: The bounded retry (~3 attempts / ~5s) lives in a new `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-client.ts`, sibling to the existing `client.ts` (which handles POST-shaped verbs with no retries). The two MCP tools call the query client; the query client owns the retry loop; the orchestrator route stays synchronous.

**Rationale**: The existing `client.ts` error-mapping table is fixed and dedicated to POST semantics (`400 → invalid-args`, `404 → unknown-gate`, `409 → invalid-args`, 5xx→`transport`). Adding retry + a new `'query-unreachable'` class inline would either bloat the shared file or require conditional branches on `verb`. A sibling file keeps concerns separated and lets each client evolve independently. Both files share `resolveGateOptions` (the same options bag) and the `ToolResult<T>` envelope — no code duplication of infrastructure, just a tightly-scoped second client with its own error surface.

**Alternatives rejected**:
- Put the retry loop in the orchestrator route. Rejected: the orchestrator↔cloud round-trip is already synchronous; retrying at the route means the MCP client sits blocked for the entire budget. Retrying at the client means the client can shed load / observe partial failures independently.
- Inline retry in each tool. Rejected: two copies of the same retry logic drift; the "never return `absent` on transport failure" invariant is easier to enforce in one place.

---

## R10 — Test strategy

**Unit** (Vitest, in-package):

- `packages/cockpit/src/gates/__tests__/gates-generation.test.ts` — **parity fixture** for SC-002: given a fixed `{questions:[…]}` and a fixed `headSha`, `deriveGateId(deriveGateKey(...))` returns a byte-identical string as the reference hash committed in the fixture. Reference hashes are inline in the test, computed once from the canonical spec; any drift in `deriveClarificationGeneration` breaks the test.
- `packages/generacy/src/cli/commands/cockpit/mcp/gates/__tests__/query-client.test.ts` — retry cadence, per-attempt timeout, sustained-failure → `'query-unreachable'` mapping, success-after-N-retries path.
- `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/cockpit_gate_status.test.ts` — happy `open`/`answered`/`absent`, `'query-unreachable'` end-to-end, invalid-args for missing `issueRef`.
- `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/cockpit_gate_list.test.ts` — happy list, empty list (no throw), transport failure.
- `packages/orchestrator/src/services/__tests__/gate-status-query.test.ts` — correlation-id round-trip against a mock relay client, timeout path, cloud-error path (`gate_query_response` with `status:'error'`).
- `packages/orchestrator/src/routes/__tests__/cockpit-gates.test.ts` — extend to cover the new GET handler.

**Integration** (extends the existing #1024 harness):

- `packages/orchestrator/src/__tests__/cockpit-gates-integration.integration.test.ts` — add one scenario: fake peer receives `gate_query_request`, responds with a fabricated status list; orchestrator GET handler returns the expected JSON; MCP tool returns the expected `ToolResult`. Proves end-to-end shape parity for one gate type without the cloud sibling being present.

**No dedicated e2e** — the integration harness proves the wire; the real cloud responder is out of scope, so a real-cloud e2e can only ship once the generacy-cloud sibling merges.

---

## R11 — Changeset bump levels

**Decision**: One `.changeset/1038-cockpit-gate-status-query.md` file with:

- `@generacy-ai/generacy` — **minor** (new MCP tools + new orchestrator route surface).
- `@generacy-ai/cockpit` — **minor** (breaking input-shape change to `deriveClarificationGeneration`; documented in the changeset body under `## Breaking changes`, with the "before/after" migration snippet the agency-side change needs).
- `@generacy-ai/cluster-relay` — **patch** (additive envelope types; existing consumers unaffected because `RelayMessage` is a union and the two new variants can only be produced by callers that opt in).

**Rationale**: Per CLAUDE.md § "Changesets", new capability → minor; new label vocabulary in `workflow-engine` → minor; additive-only wire types → patch. The clarification-generation shape change is a breaking type change but the export is only consumed by cockpit-plugin callers (agency + this repo); we own both, so a minor version + a coordinated agency PR is the right pairing.

**Alternatives rejected**:
- One changeset per package (three files). Rejected: they are semantically one atomic change; splitting them makes the review harder and the release notes noisier.
- Downgrade the cockpit bump to patch by keeping `{batchId}` as a legacy field. Rejected: leaves a permanently-ambiguous helper surface (see plan.md § Complexity Tracking).

---

## Sources

- Spec: [specs/1038-part-cockpit-remote-gates/spec.md](./spec.md)
- Clarifications: [specs/1038-part-cockpit-remote-gates/clarifications.md](./clarifications.md)
- Wire-contract source of truth: [tetrad-development/docs/cockpit-remote-gates-plan.md § Wire contracts](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md)
- Existing MCP boundary + insulation rationale: `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts:1-25`
- Existing route pattern: `packages/orchestrator/src/routes/cockpit-gates.ts:79-206`
- Existing generation helpers: `packages/cockpit/src/gates/generation.ts`
- Existing relay message union: `packages/cluster-relay/src/messages.ts:151-169`
- Sibling P1 issues in the same epic: #1020 (shared wire contracts), #1021 (orchestrator routes + retainer), #1022 (`cockpit_gate_open` / `cockpit_gate_ack` MCP tools), #1023 (doorbell), #1024 (integration harness).
