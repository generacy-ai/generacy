# Contract: RemediateExecutor

`packages/orchestrator/src/worker/remediate-executor.ts` (new).

## Interface

```ts
export interface RemediateExecutorDeps {
  agentLauncher: AgentLauncher;
  config: WorkerConfig;
  settings: OrchestratorSettings | null | undefined;
  logger: Logger;
}

export class RemediateExecutor {
  constructor(deps: RemediateExecutorDeps);
  execute(context: WorkerContext): Promise<PhaseResult>;
}
```

## `execute()` behavior contract

1. Resolve `{ maxRemediations, review: { blockingSeverity, profile } }` via `resolveWorkflowOverrides(config, settings, item.workflowName)`.
2. `readReviewArtifact(checkoutPath, workflowId)`; filter `findings` to open blocking (`status==='open' && rank(severity) >= rank(blockingSeverity)`). `workflowId = "<owner>/<repo>#<issue>"`.
3. Build the charter via `buildRemediateCharter({ findings, round, remediationCount, blockingSeverity })`.
4. Resolve agent via `resolveAgentForPhase(config, workflowName, 'implement')`; resolve `timeoutMs` via `resolvePhaseTimeoutMs(config, 'remediate')`.
5. Spawn via `agentLauncher.launch({ intent: { kind: 'remediate', issueNumber, prompt, model?, effort? }, cwd: checkoutPath, env: {}, credentials: buildLaunchCredentials(config.credentialRole), provider })`.
6. Manage the child: `OutputCapture`; `setTimeout` → SIGTERM → `shutdownGracePeriodMs` → SIGKILL; `await child.exitPromise`.
7. **Increment `remediationCount` by exactly one on every return path** (normal exit, timeout, spawn-failure catch) via `bumpRemediationCount(checkoutPath, workflowId)`. (SC-001, Q4=A.)
8. Return `{ phase: 'remediate', success, exitCode, durationMs, output }`. `success` reflects the CLI exit; the loop backtracks to `review` regardless (the verdict, recomputed by the next review round, decides convergence).

## MUST NOT (FR-004)

- MUST NOT resolve review threads (`resolveResolvedThreads` / any `gh pr` thread mutation).
- MUST NOT mark the PR ready (`markReadyForReview`) or convert draft state.
- MUST NOT write GitHub review state (`APPROVE`/`REQUEST_CHANGES`/`COMMENT`).
- MUST NOT touch `round` or recompute `verdict` (that is the review executor's job).

## Invariants

| ID | Invariant |
|----|-----------|
| INV-1 | One `execute()` call increments `remediationCount` by exactly 1, independent of finding count (SC-001). |
| INV-2 | A timed-out `execute()` still increments (Q4=A) and leaves the sidecar valid/parseable (SC-006). |
| INV-3 | `round` and `lastReviewedCommitSha` are unchanged by `execute()`. |
| INV-4 | No thread-resolve / ready-mark / review-state call occurs (FR-004 / SC-005 assertion target). |

## Seam integration (phase-loop.ts)

Replace `runStubPhase('remediate')` at the seam (`:1277`) with:

```ts
await labelManager.onPhaseStart('remediate');
const remediateResult = deps.remediateExecutor
  ? await deps.remediateExecutor.execute(context)
  : this.runStubPhase('remediate');
const commitOutcome = await prManager.commitPushAndEnsurePr('remediate'); // FR-003
if (commitOutcome.pushRefused) {                                          // #1051 abort contract
  return { results, completed: false, lastPhase: 'remediate', gateHit: false };
}
if (commitOutcome.prUrl) context.prUrl = commitOutcome.prUrl;
await labelManager.onPhaseComplete('remediate');
results.push(remediateResult);
outputCapture.clear();
reviewRound++;
i--; // re-enter review (FR-012)
continue;
```

## Gate re-key (phase-loop.ts:1138-1141)

```ts
gateActive =
  artifact !== null &&
  artifact.remediationCount >= maxRemediations &&   // FR-007, was artifact.round
  artifact.verdict === 'changes-required';          // Q5=A conjunct retained
```

On activation, before pausing, post the gate body (FR-008):

```ts
const open = artifact.findings.filter((f) => f.status === 'open');
const body = ['Remediation limit reached. Remaining open findings:', '',
  ...open.map((f) => `- ${f.file}${f.line ? `:${f.line}` : ''} — ${f.title}`),
  '', 'Add `completed:remediation-limit` to resume with a fresh remediation budget.'].join('\n');
try { await context.github.addIssueComment(owner, repo, issueNumber, body); } catch { /* best-effort */ }
```

## Gate satisfaction reset (phase-loop.ts:1163)

When `completedLabel === 'completed:remediation-limit'` is present:

```ts
await resetRemediationCount(context.checkoutPath, workflowId);              // FR-009
await context.github.removeLabels(owner, repo, issueNumber, [completedLabel]); // re-arm
continue;
```

Other gates keep today's plain `continue` (no reset, no label clear).
