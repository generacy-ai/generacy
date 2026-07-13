# Research: `generacy cockpit mcp` stdio server for cockpit verbs

## Decision 1 — MCP transport & SDK selection

**Chosen**: `@modelcontextprotocol/sdk` (official TypeScript SDK), stdio transport.

**Rationale**:

- **Official SDK** — MCP protocol wire format is evolving; using the reference implementation avoids re-implementing framing/JSON-RPC/error-shape bugs. Zero MCP libraries exist in the repo today (grep confirmed no prior art); this is the first server we ship. Building bespoke would be strictly worse.
- **stdio (not HTTP/SSE)** — Claude Code discovers MCP servers via config that spawns a subprocess and speaks JSON-RPC on stdio. HTTP-mode MCP servers exist but require network setup (bind, auth, port collision, discovery) unwarranted for a local-only same-container server. Spec § 3 explicitly names stdio; the Q1-B rationale ("stdio server on same container — no network keepalive constraint") confirms.
- **ESM + Node >=22** — SDK ships native ESM. Matches the CLI's runtime target (`bin/generacy.js` gates on Node >=22). No CommonJS interop dance.

**Rejected alternatives**:

- *Bespoke JSON-RPC server* — reimplements a moving target with no compensating benefit. The SDK's `Server` class is ~200 LOC of glue we'd otherwise write.
- *HTTP transport* — adds bind/auth/port config to every orchestrator; adds a public-ish surface where none is required. All Claude Code MCP integrations in the ecosystem prefer stdio when the server is local.
- *Wrap the CLI as a subprocess (shell out to `generacy cockpit <verb>`)* — this is the exact anti-pattern the spec forbids ("same internal functions, two transports; no shelling out to itself"). Would drift the two surfaces on every future edit and reintroduce the JSON-re-parse cost the feature is supposed to eliminate.

## Decision 2 — Registration surface: user-scope inside orchestrator container

**Chosen**: cluster-base entrypoint (`entrypoint-orchestrator.sh`) writes the MCP config to `~/.claude.json` (user scope) inside the orchestrator container. Overwrite unconditionally when the existing `cockpit` entry's command differs (per Q4-A).

**Rationale** (from spec § 3 + clarify Q4-A):

