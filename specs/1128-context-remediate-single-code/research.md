# Research: Remediate phase executor (#1128)

## Decision 1 — Executor shape: mirror `ReviewExecutor`

**Chosen**: New `RemediateExecutor` in `packages/orchestrator/src/worker/remediate-executor.ts` structurally mirroring `review-executor.ts` (verified at `review-executor.ts:45-218`):

- constructor deps `{ agentLauncher, config, settings, logger }`;
- `execute(context): Promise<PhaseResult>`;
- resolve `{ maxRemediations, review: { blockingSeverity, profile } }` via `resolveWorkflowOverrides(config, settings, workflowName)` (`config.ts:54`);
- resolve agent via `resolveAgentForPhase(config, workflowName, 'implement')` — same "the model that wrote the code fixes it" rationale used by review (#814);
- spawn via `agentLauncher.launch({ intent: { kind: 'remediate', ... }, cwd, env: {}, credentials: buildLaunchCredentials(config.credentialRole), provider })`;
- manage the child with `OutputCapture` + `setTimeout` SIGTERM→grace→SIGKILL exactly as `review-executor.ts:127-183`;
- return `{ phase: 'remediate', success, exitCode, durationMs, output }`.

**Why not `cli-spawner.spawnPhase`**: the spawner's `phase` param is typed `Exclude<WorkflowPhase, 'validate' | 'review' | 'remediate'>` (verified `phase-loop.ts:615`), so `remediate` is structurally excluded — the launcher path is the only option, exactly as review took.

## Decision 2 — Findings input: open blocking findings from the sidecar

**Chosen**: The executor reads the engine-authored artifact via `readReviewArtifact(checkoutPath, workflowId)` and filters `findings` to `status === 'open' && SEVERITY_RANK[severity] >= SEVERITY_RANK[blockingSeverity]` (the same predicate `computeVerdict` uses, `review-artifact.ts:235-244`). Those findings feed `buildRemediateCharter`.

**Q2=A (validate-failure evidence deferred to #1129)**: The charter is built findings-only but structured (a dedicated "Findings to address" section) so a future "Validate failures to fix" section can be appended without restructuring. No `validate → remediate` wiring is added; the only entry remains the post-review `remediateTrigger` seam (`phase-loop.ts:1270`).

## Decision 3 — Counter storage: distinct `remediationCount` field

**Chosen (Q1=A)**: Add `remediationCount: z.number().int().nonnegative().default(0)` to `ReviewArtifactSchema` (`review-artifact.ts:46-51`). The `.default(0)` makes pre-#1128 artifacts (which lack the field) parse cleanly — critical because a #1124 artifact written before this deploy must still `readReviewArtifact` without returning `null`.

- `round` stays `z.number().int().positive()` and monotonic (required by #1126 delta-scoping).
- Two helper functions added: `bumpRemediationCount(checkoutPath, workflowId): Promise<number>` (read → +1 → write, returns new value; if artifact missing, no-op returns 0 — but by construction the seam only fires after review wrote one) and `resetRemediationCount(checkoutPath, workflowId): Promise<void>` (read → set 0 → write).
- Both use the existing atomic `writeReviewArtifact` (temp+rename).

**Rejected**: reuse/reset `round` (B) — corrupts #1126 delta-scoping; reset both (C) — same corruption.

## Decision 4 — Increment timing: before commit, on every return path

**Chosen (Q4=A / FR-005 / SC-001)**: The executor increments `remediationCount` by exactly one per execution regardless of finding count or CLI exit status. The increment is placed on **every** executor return path (normal exit, timeout-killed exit, spawn failure) so a timed-out partial-work attempt still consumes budget. This prevents a perpetually-timing-out loop from never escalating.

Placement: increment inside `execute()` just before returning, after the child settles (or in the spawn-failure catch). Because `child.exitPromise` resolves even when the timeout SIGKILLs the child (mirrors review-executor's `exitCode = await child.exitPromise`), a single increment before the final `return` covers success and timeout uniformly; only the spawn-failure catch needs its own increment.

## Decision 5 — Commit/push in the seam via existing plumbing

**Chosen (FR-003)**: In the seam (`phase-loop.ts:1270-1284`), after `remediateExecutor.execute()`, call `prManager.commitPushAndEnsurePr('remediate')`. `remediate` is a valid `WorkflowPhase` (added by #1121), and `commitPushAndEnsurePr(phase: WorkflowPhase, ...)` accepts it (`pr-manager.ts:89`). Honor the #1051 `pushRefused` abort contract: if `commitOutcome.pushRefused` is set, abort the loop with `{ completed: false, gateHit: false }` (mirrors `phase-loop.ts:921-927`).

**Partial-work safety (FR-011/SC-006)**: because the commit happens after the (possibly timed-out) executor and the executor never discards the working tree, whatever the agent wrote before SIGKILL is committed and pushed. The sidecar stays valid (atomic writes) with the counter already bumped.

## Decision 6 — Gate re-key + verdict conjunct

**Chosen (Q5=A / FR-007)**: In the `on-remediation-limit` branch (`phase-loop.ts:1122-1147`), change the predicate from `artifact.round >= maxRemediations` to `artifact.remediationCount >= maxRemediations`, keeping `&& artifact.verdict === 'changes-required'`. The `artifact !== null` guard stays. `resolveWorkflowOverrides(...).maxRemediations` is already read here — unchanged.

## Decision 7 — Reset-on-resume + label clear at the satisfaction check

**Chosen (Q3=A / FR-009)**: The gate-satisfaction check (`phase-loop.ts:1163`) already special-cases `currentLabels.includes(completedLabel)`. For the `remediation-limit` gate only, before `continue`: (a) `await resetRemediationCount(checkoutPath, workflowId)`, (b) `await context.github.removeLabels(owner, repo, issueNumber, ['completed:remediation-limit'])` so the gate re-arms. Other gates keep today's plain `continue`. `GATE_MAPPING['remediation-limit'] = { phase: 'review', resumeFrom: 'review' }` (verified `phase-resolver.ts:17`) — **unchanged** (FR-010); a "resume directly into remediate" target is invalid because `remediate` is off-sequence.

## Decision 8 — Gate body

**Chosen (FR-008)**: When the cap gate activates (before `return { ... gateHit: true }`), post an issue comment via `context.github.addIssueComment(owner, repo, issueNumber, body)` (verified on the client interface, `interface.ts:132`) listing each `status:'open'` finding as `- <file>[:<line>] — <title>`. Best-effort; wrap in try/catch so a comment failure cannot fail the pause.

## Decision 9 — Launch intent

**Chosen (D-4)**: New `RemediateIntent { kind: 'remediate'; issueNumber; prompt; provider?; model?; effort? }` in `plugin/launch/types.ts` (mirrors `ReviewIntent`, `types.ts:102-114`), added to the `ClaudeCodeIntent` union and exported from `index.ts`. Plugin gains `'remediate'` in `supportedKinds` (`claude-code-launch-plugin.ts:55`), a `case 'remediate': return this.buildRemediateLaunch(intent)` branch, and `buildRemediateLaunch` byte-identical to `buildReviewLaunch` (`claude-code-launch-plugin.ts:245-273`).

## Decision 10 — Label registration

`completed:remediation-limit` is absent from `label-definitions.ts` (only `waiting-for:remediation-limit` exists, `label-definitions.ts:46`). Add `{ name: 'completed:remediation-limit', color: '0E8A16', description: 'Remediation-limit gate satisfied by operator' }` alongside the other `completed:*` entries so the monitor/cockpit recognize it and `ensureRepoLabelsExist` creates it.

## Sources

- `packages/orchestrator/src/worker/review-executor.ts` — executor template.
- `packages/orchestrator/src/worker/review-artifact.ts` — sidecar schema + helpers.
- `packages/orchestrator/src/worker/phase-loop.ts:1122-1147` (gate), `:1163-1169` (satisfaction), `:1270-1284` (seam), `:905-927` (commit + pushRefused).
- `packages/orchestrator/src/worker/config.ts:54-72` — `resolveWorkflowOverrides`.
- `packages/orchestrator/src/worker/phase-resolver.ts:9-18` — `GATE_MAPPING`.
- `packages/generacy-plugin-claude-code/src/launch/{types.ts,claude-code-launch-plugin.ts}` — intent + launch.
- `packages/workflow-engine/src/actions/github/label-definitions.ts:46` — labels.
