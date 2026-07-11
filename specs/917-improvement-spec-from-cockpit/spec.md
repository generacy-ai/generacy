# Feature Specification: cockpit MCP server transport (typed verbs + `cockpit_await_events` long-poll batching), registered orchestrator-only via entrypoint user scope

**Branch**: `917-improvement-spec-from-cockpit` | **Date**: 2026-07-11 | **Status**: Draft

## Summary

Improvement spec from the cockpit v1.5 auto-mode smoke test efficiency workstream (data: generacy-ai/tetrad-development#92, run-7 ledger). Companion to agency#403 (playbook-side cost contract); independent, but the two compose — #403 cuts per-event weight, this cuts event-delivery turn count and eliminates CLI syntax-negotiation turn classes.

## Motivation (from the snappoll run, 2026-07-10)

The auto session drives everything through Bash + the cockpit CLI. Observed costs that are transport-caused, not engine-caused:

- **Syntax-negotiation rounds**: `--help` lookups, argument-kind confusion (`<pr-ref>` vs `<issue>` — the finding-#49/#50 class, agency#398 / generacy#906), shell quoting and tempfile ceremony for comment bodies.
- **Re-parsing**: every `cockpit status --json` / `context` result is JSON inside shell text the model re-reads and re-serializes into its reasoning.
- **Event delivery granularity**: ~100 watch events each arrived as a separate wakeup → a separate dispatch round. Most were transient. Turn count, not tool-result bulk, is the dominant context driver (~4–5k tokens of growth per round).

## Design

**1. `generacy cockpit mcp` — a stdio MCP server exposing the cockpit verb set as typed tools.**

- Tools mirror the CLI verbs 1:1 and call the **same internal functions** (one implementation, two transports; no shelling out to itself): `cockpit_status`, `cockpit_context`, `cockpit_queue`, `cockpit_advance`, `cockpit_resume`, `cockpit_merge`.
- Typed parameters: `issue` is `{owner, repo, number}` or a validated ref string; a number that resolves to a PR is a **schema-level/typed error** with guidance (subsumes generacy#906's guard at this transport). Gate names validated against the gate vocabulary.
- Structured results: the discriminated-union shapes the CLI already emits as JSON, returned as tool results directly — no stdout parsing. Errors are typed results (`{status: "error", class, detail}`), never bare non-zero-exit text.
- The CLI remains canonical and fully supported (scripts, humans, worker-side code paths); the MCP server is an additional transport for interactive agent sessions.

**2. `cockpit_await_events` — long-poll event delivery with batching (the coalescing lever).**

- `cockpit_await_events({epic, cursor, maxWaitMs, coalesceWindowMs})` → `{events: [...], cursor}`. Blocks until ≥1 event or timeout; after the first event, waits `coalesceWindowMs` (default a few seconds) to batch the burst that typically accompanies it (label add/remove pairs, phase chains), then returns.
- **Delivery batching, never filtering** (agency#394 invariant): every event S8/watch would emit appears in some batch, verbatim, in order, with the uniform `type` discriminator (#887). Cursor semantics make re-arms idempotent and crash-safe (same cursor → same tail).
- One batch → one dispatch round in the auto session: on the snappoll profile this alone cuts watch-derived rounds roughly in half or better.
- Implementation: same event source as `cockpit watch` (which stays for humans/scripts).

**3. Orchestrator-only registration.**

- **Not** via `.mcp.json` — that file is repo-scoped: worker containers check out the same repo and would inherit the server (context bloat in every phase agent), and it pollutes the target project's own config surface.
- The scaffolder's `entrypoint-orchestrator.sh` registers the server at **user scope inside the orchestrator container only** (`claude mcp add --scope user cockpit -- generacy cockpit mcp`, or writing the orchestrator's `~/.claude.json`). Worker entrypoints add nothing.
- Defense in depth: `cockpit mcp` refuses to start (clear error) when a cluster-role env marks the container as a worker — merge/advance capability should be structurally absent from workers, consistent with the control-plane topology (workers already cannot reach orchestrator-local capabilities).
- Keep scaffolder and cloud-deploy in lockstep for this entrypoint change (known drift hazard).

## Out of scope

- Migrating auto.md/clarify.md to call the MCP tools — agency follow-up **after** this ships, written against the shipped tool contract (tool names + schemas above are the interface freeze candidates).
- Replacing or deprecating any CLI verb; `cockpit watch` NDJSON stays.
- gh-shape resolver fixes (generacy#913) — transport-independent, tracked separately.

## Success criteria

- An auto session (post-migration) completes an epic with zero Bash invocations of cockpit CLI verbs and zero `--help` consultations.
- A malformed ref (PR number as issue) is rejected at the tool layer with actionable guidance — no engine round-trip, no diagnosis turn.
- Event-driven dispatch rounds for a comparable 12-issue epic drop ≥2× (transcript-measured) via batching.
- Worker containers show no cockpit MCP server in `claude mcp list`; starting `cockpit mcp` in a worker exits non-zero with the role error.

## Regression coverage

- Tool-schema tests: valid/invalid refs, gate vocabulary, PR-number rejection message.
- `cockpit_await_events`: batching within the window, no event loss across cursor resumes, verbatim event bodies (byte-equal to watch NDJSON lines), ordering.
- Parity tests: each MCP tool result deep-equals the corresponding CLI `--json` output for the same fixture state.
- Entrypoint: orchestrator registers user-scope server; worker entrypoint does not; role-env refusal path.


## User Stories

### US1: Typed MCP verbs eliminate CLI syntax-negotiation rounds in interactive agent sessions

**As a** cockpit-auto session (an interactive Claude agent driving an epic from `agency/auto.md`),
**I want** to invoke `cockpit_status`, `cockpit_context`, `cockpit_queue`, `cockpit_advance`, `cockpit_resume`, and `cockpit_merge` as typed MCP tools with schema-validated parameters and structured result shapes,
**So that** turn classes caused by transport friction — `--help` lookups, `<pr-ref>` vs `<issue>` argument-kind confusion (agency#398 / generacy#906), shell quoting and tempfile ceremony for multi-line comment bodies, and re-parsing `--json` output out of shell text — disappear from the run ledger without changing any engine behavior.

**Acceptance Criteria**:
- [ ] The MCP tool set is a 1:1 mirror of the current cockpit CLI verb set and calls the same internal functions the CLI does (one implementation, two transports; the MCP server does not shell out to the CLI).
- [ ] `issue` parameters accept either `{owner, repo, number}` or a validated ref string (`owner/repo#N`, full issue URL); bare numbers resolve through the same `resolveIssueContext` path used by CLI verbs (per #822 / #850).
- [ ] A number that resolves to a PR when a verb expects an issue is rejected at the MCP schema/typed-error layer with actionable guidance (subsumes generacy#906's guard at this transport) — no engine round-trip, no diagnosis turn.
- [ ] Gate-name parameters (e.g. `--gate` on `advance`) validate against the shared gate vocabulary at the tool-schema layer.
- [ ] Results are the discriminated-union JSON shapes the CLI already emits, returned as MCP tool results directly. Errors are typed results (`{status: "error", class, detail}`), never bare non-zero-exit text.

### US2: `cockpit_await_events` long-poll batches event bursts into single dispatch rounds

**As a** cockpit-auto session watching an epic's event stream,
**I want** a long-polling `cockpit_await_events({epic, cursor, maxWaitMs, coalesceWindowMs})` MCP tool that blocks until ≥1 event, then waits a short coalescing window to batch the burst that typically accompanies it (label add/remove pairs, phase chains) before returning `{events, cursor}`,
**So that** one dispatch round in the agent session handles what today arrives as ~100 separate wakeup rounds on a comparable epic — attacking the dominant context-growth driver (turn count, ~4–5k tokens per round) rather than tool-result bulk.

**Acceptance Criteria**:
- [ ] Batching is delivery-shape only, never filtering (agency#394 invariant): every event that `cockpit watch` would emit appears in some batch, verbatim (byte-equal to the corresponding watch NDJSON line), in emission order, carrying the uniform `type` discriminator (#887).
- [ ] `cursor` semantics are idempotent and crash-safe: passing the same cursor returns the same tail regardless of how many prior batches were consumed at that position; the tool never advances the server-side position on the caller's behalf.
- [ ] Both `maxWaitMs` (max block before returning empty) and `coalesceWindowMs` (post-first-event window) are caller-controlled with server-side defaults calibrated to typical burst timing.
- [ ] The event source is the same source `cockpit watch` reads from; `watch` continues to emit NDJSON unchanged for humans and scripts.

### US3: Orchestrator-only registration keeps workers uncontaminated

**As a** cluster operator (and, downstream, a phase-worker agent whose context surface is a cost center),
**I want** the cockpit MCP server registered at user scope inside the orchestrator container only, with the worker entrypoint touching nothing,
**So that** workers show no cockpit MCP server in `claude mcp list`, phase-agent context surfaces stay uncontaminated, the target project's `.mcp.json` is not polluted, and merge/advance capability remains structurally absent from workers — consistent with control-plane topology.

**Acceptance Criteria**:
- [ ] Registration happens in the scaffolder's `entrypoint-orchestrator.sh` (`claude mcp add --scope user cockpit -- generacy cockpit mcp` or equivalent `~/.claude.json` write, orchestrator container only). Worker entrypoint changes: none.
- [ ] No `.mcp.json` is written or modified in the target project repo (repo-scoped config would inherit into worker checkouts and pollute the project's own config surface).
- [ ] `generacy cockpit mcp` refuses to start (non-zero exit, actionable role error on stderr) when cluster-role env identifies the container as a worker.
- [ ] Scaffolder and cloud-deploy entrypoint changes ship together; drift is called out as a known hazard.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Ship a new CLI subcommand `generacy cockpit mcp` that runs a stdio MCP server. The server exposes one MCP tool per cockpit verb currently in the CLI (`cockpit_status`, `cockpit_context`, `cockpit_queue`, `cockpit_advance`, `cockpit_resume`, `cockpit_merge`) and calls the same internal implementation functions those verbs use — no self-shelling. | P1 | Interface freeze candidate; agency migration (out of scope) will be written against these names + schemas. |
| FR-002 | Each MCP tool declares a typed input schema with `issue` accepting either a structured `{owner, repo, number}` object or a validated ref string (`owner/repo#N`, full issue URL). Bare-number inputs resolve through the same `resolveIssueContext` wrapper CLI verbs use (per #822 / #850), so cwd-origin inference and rejection copy stay identical across transports. | P1 | |
| FR-003 | When a verb expects an issue and the resolved number is a PR, the MCP layer returns a typed error result at tool-schema validation time (`{status: "error", class: "invalid-ref-kind", detail: ...}`) with actionable guidance identifying the mismatch. No engine round-trip; no non-zero-exit text. Subsumes generacy#906's guard at this transport. | P1 | Symmetric guidance for the inverse mismatch (issue number where PR expected) is included. |
| FR-004 | Gate-name inputs (e.g. `advance --gate`, `resume`'s preceding-gate lookup) validate against the shared gate vocabulary (`packages/generacy/src/cli/commands/cockpit/gate-vocabulary.ts`, per #849 / #891) at the MCP schema layer. Unknown gates return a typed error listing valid values. | P1 | |
| FR-005 | Tool results are the discriminated-union JSON shapes the CLI already emits via `--json`. Success and error variants are typed results; errors are never bare non-zero-exit strings. A parity test asserts each tool's result deep-equals the corresponding CLI `--json` output for identical fixture state (SC-005). | P1 | Parity is enforced at the shared internal function boundary — the CLI's `--json` emitter and the MCP tool result serializer take the same value. |
| FR-006 | Add MCP tool `cockpit_await_events({epic, cursor?, maxWaitMs, coalesceWindowMs})` → `{events: EventBatch, cursor}`. Semantics: block until ≥1 event OR `maxWaitMs` elapses (empty batch on timeout). After the first event arrives, wait `coalesceWindowMs` and drain any additional events emitted in that window into the same batch before returning. | P1 | Default `coalesceWindowMs`: a few seconds (calibrated to observed burst timing on the snappoll ledger; validated in tests). |
| FR-007 | `cockpit_await_events` reads from the same event source `cockpit watch` reads from. Every event `watch` would emit appears in some batch, verbatim (byte-equal to the corresponding NDJSON line), in emission order, carrying the uniform `type` discriminator (#887). Batching is delivery-shape only; there is no filtering or dedup. | P1 | agency#394 invariant. |
| FR-008 | `cursor` is server-side-opaque and idempotent: passing the same cursor value returns the same tail. The tool does not advance the server-side position on the caller's behalf — callers advance by passing the returned cursor on the next call. Missing/absent cursor starts from the caller's connect-time position (same rule as `watch`). | P1 | Crash-safety: an agent that dies mid-batch resumes on re-arm by re-sending the last-known cursor. |
| FR-009 | `cockpit watch` NDJSON output remains unchanged — same event source, same shapes, same ordering, same uniform-`type` discriminator. `watch` stays for humans, scripts, and any worker-side code paths. Neither `cockpit_await_events` nor the MCP server replaces or deprecates `watch`. | P1 | |
| FR-010 | Registration site: the scaffolder's `entrypoint-orchestrator.sh` (`packages/generacy/src/cli/commands/cluster/scaffolder.ts` and the analogous cloud-deploy path) registers the MCP server at user scope inside the orchestrator container (`claude mcp add --scope user cockpit -- generacy cockpit mcp`, or equivalent `~/.claude.json` write). Registration is idempotent (repeat runs do not duplicate the entry). | P1 | Both scaffolder and cloud-deploy paths change together — the same entrypoint drift hazard called out in the issue. |
| FR-011 | Worker entrypoint (`entrypoint-worker.sh` / analogous) makes no MCP-related changes. `.mcp.json` in the target project repo is neither written nor read for this feature — repo-scoped config would inherit into every worker checkout. | P1 | |
| FR-012 | `generacy cockpit mcp` inspects a cluster-role env var at startup and refuses to run in worker containers: exit non-zero, print an actionable role-error message on stderr, no MCP handshake initiated. | P1 | Defense in depth: the primary control is that workers never register it. This is the fail-closed backstop. |
| FR-013 | Existing cockpit CLI verbs (`status`, `context`, `queue`, `advance`, `resume`, `merge`, `watch`) remain fully supported with unchanged behavior, flags, exit codes, output shapes (human + `--json`), and error messages. This work adds a transport; it does not replace one. | P1 | |
| FR-014 | Regression suite covers (a) tool input schemas — valid refs, invalid refs, PR-number-where-issue-expected, gate vocabulary validation, (b) `cockpit_await_events` — batching within the window on a scripted burst, verbatim byte-equal event bodies vs `watch` NDJSON for identical fixture state, ordering preserved, no event loss across cursor resumes, empty-batch-on-timeout, (c) CLI parity — each MCP tool result deep-equals `<verb> --json` for the same fixture state, (d) entrypoint — orchestrator scaffold produces user-scope registration; worker scaffold does not; role-env refusal path. | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Cockpit CLI Bash invocations from a migrated cockpit-auto session | Zero `bash` calls to `generacy cockpit <verb>` and zero `--help` consultations across a complete epic run | Ledger audit of a post-migration auto-mode run on a comparable epic to the snappoll run-7 fixture (generacy-ai/tetrad-development#92). Migration itself is a separate agency change; this success criterion is measured against a session that has been migrated. |
| SC-002 | Ref-shape rejection cost | A PR number passed where an issue is expected is rejected at the MCP tool layer with actionable guidance; zero engine round-trips and zero diagnosis turns triggered by the mismatch | Regression fixture: `cockpit_advance({issue: {owner, repo, number: <PR_number>}})` returns `{status: "error", class: "invalid-ref-kind", detail: ...}`; no orchestrator API call recorded. |
| SC-003 | Event-driven dispatch round count on a 12-issue epic | ≥2× reduction vs. the snappoll run-7 profile (a run driven by `watch` NDJSON with one round per event) | Transcript-measured: count dispatch rounds attributable to event delivery in a post-migration auto session against the snappoll comparable-epic baseline. |
| SC-004 | Worker container MCP surface | `claude mcp list` inside a worker container shows no `cockpit` entry; `generacy cockpit mcp` in a worker exits non-zero with the role error on stderr | Cluster smoke test after scaffolder change: enter a running worker container, run `claude mcp list` and `generacy cockpit mcp`, assert both conditions. |
| SC-005 | Tool result parity vs CLI `--json` | Every MCP tool's result deep-equals the corresponding CLI `--json` output for identical fixture state | Parity test suite: for each `(verb, fixture)` pair, assert `MCP_tool_result === JSON.parse(cli_json_output)`. |
| SC-006 | `cockpit_await_events` batching under a scripted burst | Given a burst of N events emitted within `coalesceWindowMs`, one call returns a batch of N events (not N calls each returning 1) | Fixture: emit a synthetic burst (label add/remove pair, phase transition chain) into the same source `watch` reads; assert `cockpit_await_events` returns a single batch of the full burst. |
| SC-007 | `cockpit_await_events` verbatim event bodies vs `watch` | Byte-equal event payloads on both transports | Fixture: run `watch` NDJSON and `cockpit_await_events` against the same event stream; assert each event in the awaited batch is byte-equal to the corresponding NDJSON line. |
| SC-008 | `cockpit_await_events` cursor idempotence and crash-safety | Passing the same cursor returns the same tail; simulated caller-side crash mid-batch resumes with no event loss and no duplicate delivery outside the batch itself | Fixture: call twice with the same cursor, assert identical batch content; simulate crash after receiving batch but before processing, re-arm with prior cursor, assert same events replayed. |

## Assumptions

- The current cockpit CLI verbs are already backed by internal implementation functions clean enough to be shared with a second transport (or can be minorly refactored to that shape without a rewrite). If a verb's implementation is currently entangled with Commander's argv layer, a small extract-to-function refactor is bundled with that verb's MCP tool.
- The event source `cockpit watch` reads from can be tapped a second time by `cockpit_await_events` without changing its NDJSON emission semantics — either the source is already a broadcastable stream, or `watch` is refactored to consume the same shared source `cockpit_await_events` will consume.
- `claude mcp add --scope user` (or equivalent `~/.claude.json` write) is stable in the Claude CLI shipped inside the orchestrator container image and is safe to invoke idempotently from the entrypoint. If Claude CLI version drift makes this unreliable, direct `~/.claude.json` write is the fallback (same effect, no CLI dependency).
- A cluster-role env var identifying worker vs orchestrator already exists (or is trivially added) — the control-plane topology already distinguishes these containers structurally (workers cannot reach orchestrator-local capabilities), so an env-level marker is a small increment on existing state.
- `.mcp.json` is repo-scoped in the Claude CLI shipped inside the cluster; user-scope entries in `~/.claude.json` do not appear in worker containers because worker containers have distinct home dirs (or, equivalently, distinct user identities inside the container image).
- The snappoll run-7 ledger's ~100 event / 1-round-each baseline is representative of the dispatch-round cost the batching lever must beat. SC-003's ≥2× target is calibrated against that baseline; other epic shapes (single-issue, burst-heavy, sparse) may show larger or smaller wins.
- The interface freeze on tool names + schemas (see FR-001) is the contract agency#403 and the eventual auto.md/clarify.md migration will code against. Post-freeze schema changes require a coordinated agency change.

## Out of Scope

- Migrating agency's `auto.md` / `clarify.md` playbooks to invoke the MCP tools instead of the CLI verbs. That is a follow-up in the agency repo, written against the shipped tool contract; SC-001 and SC-003 are measured post-migration but the migration itself is not part of this PR.
- Replacing or deprecating any cockpit CLI verb, including `cockpit watch` — the CLI stays canonical for scripts, humans, and worker-side code paths. `watch` NDJSON output is unchanged (FR-009).
- The `gh`-shape resolver fixes tracked as generacy#913 — transport-independent, separate issue.
- Cloud-side changes to how event streams are hosted or propagated. `cockpit_await_events` reads from the same event source `watch` reads from today.
- Cross-cluster / cross-project MCP orchestration. This server exposes one cluster's cockpit surface, scoped to the orchestrator container it runs in.
- Repo-scoped `.mcp.json` support for cockpit. Deliberately rejected in the issue design — repo-scoped config would inherit into worker checkouts.
- Any change to `cockpit watch`'s NDJSON format, event types, or cursor semantics. The uniform `type` discriminator (#887) and existing shapes are inputs to this feature, not outputs.

---

*Generated by speckit*
