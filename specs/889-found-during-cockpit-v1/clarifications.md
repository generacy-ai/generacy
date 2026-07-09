# Clarifications

## Batch 1 — 2026-07-09

### Q1: Provisioning mechanism — proactive sync vs. reactive create-if-missing
**Context**: FR-002 requires that "before any `addLabels(...)` call from the phase loop's label boundary, the target repo is confirmed to have the labels — either by proactive sync (`LabelSyncService.syncNewRepo`) or reactive create-if-missing at the `LabelManager` boundary." The two options have different failure modes, timing, concurrency stories, and blast radius. Proactive sync runs once (or on repo-add / worker boot) and trusts the state afterward; reactive create-if-missing pays a per-call cost but is self-healing if a repo's labels drift. This decision drives which package the fix lives in (`services/label-sync-service.ts` vs. `worker/label-manager.ts`), what test fixtures cover it, and whether pre-existing repos need any one-time touch to converge.
**Question**: Which mechanism satisfies FR-002?
**Options**:
- A: Proactive sync only — extend `LabelSyncService` so it (re)runs on every repo touch (not just repo-add) and syncs the full current `WORKFLOW_LABELS` set; `LabelManager` continues to trust the state.
- B: Reactive create-if-missing only — `LabelManager` calls `gh label create --force` (or `getLabel` + `createLabel`) inline before each `addLabels` at the label-op boundary; no `LabelSyncService` change.
- C: Both — `LabelSyncService` proactively syncs on repo-add / worker boot AND `LabelManager` create-if-missing acts as a safety net at the boundary.
- D: Proactive sync at worker boot per active repo (one-shot per (worker, repo) session, cached in memory), no per-call reactive check.

**Answer**: *Pending*

### Q2: Terminal-failure signaling to the worker/dispatcher (FR-003)
**Context**: FR-003 says the phase loop must NOT re-throw a label-op failure and instead "the item enters the terminal failed state … item marked completed-with-failure from the queue's perspective so it is not re-released." Today `ClaudeCliWorker.processItem` re-throws → `WorkerDispatcher` releases (`services/worker-dispatcher.ts:353`). There are three plausible mechanisms to signal "failed, don't release": (a) `processItem` swallows the throw and returns a `WorkResult` variant carrying failure semantics that the dispatcher checks before deciding release-vs-complete; (b) a new sentinel/typed error (`TerminalWorkerError`) that the dispatcher special-cases (release on generic throws, complete-with-failure on this class); (c) the phase loop directly marks the queue item completed (via an injected queue-adapter method) before returning normally to the worker. Each has different call-graph implications and different testability.
**Question**: How is "completed-with-failure vs. released" communicated to the dispatcher?
**Options**:
- A: `processItem` returns a discriminated result (e.g., `{ status: 'completed' | 'failed-terminal' | 'released' }`); dispatcher branches on it.
- B: New typed error (`TerminalLabelOpError` or `TerminalWorkerError`) that the dispatcher catches distinctly from generic errors; generic throws still release, terminal throws complete-with-failure.
- C: Phase loop calls a queue-adapter `markFailed(itemId, reason)` directly, then returns normally (no throw); dispatcher only handles release on unhandled throws.
- D: Same as A, but also record failure metadata (label-op name, gh stderr) on the result so the dispatcher can emit the FR-004 alert comment from a single place.

**Answer**: *Pending*

### Q3: Chicken-and-egg — what if `agent:error` itself fails to apply (FR-003 + FR-004)
**Context**: The FR-003 terminal path applies `agent:error` "via the best-effort path" and expects a #865-style alert comment on the issue. But the very reason the original label op failed may still be in effect on the follow-up: the same missing label (`agent:error` is in `WORKFLOW_LABELS` so this is unlikely, but a repo missing *all* protocol labels is possible), or the same transient GitHub outage, will make the follow-up label add fail too. If the fix doesn't specify what to do here, the same crash-loop returns via the recovery path. This intersects with Q1 — if create-if-missing (Q1-B/C) is chosen, the follow-up self-heals for the missing-label case, but the transient-outage case is still open.
**Question**: What must happen if the terminal recovery path (`agent:error` label add + alert comment) *also* fails?
**Options**:
- A: Best-effort — every recovery step is wrapped in try/catch, individual failures are logged at `warn`, item is still marked completed-with-failure locally, no re-throw regardless.
- B: Best-effort for label add only; the alert comment is the authoritative failure surface — if it fails, escalate (structured error log at `error` with the full context, but still no re-throw, no release).
- C: Best-effort for both, plus a fallback surface (e.g., a distinct `agent:paused-error` synthetic marker, or dispatcher-level telemetry event) so a repo lacking every protocol label doesn't hide the failure from operator visibility.
- D: Do not attempt `agent:error` at all in this path — mark the item completed-with-failure at the queue level only, defer the failure surface to a dispatcher-emitted metric/event (removes the chicken-and-egg entirely).