- **Repo scope (`.mcp.json`) is wrong**: worker containers check out the same repo. A repo-scoped MCP config would register the cockpit MCP server in every phase agent's container — context bloat everywhere, and pollution of the *target project's own config surface* (the customer's repo, not ours). The `.mcp.json` file is the customer's file, not ours to write.
- **User scope inside the orchestrator container**: `~/.claude.json` in the orchestrator's own filesystem. Worker entrypoints add nothing (SC-004 asserts). Cluster-role env var (Q2-A) is the defense-in-depth check should a worker container somehow acquire the server anyway.
- **Overwrite on conflict**: entrypoint is source of truth; upgrades self-heal (`generacy update` may change the invocation path). Preserving hand-edits (Q4-B/C) creates a "why didn't my upgrade take?" wedge class. Log line noting reconciliation is observability enough — no relay event yet (Q4-D was rejected because no cloud consumer exists for it).

**Rejected alternatives**:

- *`.mcp.json` in the customer repo* (repo scope) — pollutes customer surface, leaks into workers. Rejected explicitly by spec § 3.
- *Preserve hand-edits* (Q4-B/C) — creates the upgrade-wedge class.
- *Emit `cluster.bootstrap` relay event on reconciliation* (Q4-D) — plumbing for an audience that doesn't exist yet.

## Decision 3 — Long-poll defaults: `maxWaitMs=55000`, `coalesceWindowMs=3000`

**Chosen**: 55s outer wait, 3s coalesce window. Both per-call tunable. `maxBatchSize` server default 256 (soft-cap, cursor is continuation).

**Rationale** (from clarify Q1-B + Q5-D):

- **55s outer** — stdio server on the same container, no network keepalive to blow past (option A's rationale for tighter defaults doesn't apply here). Each idle wakeup is a paid agent turn — halving them (55s vs 25s) is one of the load-bearing efficiency deltas the spec ships.
- **3s coalesce** — snappoll ledger shows near-simultaneous sibling clusters at phase boundaries. 3s covers single-issue label bursts (~1–2s) *and* sibling clusters. Trivial latency cost against gate-bound wall clock.
- **`maxBatchSize=256` soft-cap** — catch-up after a gap could otherwise return thousands of events in one batch, inverting the very cost batching is supposed to reduce. Soft-cap: batch closes early (before `coalesceWindowMs`), cursor points at next undelivered event, caller re-arms immediately. Ordering + verbatim preserved. No `truncated` flag needed — cursor is the continuation.
- **Locked in SC-006 fixture** — the concrete numbers are load-bearing enough that a future silent change would break the smoke-test math the spec's ≥2× reduction claim rests on. Fixture asserts the defaults.

**Rejected alternatives**:

- *Empirical picking during implementation* (Q1-D) — the snappoll data already informed these numbers; deferring just adds one turn of round-trip.
- *No cap* (Q5-A) — inverts the feature purpose on catch-up.
- *Hard cap with `truncated` field* (Q5-C) — makes the caller reason about a lossy-looking signal when the cursor already carries the continuation.

## Decision 4 — Invalid cursor: discriminate malformed vs expired

**Chosen** (Q3-D): malformed / never-issued → typed error result `{status: "error", class: "invalid-cursor", detail}`; expired / discarded (retention TTL, server restart) → silent reset to head with `resetFrom: "expired"` on the result.

**Rationale** (from clarify Q3-D + agency#394 invariant):

- **Different owners**: a malformed cursor is a caller bug (typo, wire corruption, wrong data type) — must fail loud. An expired cursor is routine infrastructure lifecycle (server restart, retention TTL) — must be *handleable*, not crash-worthy.
- **`resetFrom` is load-bearing**: "events may have been missed" is exactly the condition that triggers the auto-mode's existing startup-sweep recovery. Silent reset (Q3-B) would hide the gap — the agency#394 lesson recreated in cursor form.
- **`resetFrom: "expired"` string is a stable API** — the spec locks in the exact discriminator string so downstream consumers can pattern-match. Future retention modes (e.g., server-restart-signaled reset) add sibling discriminators, not a new field.

**Rejected alternatives**:

- *All → typed error* (Q3-A) — makes routine infra lifecycle a caller-crash class.
- *Silent reset for all classes* (Q3-B) — hides caller bugs *and* gap conditions.
- *Advance to head, no error* (Q3-C) — silent gap on caller bugs; equally hides both cases.

## Decision 5 — `GENERACY_CLUSTER_ROLE` env var (Q2-A)

**Chosen**: New `GENERACY_CLUSTER_ROLE` env var written by the compose scaffolder — `orchestrator` on the orchestrator service, `worker` on the worker service. `cockpit mcp` refuses to start when the value is `worker`. Companion cluster-base entrypoint change required.

**Rationale** (from clarify Q2-A):

- **Spec assumption was false** — good catch. Reading `packages/generacy/src/cli/commands/cluster/scaffolder.ts:206-265`, the two services are distinguished only by `command:` (their entrypoint scripts). Env-level identity was absent.
- **A named role marker is broadly useful beyond this backstop** — future subsystems that need to gate behavior on role (worker log verbosity, feature flags) inherit a clean primitive.
- **Fail-loud identity**: `GENERACY_CLUSTER_ROLE=worker` is explicit; inference-by-absence (Q2-C) fails open under misconfiguration.
- **Documented drift hazard**: scaffolder + cloud-deploy compose generation must land in lockstep. Historically that pair has diverged silently. Flagged in the contract with a companion cloud-deploy issue.

**Rejected alternatives**:

- *Reuse `GENERACY_WORKER_ID`* (Q2-B) — that variable is someone else's contract (credhelper audit). Nothing binds its presence-semantics forever, and coupling this backstop to a variable governed by another subsystem creates a hidden fragility.
- *Absence-of-orchestrator-artifact detection* (Q2-C) — fails open under misconfiguration; harder to reason about.
- *Skip the backstop entirely* (Q2-D) — the primary control (workers never register the server) is one config-file edit away from failing silently. Defense in depth is cheap here.

## Decision 6 — Ref input shape: discriminated union at the schema layer

**Chosen**: MCP tools accept `issue` as either `{owner: string, repo: string, number: number}` OR a string (ref URL, `owner/repo#N`, or bare number — normalized via `resolveIssueContext`). A PR number passed where an `<issue>` is required → typed `class: "wrong-kind"` error at the tool boundary.

**Rationale**:

- **Structured object first** — MCP tool callers (Claude) natively construct typed objects. Making the structured shape the primary form eliminates a class of string-parsing turns.
- **String fallback** — preserves the human-friendly ref forms (`owner/repo#N`, URLs, bare numbers with cwd inference) for callers passing through unmodified user text.
- **PR-number rejection at tool layer** — subsumes generacy#906's guard at this transport. Rejecting at the MCP boundary means Claude gets a typed corrective error instead of an engine round-trip. The check requires one `gh api /repos/{owner}/{repo}/issues/{n}` call to inspect the `pull_request` field — that cost is paid on every tool call.

**Rejected alternatives**:

- *String-only input* — reintroduces the syntax-negotiation rounds the feature is trying to eliminate.
- *Object-only input* — breaks parity with existing agency playbooks that pass through user-supplied refs verbatim.
- *Defer PR-number rejection to the internal function* — the spec explicitly names schema-level rejection as a design invariant (#3). Deferring loses the "no engine round-trip, no diagnosis turn" property SC-002 depends on.

## Decision 7 — Same internal function, not subprocess

**Chosen**: Each MCP tool handler imports and calls the same `run<Verb>()` function today's CLI wraps. No `child_process.spawn('generacy', ['cockpit', verb])` shelling.

**Rationale**:

- **Drift-proof**: two transports, one implementation. Every CLI test protects the MCP handler and vice versa.
- **Cheaper**: no fork/exec, no re-init of the whole CLI (logger setup, argument parsing, config loading). A MCP tool call is one function call, not a process boundary.
- **Type-safe**: the internal functions have their real return types available at the tool-handler boundary. Errors propagate as thrown `CockpitExit` (mapped to typed error results) rather than exit codes decoded from a subprocess.
- **Testability**: parity tests deep-equal the tool handler's return value against `renderJsonEnvelope(...)` output — no subprocess mocking.

**Rejected alternatives**:

- *Shell out to CLI* — the spec forbids this ("no shelling out to itself"). Would drift both transports, add subprocess overhead, and reintroduce JSON re-parsing on stderr.

## Decision 8 — stdout is the JSON-RPC channel; logs go to stderr

**Chosen**: All `run<Verb>()`-emitted stdout (from `getLogger()`, `process.stdout.write`, `console.log`) is captured by a per-tool-call sink; only the structured envelope is returned as the tool result. Logs route to stderr (which the MCP transport treats as non-protocol).

**Rationale**:

- **MCP wire correctness**: stdio transport uses stdout for JSON-RPC framing. A single stray `console.log` in a wrapped internal function corrupts the protocol and hangs the client. This is the single most-common MCP transport bug.
- **Handler-side wrapping**: the internal `run<Verb>()` functions accept `stdout` / `stderr` sinks in their `Deps` shape (evidence: `runStatus` at `packages/generacy/src/cli/commands/cockpit/status.ts:28-34`). The tool handlers pass in-memory sinks; the sinks are read *for the JSON envelope path only* and dropped otherwise.
- **Enforced by test**: a smoke test runs each tool handler with `process.stdout.write` mocked to a spy that asserts zero calls. Any handler that leaks direct writes fails the test.

## Decision 9 — Event bus retention: bounded LRU

**Chosen**: In-process event bus retains events in an LRU buffer sized 10 000 events *or* 10 minutes retention TTL, whichever hits first. Configurable via `COCKPIT_MCP_EVENT_RETENTION_MS` / `COCKPIT_MCP_EVENT_RETENTION_COUNT` env vars.

**Rationale**:

- **Bounded**: unbounded retention grows the orchestrator's memory footprint under a stalled consumer. 10k events is generous for a 12-issue epic (spec § SC benchmark) at any realistic dispatch rate; 10 min covers ordinary agent-restart windows.
- **Not persistent across server restarts**: process restart discards the buffer. Consumers hitting a discarded cursor get `resetFrom: "expired"` (Q3-D). This is the correct fault domain — a fresh server has no memory of prior events, and the consumer's startup-sweep recovery is the intended handler.
- **Env-var knobs, no CLI flags**: retention is an operator concern, not a per-call one. Per-call knobs are `maxWaitMs`, `coalesceWindowMs`, `maxBatchSize` (all in `AwaitEventsInput`).

**Rejected alternatives**:

- *Redis-backed persistence* — introduces state the orchestrator doesn't otherwise carry for cockpit; overkill for a v1 whose fault domain is agent-side reconnect within a minutes window.
- *Unbounded* — foot-gun.

## Decision 10 — Verbatim NDJSON event bodies

**Chosen**: `cockpit_await_events` returns event objects that are byte-equal (after `JSON.stringify`) to the NDJSON lines `cockpit watch` would emit for the same underlying state transitions. The uniform `type` discriminator (#887) is preserved.

**Rationale** (from spec § FR-006, agency#394 invariant):

- **Delivery batching, never filtering** — every event `cockpit watch` would emit appears in some batch, verbatim, in order. This is a testable invariant: import `emit()`'s schemas (`CockpitEventSchema`, `PhaseCompleteEventSchema`, `EpicCompleteEventSchema`, discriminated in `stream-event.ts:CockpitStreamEventSchema`) and assert every returned event validates.
- **Byte-equality test**: for a given fixture state transition, `emit()` produces one NDJSON line; the tool handler's event body must serialize to the same JSON (modulo ordering — objects are compared structurally, not string-wise). This locks the "same event source" claim from spec § 2.

## Sources

- Spec: `specs/917-improvement-spec-from-cockpit/spec.md`
- Clarifications: `specs/917-improvement-spec-from-cockpit/clarifications.md`
- MCP SDK: https://modelcontextprotocol.io — official TypeScript SDK
- Cockpit CLI verbs (reused internal functions):
  - `packages/generacy/src/cli/commands/cockpit/status.ts` — `runStatus`
  - `packages/generacy/src/cli/commands/cockpit/context.ts` — `runContext`
  - `packages/generacy/src/cli/commands/cockpit/advance.ts` — `runAdvance` + `CockpitExit`
  - `packages/generacy/src/cli/commands/cockpit/resume.ts` — `runResume`
  - `packages/generacy/src/cli/commands/cockpit/queue.ts` — `runQueue`
  - `packages/generacy/src/cli/commands/cockpit/merge.ts` — `runMerge`
- Event source: `packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts:runOnePoll`, `emit.ts`, `aggregate-emit.ts`, `stream-event.ts`
- Ref resolver: `packages/generacy/src/cli/commands/cockpit/resolver.ts` (#850)
- Gate vocabulary: `packages/generacy/src/cli/commands/cockpit/gate-vocabulary.ts`
- Compose scaffolder landing site: `packages/generacy/src/cli/commands/cluster/scaffolder.ts:206-265`
- Precedent — event batching invariant lineage: agency#394 (invariant statement), spec § 2 (this feature's echo)
- Precedent — PR-number-as-issue rejection: generacy#906 (CLI-side guard; this feature ships schema-level rejection at the MCP transport)
- Data source for defaults: generacy-ai/tetrad-development#92 (run-7 ledger)
