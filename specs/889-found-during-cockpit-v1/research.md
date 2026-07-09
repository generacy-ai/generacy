# Research: #889 — `waiting-for:merge-conflicts` provisioning + label-op crash-loop

## Decision Log

### D1: Provisioning mechanism — memoized boundary net + proactive sync (Q1→C)

**Decision**: `LabelManager` gains a per-`(process, repo)` memoized `ensureRepoLabelsExist()` pass as the *load-bearing* correctness mechanism. `LabelSyncService` continues to sync on repo-add / worker boot as a latency optimization only.

**Rationale**: The boundary net is self-healing — if a label was manually deleted, gets reintroduced by a new PR, or was never provisioned because the repo predates the label, the first `LabelManager` touch fixes it exactly-once and pays zero cost thereafter. `LabelSyncService`-only (Q1→A) leaves a gap for repos that were provisioned before the last WORKFLOW_LABELS extension. Reactive-only (Q1→B) is correct but wasteful without memoization. `C` is the union: sync for fast convergence, boundary for correctness — and tests only need to cover the boundary because the sync is a UX optimization.

**Alternatives considered**:

- **Q1→A (sync only, run on every touch)** — moves the fix out of the correctness path; a bug in `LabelSyncService.syncNewRepo` (e.g., silent partial failure) leaves the boundary defenseless. Rejected because the observed defect is precisely a case where the assumed sync did *not* run.
- **Q1→B (reactive only)** — correct but pays the per-call cost forever. Rejected in favor of memoization: same guarantee at steady-state zero cost.
- **Q1→D (one-shot at worker boot per active repo)** — depends on a known list of repos at boot, which is not universally available (workers claim from a shared queue and see repos on-demand). Rejected as brittle.

**Implementation pattern**: Class-static `LabelManager.ensuredRepos: Set<string>` keyed on `"owner/repo"`, shared across per-issue instances in the same process. An in-flight `Promise<void>` cache guards concurrent first-callers so only one `listLabels` roundtrip happens per warm-up.

### D2: Terminal-failure signaling — discriminated `WorkerResult` (Q2→D)

**Decision**: `WorkerHandler`'s return type widens from `Promise<void>` to `Promise<WorkerResult>` where `WorkerResult = { status: 'completed' } | { status: 'failed-terminal'; failureMetadata }`. `WorkerDispatcher.runWorker` branches on the discriminant to decide `complete()` vs. `release()`. `failureMetadata` carries the boundary site, the failing label operation, and the underlying `gh` stderr for the FR-004 alert emission.

**Rationale**:

