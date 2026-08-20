# Contract: `ReviewExecutor` + review-artifact module + launch intent

Interface contracts for the code #1124 introduces. These are the seams tasks will implement and tests will pin.

## `review-artifact.ts`

```ts
import type { Severity } from './types';

export interface ReviewFinding {
  severity: 'critical' | 'major' | 'minor';
  file: string;
  line?: number;
  title: string;
  detail: string;
  round: number;
  status: 'open' | 'resolved';
}

export interface ReviewArtifact {
  findings: ReviewFinding[];
  verdict: 'clean' | 'changes-required';
  round: number;
  lastReviewedCommitSha: string;
}

export const ReviewArtifactSchema: z.ZodType<ReviewArtifact>;

/** Absolute sidecar path: <checkoutPath>/.generacy/review-findings-<sanitizedWorkflowId>.json */
export function getReviewArtifactPath(checkoutPath: string, workflowId: string): string;

/** Relative path handed to the agent in the charter (agent's write target). */
export function getReviewArtifactRelPath(workflowId: string): string;

/** Atomic temp+rename write. mkdir -p the .generacy dir. Overwrites unconditionally. */
export async function writeReviewArtifact(
  checkoutPath: string, workflowId: string, artifact: ReviewArtifact,
): Promise<void>;

/** Async read. null on missing / unreadable / invalid JSON / schema-invalid. */
export async function readReviewArtifact(
  checkoutPath: string, workflowId: string,
): Promise<ReviewArtifact | null>;

/** Synchronous read for the remediateTrigger (which is sync). Same null contract. */
export function readReviewArtifactSync(
  checkoutPath: string, workflowId: string,
): ReviewArtifact | null;

/** Idempotent delete; swallows ENOENT. */
export async function clearReviewArtifact(checkoutPath: string, workflowId: string): Promise<void>;

/** FR-007. changes-required iff >=1 open finding with severity >= blockingSeverity. */
export function computeVerdict(
  findings: ReviewFinding[], blockingSeverity: Severity,
): 'clean' | 'changes-required';
```

**Contract guarantees**:
- `readReviewArtifact` / `readReviewArtifactSync` NEVER throw — they return `null` on any failure (SC-001).
- `writeReviewArtifact` is atomic: a concurrent reader sees either the old file or the fully-written new file, never a partial.
- `computeVerdict` is pure and total over the closed severity enum (SC-002).
- `getReviewArtifactPath` and `getReviewArtifactRelPath` agree: the relative path resolved against `checkoutPath` equals the absolute path (the agent and the engine target the same file).

## `review-charter.ts`

```ts
export interface ReviewCharterInput {
  profile: 'standard' | 'verification';
  sidecarRelPath: string;
  blockingSeverity: 'critical' | 'major' | 'minor';
  round: number;
}

export function buildReviewCharter(input: ReviewCharterInput): string;
```

**Contract guarantees** (asserted by `review-charter.test.ts`):
- The returned string contains an explicit prohibition on running tests or builds (FR-003).
- The returned string instructs flagging an implausibly empty/trivial diff as a finding at/above `blockingSeverity` (FR-004).
- The returned string names `sidecarRelPath` as the write target and describes the `ReviewFinding[]` shape (FR-005).
- `profile: 'verification'` output additionally instructs emitting "needs verification" findings; `profile: 'standard'` does not.
- Pure — no I/O, deterministic for a given input.

## `review-executor.ts`

```ts
export class ReviewExecutor {
  constructor(deps: {
    agentLauncher: AgentLauncher;
    settings: OrchestratorSettings;   // or the resolved review config
    logger: Logger;
  });

  /** Runs the review pass. Persists the artifact. Returns a PhaseResult. */
  async execute(context: WorkerContext, deps: PhaseLoopDeps): Promise<PhaseResult>;
}
```

**`execute` sequence** (contract):
1. Resolve `review.profile`, `review.blockingSeverity`, `maxRemediations` from settings + workflow.
2. `readReviewArtifact` → `priorRound`; `round = (priorRound ?? 0) + 1`.
3. `buildReviewCharter({ profile, sidecarRelPath: getReviewArtifactRelPath(workflowId), blockingSeverity, round })`.
4. Resolve provider/model/effort via `resolveAgentForPhase(config, workflow, 'implement')`.
5. `agentLauncher.launch({ intent: { kind: 'review', issueNumber, prompt: charter, provider, model, effort }, cwd: checkoutPath, env: {}, credentials: buildLaunchCredentials(credentialRole) })`.
6. Manage the child: `OutputCapture` + SIGTERM→grace→SIGKILL timeout (mirror `pr-feedback-handler`).
7. Read the agent-written candidate sidecar; extract + Zod-validate `findings`.
8. `verdict = computeVerdict(findings, blockingSeverity)` — **ignore any agent-claimed verdict** (FR-005/FR-007).
9. `lastReviewedCommitSha = getCurrentCommitSha(checkoutPath)`.
10. `writeReviewArtifact({ findings, verdict, round, lastReviewedCommitSha })`.
11. Return `{ phase: 'review', success: true, exitCode: 0, durationMs, output }`.

**Contract guarantees** (asserted by `review-executor.test.ts`):
- NO validate/build process is spawned during `review` (SC-003) — the only spawn is the `review` intent.
- GitHub review APIs (`gh pr review`, `/pulls/*/reviews`) are NEVER called (engine-internal verdict).
- The persisted `verdict` equals `computeVerdict(...)` regardless of what the candidate file claimed.

## Launch intent

```ts
// packages/orchestrator/src/launcher/types.ts  +  plugin types.ts
export interface ReviewIntent {
  kind: 'review';
  issueNumber: number;
  prompt: string;
  provider?: string;
  model?: string;
  effort?: string;
}
export type LaunchIntent = /* … existing … */ | ReviewIntent;
```

```ts
// claude-code-launch-plugin.ts
supportedKinds = [/* … */, 'review'];

private buildReviewLaunch(intent: ReviewIntent): LaunchSpec {
  const args = ['-p', '--output-format', 'stream-json',
                '--dangerously-skip-permissions', '--verbose'];
  if (intent.model)  args.push('--model', intent.model);
  if (intent.effort) args.push('--effort', intent.effort);
  args.push(intent.prompt);
  return { command: 'claude', args, stdioProfile: 'default' };
}
```

**Contract**: byte-identical arg composition to `buildMergeConflictLaunch` (the reference implementation).

## Phase-loop wiring

```ts
// PhaseLoopDeps
reviewExecutor?: ReviewExecutor;
settings?: OrchestratorSettings;
// remediateTrigger?: (context) => boolean   // #1121 — unchanged signature
```

- `phase === 'review'` branch: `result = deps.reviewExecutor ? await deps.reviewExecutor.execute(context, deps) : this.runStubPhase('review');`
- `phase === 'remediate'` branch: unchanged (`runStubPhase('remediate')`).
- New gate condition `'on-remediation-limit'` in `GateDefinitionSchema.condition`; evaluated in the gate block (before the seam): fires when `readReviewArtifactSync(...).round >= maxRemediations`.
- `remediateTrigger` injected by the worker: `(context) => readReviewArtifactSync(context.checkoutPath, context.workflowId)?.verdict === 'changes-required'`.

## Label vocabulary

```ts
// packages/workflow-engine/src/actions/github/label-definitions.ts
{ name: 'waiting-for:remediation-limit', color: 'FBCA04', description: 'Review↔remediate cap reached; awaiting operator' }
```

Matches the `waiting-for:implementation-review` review-gate color family.
