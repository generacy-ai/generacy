# Research: Review phase executor — structured findings artifact + engine-internal verdict

Technology and design decisions for #1124, with rationale and the alternatives that were rejected. Each decision cross-references the clarification (Qn) or functional requirement (FR-n) that constrains it.

## Decision 1 — Charter prompt delivery via a new `review` launch intent

**Decision**: Add a `ReviewIntent { kind: 'review'; issueNumber; prompt; provider?; model?; effort? }` to the launcher intent union and handle it in the claude-code plugin with a new `buildReviewLaunch`, byte-for-byte mirroring the existing `merge-conflict` path. The `ReviewExecutor` calls `agentLauncher.launch({ intent: { kind: 'review', prompt, ... }, cwd, env, credentials })` **directly**, like `pr-feedback-handler`, not `cli-spawner.spawnPhase`.

**Rationale**:
- Clarification **Q4→B** mandates the engine builds the charter in-process (selected by `review.profile`) and passes it as the CLI prompt via the existing prepared-prompt spawn path — **no** `/speckit:review` slash command, `PHASE_TO_COMMAND` not extended.
- `cli-spawner.spawnPhase` types its `phase` parameter as `Exclude<WorkflowPhase, 'validate' | 'review' | 'remediate'>` — `review` is structurally excluded, so it cannot be the spawn path. `pr-feedback`/`merge-conflict` already demonstrate the direct-`launch()` shape for prepared prompts.
- The `merge-conflict` intent is the closest existing analog (a prepared prompt keyed by an issue-scoped number, optional provider/model/effort), so the new intent is a low-risk copy.

**Alternatives rejected**:
- **(A) `/speckit:review` slash command** — Q4 option A. Pushes the profile choice and charter text into the plugin; the static one-command-per-phase `PHASE_TO_COMMAND` map cannot encode the `standard`/`verification` choice.
- **(C) charter file in the plugin referenced by path** — Q4 option C. Same objection: charter selection leaves engine ownership.
- **Reuse `cli-spawner.spawnPhase`** — impossible without widening its excluded-phase type, which #1121 deliberately narrowed.

## Decision 2 — Findings handoff via agent-written sidecar; engine validates + recomputes

**Decision**: The charter instructs the agent to write its findings to a known sidecar path under `<checkout>/.generacy/`. The engine reads that file, Zod-validates it, **recomputes** the verdict (ignoring any agent-claimed verdict), stamps `round` + `lastReviewedCommitSha`, and rewrites it atomically (temp+rename).

**Rationale**:
- Clarification **Q1→A**. File-artifact handoff is the native speckit paradigm and matches the `pause-context.ts` sidecar pattern the spec names (FR-005).
- Recomputing the verdict engine-side (FR-007) means a compromised/hallucinated agent verdict can never route the phase — the engine is the sole authority.

**Alternatives rejected**:
- **(B) fenced-JSON block in stdout** — Q1 option B. The brittle sentinel-parsing pattern that caused implement-phase bugs.
- **(C) dedicated MCP tool** — Q1 option C. Adds an unspecified surface for a one-shot handoff.

## Decision 3 — Verdict wiring through the synchronous `remediateTrigger`

**Decision**: The executor only persists the artifact. The existing `remediateTrigger(context)` hook reads the persisted sidecar and returns its boolean (`verdict === 'changes-required'`). Because `PhaseLoopDeps.remediateTrigger` is typed `(context) => boolean` (synchronous, `phase-loop.ts:107`), the trigger uses a dedicated **synchronous** reader `readReviewArtifactSync` (`fs.readFileSync` + Zod). The executor's own write path stays async.

**Rationale**:
- Clarification **Q2→B**. Reuses the #1121 hook and satisfies US2-AC3 ("decision derived solely from the persisted artifact's verdict"). The current phase-loop seam line (`:1157`) is unchanged.
- The trigger's synchronous signature is a hard constraint discovered in the code; a sync reader is the minimal way to honor it without changing the #1121 seam contract.

**Alternatives rejected**:
- **(A) verdict on `PhaseResult`** — Q2 option A. Defensible under AC2's "equivalent verdict signal" hedge, but B reuses the existing hook and keeps the decision file-sourced.
- **(C) verdict field on `WorkerContext`** — Q2 option C. Adds mutable cross-phase state; the sidecar already is the state.

## Decision 4 — Loop termination as a new `on-remediation-limit` gate condition

**Decision**: Bound the review↔remediate cycle with `maxRemediations` (speckit-bugfix→2, else→3). Implement the FR-011 exhaustion pause as a **new gate condition** `on-remediation-limit` attached to the `review` phase. When the artifact's `round` reaches `maxRemediations`, the gate fires and pauses with `waiting-for:remediation-limit` + `agent:paused`.