- **Q2→A/D beats Q2→B** — sentinel errors are fragile: a single upstream `catch (e) { throw new Error(...) }` wrapper degrades the sentinel to a generic release, and TypeScript can't statically enforce that the sentinel survives its round-trip. A returned discriminated union is opaque at every boundary and preserves at every layer.
- **Q2→D beats Q2→C** — having the phase loop reach into queue concerns via `markFailed(...)` couples the workflow layer to the transport layer. Keeping the dispatcher as the single queue authority means the queue transition point is testable in isolation.
- **Failure metadata co-located with the result** — putting the site + labelOp + stderr on the same value that carries the "don't release" signal means the FR-004 alert is emitted from a single place (the dispatcher's `failed-terminal` branch), with all the context it needs. No secondary "read from a side-channel to build the alert" step.

**Alternatives considered**: See spec Q2 for the full set. `A` is a subset of `D` (no metadata) — chosen `D` for the FR-004 single-emission property.

**Type widening compat**: All in-repo callers of `WorkerHandler` return `{ status: 'completed' }` on the happy path via a one-line adapter in `claude-cli-worker.ts`. TypeScript enforces the transition.

### D3: Recovery-path chicken-and-egg — best-effort labels, comment is authoritative (Q3→B)

**Decision**: On `failed-terminal`, the dispatcher applies `agent:error` via a try/catch (best-effort; a failure logs at `warn` and continues). It then posts the FR-004 alert comment (also try/catch — a failure logs at `error` with full context). No re-throw, no release, ever, on this branch.

**Rationale**: The FR-002 memoized ensure-pass converges the missing-label case to zero recurrence — after the first ensure-pass, `agent:error` is always present on the repo, so the recovery path succeeds on the vast majority of failures. The remaining failure mode (full GitHub outage / token revocation) breaks *every* label and comment operation simultaneously; a marker label (Q3→C) or a synthetic label (Q3→C) would fail with the same error and add no visibility. The structured `error` log with full context is the only surface left standing in that scenario, and it *is* observable via the container's log aggregation.

**Alternatives considered**:

- **Q3→A (best-effort everywhere)** — same as B but without escalation of the comment failure. Rejected because a comment-post failure is the last *cluster-observable* signal available; escalating it to `error` (vs. `warn`) is free insurance.
- **Q3→C (fallback marker label)** — adds a new synthetic label symbol that the audit test (FR-007) must then also enumerate. More machinery in the path where machinery fails.
- **Q3→D (no `agent:error` attempt at all)** — sacrifices the vast common case (transient hiccup, missing-label case, etc.) where `agent:error` would succeed and give the operator the right visual signal on the issue.

### D4: Scope of no-re-throw — all four sites uniformly (Q4→D)

**Decision**: `onGateHit`, `onPhaseStart`, `onPhaseComplete`, and `onError` all throw `TerminalLabelOpError` on retry exhaustion. `phase-loop.ts` and `claude-cli-worker.ts` translate every occurrence to a `WorkerResult { status: 'failed-terminal' }`. The failing site is carried on the terminal error and surfaced in the alert.

**Rationale**: The naïve read of Q4→B ("only `onGateHit` and `onError` are terminal; `onPhaseStart` and `onPhaseComplete` should re-throw because they represent mid-flight drift") dissolves once the policy is understood as *terminate-with-evidence*, not *swallow-and-continue*. If `onPhaseStart` can't apply `phase:implement`, GitHub is broken for that repo — continuing the phase applies work with the wrong metadata and releasing crash-loops on the next reclaim. The right action in all four cases is: stop the item, emit the alert, wait for operator intervention. Uniform is simpler and diagnosable.

**Site metadata on the alert**: The alert comment names which boundary failed (`gate-hit` / `phase-start` / `phase-complete` / `error`) so operators can distinguish "paused but couldn't label" from "phase transitioning but couldn't label" — Q4→C's request is satisfied by carrying the site as structured metadata on the terminal error and surfacing it in the alert body's summary line.

### D5: Audit test enumeration — hybrid, static-scan load-bearing (Q5→D)

**Decision**: The FR-007 audit test uses a static regex scan over `packages/orchestrator/**/*.ts` and `packages/workflow-engine/**/*.ts` (excluding `__tests__/`) as the *load-bearing* enumeration, plus a runtime-registry probe on `LabelManager`'s hot boundary as a secondary check that also validates the FR-002 memoization.

**Rationale**:

- **Q5→A (static scan)** — the observed incident was precisely a new literal (`waiting-for:merge-conflicts` in `phase-loop.ts`) added in #864 without provisioning; a regex scan for `/^(phase|completed|waiting-for|failed|agent):[a-z0-9-]+$/` matches at the point of introduction, no matter where the literal lives.
- **Q5→B (curated union type)** — attractive for type-level enforcement, but the `GitHubClient.addLabels` signature is `(labels: string[]) => Promise<void>` — no way to constrain the generic gh client without breaking legitimate arbitrary-label uses (e.g., `type:*`, `epic-child`, etc., which are also in `WORKFLOW_LABELS`).
- **Q5→C (runtime registry)** — depends on driving representative flows; a new emission site that isn't exercised by the fixture set silently passes. Cheap secondary check, not sufficient primary.
- **Q5→D (hybrid)** — static scan catches all string-literal drift; runtime registry validates the phase-loop's hot boundary and the FR-002 memoization in one shot.

**Regex specifics**: `/(['"`])(phase|completed|waiting-for|failed|agent):[a-z0-9-]+\1/g`. The mandatory quote-character back-reference filters out matches in comments (which end with `*/` or newlines), and the trailing `[a-z0-9-]+` character class rejects `waiting-for:X-Y-Z_wrong` (underscore excluded), whitespace, and capitals.

**Exclusions**: an `AUDIT_EXCLUSIONS: Set<string>` list at the top of the test handles the tiny number of legitimate exceptions (initially empty; grow only if a false positive appears in review).

## Implementation Patterns Referenced

- **Memoized async initialization** — pattern used by `packages/orchestrator/src/services/wizard-creds-token-provider.ts` (mtime-cached read) and `packages/control-plane/src/services/git-token-manager.ts` (in-flight Promise dedupe). The FR-002 ensure-pass reuses the in-flight-Promise pattern.
- **Discriminated result on handler return** — pattern used by `packages/orchestrator/src/worker/phase-loop.ts` `PhaseLoopResult` (already has `gateHit: boolean` + `completed: boolean`; adding a `status` discriminator extends the existing shape).
- **Failure-alert comment** — reuses the `#865` `FAILURE_ALERT_MARKER_PREFIX` contract from `packages/orchestrator/src/worker/stage-comment-manager.ts` `postFailureAlert(...)`. Extends the `stage` union additively.

## Sources

- `packages/workflow-engine/src/actions/github/label-definitions.ts` — `WORKFLOW_LABELS` source of truth.
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts:779-791` — `addLabels` hard-fail path.
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts:1217-1235` — `listLabels` / `createLabel` primitives.
- `packages/orchestrator/src/worker/label-manager.ts:241-269` — `retryWithBackoff` — the site of the observed unhandled throw.
- `packages/orchestrator/src/worker/phase-loop.ts:795-834` — `pausePreMergeConflict` — where the FR-003 catch happens.
- `packages/orchestrator/src/worker/claude-cli-worker.ts:625-680` — `processItem` outer try/catch — where the `WorkerResult` is returned.
- `packages/orchestrator/src/services/worker-dispatcher.ts:334-366` — `runWorker` — where the `WorkerResult` is branched.
- `packages/orchestrator/src/worker/stage-comment-manager.ts:248-313` — `postFailureAlert` — the #865 alert emission contract.
- `specs/865-found-during-cockpit-v1/contracts/failure-alert-comment.md` — failure-alert-comment contract this fix extends additively.
- `specs/889-found-during-cockpit-v1/spec.md` — spec.
- `specs/889-found-during-cockpit-v1/clarifications.md` — Q1-Q5 answers.