**Answer**: *Pending*

### Q4: Scope of the no-re-throw policy — all `LabelManager` retry sites or only the pause path?
**Context**: FR-003 lists `onGateHit` / `onPhaseStart` / `onPhaseComplete` / `onError` as the sites where retry-exhaustion no longer re-throws. The observed crash-loop is specifically in `onGateHit` (the pause path); the other three sites have different downstream consequences of "swallow the failure." E.g., swallowing an `onPhaseStart` failure means the workflow continues with the *wrong* labels applied for the current phase (invisible drift for subsequent gate checks). Swallowing an `onPhaseComplete` failure means the next phase's `phase:*` label is never removed. Swallowing an `onError` failure loops the very recovery path Q3 is about. The FR is written uniformly ("all four"), but the safety envelope differs by site.
**Question**: Which `LabelManager` retry-exhaustion sites get the no-re-throw treatment?
**Options**:
- A: All four (`onGateHit`, `onPhaseStart`, `onPhaseComplete`, `onError`) — uniform policy: any label op that exhausts retries terminates the item; consistency over granularity.
- B: `onGateHit` and `onError` only (the two paths that terminate the phase loop naturally); `onPhaseStart` / `onPhaseComplete` continue to re-throw because they represent mid-flight state drift that must not silently continue.
- C: All four, with per-site categorization at the failure surface — the alert comment names which boundary failed (`gate-hit`, `phase-start`, `phase-complete`, `error`) so the operator can distinguish "paused but couldn't label" from "phase transitioning but couldn't label."
- D: All four uniformly, AND the item's terminal state carries the failing site as structured metadata for the queue/telemetry (feeds into #865-style alert format).

**Answer**: *Pending*

### Q5: FR-007 audit test design — how are label symbols enumerated?
**Context**: FR-007 requires "a drift/audit test enumerates every label symbol the orchestrator applies (`phase:*`, `completed:*`, `waiting-for:*`, `failed:*`, `agent:*`) and asserts each is present in `WORKFLOW_LABELS`." Three plausible enumerations trade off maintenance cost against completeness: (a) static AST walk (ts-morph or grep) over the orchestrator/workflow-engine source for every `addLabels` / string-literal label reference; (b) a hand-maintained union type or `as const` list that every emission site is required (by TS structural typing) to be a member of, and the test asserts the union ⊆ `WORKFLOW_LABELS`; (c) runtime registry — every `LabelManager` (or `ghCli.addLabels`) call routes through a wrapper that records the label symbol, and the test drives representative flows and asserts recorded ⊆ `WORKFLOW_LABELS`. Each has a different failure mode when a new label is added without following the pattern.
**Question**: How does the drift/audit test enumerate the label symbols the orchestrator can apply?
**Options**:
- A: Static AST walk (ts-morph) over `packages/orchestrator/**` and `packages/workflow-engine/**` for string literals matching `^(phase|completed|waiting-for|failed|agent):` — assert each ⊆ `WORKFLOW_LABELS.map(l => l.name)`.
- B: Curated union / `as const` — introduce a `WorkflowLabelSymbol` type derived from the string literals used at emission sites; TS structural typing enforces membership; the test asserts the union covers `WORKFLOW_LABELS`.
- C: Runtime registry — instrument `LabelManager`/`gh-cli.addLabels` to record every symbol applied in a test-mode registry; run representative flows (`onGateHit(<all gates>)`, `onPhaseStart(<all phases>)`, etc.) and assert recorded ⊆ `WORKFLOW_LABELS`.
- D: Hybrid — static AST walk (A) is the load-bearing enumeration (catches literal-string additions anywhere in the code); a runtime-registry smoke path (C) as a secondary check on the phase-loop's hot boundary.

**Answer**: *Pending*