**Rationale**:
- Clarification **Q3→A**: enter the seam on `changes-required` but bound it; on exhaustion escalate/pause with the review gate label.
- The phase-loop's gate block (`:1020-1124`) runs **before** the remediate seam (`:1157`). Putting the cap in a gate condition means the pause happens *before* another remediate can fire — no extra control-flow surgery, and it composes with the existing `onGateHit` + `return { gateHit: true }` machinery. The loop does not otherwise honor a pre-set `result.gateHit`, so a gate condition is the correct lever.
- `remediate` is still a stub, so an unchanged diff would otherwise re-produce `changes-required` forever (the exact hazard FR-011 names).

**Alternatives rejected**:
- **(B) never enter the seam while remediate is a stub** — Q3 option B. Contradicts SC-004/FR-008, which require entering the seam.
- **(C) `failThenPass` to force a pass** — Q3 option C. A verdict-corrupting hack; `failThenPass` is a config knob, not a loop terminator.
- **Ad-hoc counter check inline at the seam** — would duplicate pause/label logic the gate block already owns and would run *after* the seam decision, one remediate too late.

## Decision 5 — Config resolution threaded from the worker

**Decision**: `claude-cli-worker.ts` (which already loads `orchSettings` at `:496`) resolves the review config once via `resolveWorkflowOverrides(config, settings, workflowName)` and injects `settings` (or the resolved `ResolvedWorkflowConfig`) plus the constructed `ReviewExecutor` into `PhaseLoopDeps`.

**Rationale**:
- `resolveWorkflowOverrides` currently has **zero consumers**; #1124 is the first. Resolving at the worker keeps a single resolution site and avoids re-resolving per phase iteration.
- The executor needs `review.profile` (charter selection), `review.blockingSeverity` (verdict threshold), and `maxRemediations` (gate cap) — all products of the same resolution call.

**Alternatives rejected**:
- **Resolve inside the phase-loop per iteration** — redundant work and spreads config knowledge into the loop.
- **Resolve inside the executor from raw config** — the executor would need the full `OrchestratorSettings` + workflow name anyway; resolving upstream is cleaner and testable in isolation.

## Decision 6 — Artifact path and sanitization

**Decision**: `getReviewArtifactPath(checkoutPath, workflowId)` → `<checkoutPath>/.generacy/review-findings-<sanitizedWorkflowId>.json`, with `sanitizeWorkflowId` applying `[^a-zA-Z0-9_-] → _` exactly as `pause-context.ts` does.

**Rationale**:
- FR-005 + Assumptions: the sidecar lives under `.generacy/`, keyed by workflow/issue identity, following the `pause-context.ts` sanitization + atomic-write layout. Reusing the identical sanitization avoids a second, divergent path scheme in the same directory.
- The charter is given the **relative** sidecar path (`.generacy/review-findings-<id>.json`) so the agent writes to the same absolute file the engine reads, regardless of the agent's cwd assumptions (the engine resolves it against `checkoutPath`).

## Decision 7 — Severity ordering and verdict computation

**Decision**: `computeVerdict(findings, blockingSeverity)` returns `changes-required` iff ≥1 finding with `status: 'open'` and `severity >= blockingSeverity` under the ordering `critical(3) > major(2) > minor(1)`; else `clean` (FR-007).

**Rationale**:
- FR-006/FR-007 fix the schema and the threshold rule. Numeric severity ranks make the `>=` comparison total and testable; `status: 'resolved'` findings are excluded so a re-review round that resolves findings can flip to `clean`.
- Pure function → SC-002 unit-tests it directly across critical/major/minor fixtures with no spawn machinery.

## Decision 8 — `round` and `lastReviewedCommitSha`

**Decision**: On each review pass the executor reads the prior artifact (if any), sets `round = priorRound + 1` (or `1` on first pass), and records `lastReviewedCommitSha` = the checkout's current HEAD SHA. Findings carry their originating `round` (FR-009).

**Rationale**:
- FR-009: successive review rounds must be distinguishable, and the round number is the substrate FR-011's cap is built on. `lastReviewedCommitSha` lets a future consumer tell whether a round reviewed a changed diff (relevant once the real `remediate` executor lands).

## Open items deferred (out of scope, per spec)

- **`remediate` executor** — stays `runStubPhase('remediate')`. Only the verdict→seam signal is wired.
- **Bugfix charter content** — lands with the bugfix-profiles issue. This plan ships `standard` + `verification` charters only.
- **Posting findings to the PR / cloud-side surfacing** — explicitly out of scope; the artifact is engine-internal.
