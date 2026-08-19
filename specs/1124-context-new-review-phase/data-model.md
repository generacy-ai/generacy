# Data Model: Review phase executor — structured findings artifact + engine-internal verdict

Core entities, TypeScript/Zod shapes, validation rules, and relationships for #1124. The single persisted entity is the **review findings artifact** (a filesystem sidecar). Everything else is transient (intents, charter inputs, executor results).

## Entity: `ReviewFinding`

A single correctness/regression observation produced by the review agent. Per FR-006.

```ts
type Severity = 'critical' | 'major' | 'minor';
type FindingStatus = 'open' | 'resolved';

interface ReviewFinding {
  severity: Severity;   // gating input for the verdict
  file: string;         // repo-relative path the finding concerns
  line?: number;        // optional 1-based line anchor
  title: string;        // short human-readable summary
  detail: string;       // full explanation of the problem
  round: number;        // review pass that produced this finding (FR-009)
  status: FindingStatus;// 'open' counts toward the verdict; 'resolved' does not
}
```

**Zod**:

```ts
const SeveritySchema = z.enum(['critical', 'major', 'minor']);
const FindingStatusSchema = z.enum(['open', 'resolved']);

const ReviewFindingSchema = z.object({
  severity: SeveritySchema,
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  title: z.string().min(1),
  detail: z.string().min(1),
  round: z.number().int().nonnegative(),
  status: FindingStatusSchema,
});
```

**Validation rules**:
- `severity` and `status` are closed enums — any other value fails the parse and the read returns `null` (SC-001).
- `line` is optional; when present it must be a positive integer.
- Empty `file`/`title`/`detail` fail (`.min(1)`) — a finding with no content is not a finding.

## Entity: `ReviewArtifact` (the persisted sidecar)

The engine-owned artifact. Written by the engine after the agent completes (the agent writes a *candidate* file; the engine validates + recomputes + rewrites). Per FR-005/FR-006/FR-007/FR-009.

```ts
interface ReviewArtifact {
  findings: ReviewFinding[];
  verdict: 'clean' | 'changes-required'; // ENGINE-COMPUTED (FR-007); agent-claimed value ignored
  round: number;                          // current review pass (FR-009)
  lastReviewedCommitSha: string;          // HEAD SHA the round reviewed
}
```

**Zod**:

```ts
const VerdictSchema = z.enum(['clean', 'changes-required']);

const ReviewArtifactSchema = z.object({
  findings: z.array(ReviewFindingSchema),
  verdict: VerdictSchema,
  round: z.number().int().positive(),
  lastReviewedCommitSha: z.string().min(1),
});

type ReviewArtifact = z.infer<typeof ReviewArtifactSchema>;
```

**Validation rules**:
- On read, malformed JSON, missing file, or schema-invalid content → `null` (mirrors `readPauseContext`; SC-001).
- The **agent-written candidate** need not carry a valid `verdict`/`round`/`lastReviewedCommitSha`; the engine reads the candidate's `findings` (tolerating a looser candidate shape), then writes a fully-valid `ReviewArtifact`. The strict schema above governs the **engine-written** file that `readReviewArtifact`/`readReviewArtifactSync` return.
- `verdict` is always recomputed by `computeVerdict(findings, blockingSeverity)` before the engine writes — a stored `verdict` is descriptive, never authoritative on the next read (the trigger trusts it because only the engine writes it).

**Persistence layout** (Decision 6):
- Path: `<checkoutPath>/.generacy/review-findings-<sanitizedWorkflowId>.json`
- `sanitizeWorkflowId(id)` = `id.replace(/[^a-zA-Z0-9_-]/g, '_')` (identical to `pause-context.ts`).
- Write: `mkdir -p` the `.generacy` dir, write `<path>.tmp`, `rename` to `<path>` (atomic).
- Clear: `unlink`, swallowing `ENOENT` (idempotent).

## Value function: `computeVerdict`

Per FR-007. Pure, unit-tested (SC-002).

```ts
const SEVERITY_RANK: Record<Severity, number> = { critical: 3, major: 2, minor: 1 };

function computeVerdict(
  findings: ReviewFinding[],
  blockingSeverity: Severity,
): 'clean' | 'changes-required' {
  const threshold = SEVERITY_RANK[blockingSeverity];
  const blocking = findings.some(
    (f) => f.status === 'open' && SEVERITY_RANK[f.severity] >= threshold,
  );
  return blocking ? 'changes-required' : 'clean';
}
```

**Rules**:
- Only `status: 'open'` findings count.
- `severity >= blockingSeverity` uses the numeric rank (`critical > major > minor`).
- Empty findings → `clean`.

## Transient: `ReviewIntent` (launch intent)

Carries the prepared charter prompt to the CLI spawn. Mirrors `MergeConflictIntent`. Added to the launcher union and the claude-code plugin union.

```ts
interface ReviewIntent {
  kind: 'review';
  issueNumber: number;
  prompt: string;          // the in-process charter (Q4→B)
  provider?: string;
  model?: string;
  effort?: string;
}
```

**Relationship**: consumed by `buildReviewLaunch(intent): LaunchSpec` in the claude-code plugin, which emits the same `claude -p --output-format stream-json --dangerously-skip-permissions --verbose [--model …] [--effort …] <prompt>` shape as `buildMergeConflictLaunch`.

## Transient: `ReviewCharterInput`

Input to the pure charter builder.

```ts
interface ReviewCharterInput {
  profile: 'standard' | 'verification';
  sidecarRelPath: string;   // e.g. '.generacy/review-findings-<id>.json' — where the agent must write
  blockingSeverity: Severity;
  round: number;
}

function buildReviewCharter(input: ReviewCharterInput): string;
```

**Charter content invariants** (FR-002/003/004/005):
- Selects `standard` vs `verification` body by `profile`; `verification` additionally emits "needs verification" findings for `validate` to confirm.
- Directs a correctness/regression review of the PR diff.
- **Explicitly forbids** running tests or builds (FR-003).
- Instructs the agent to **flag an implausibly empty/trivial diff** as a finding at or above `blockingSeverity` (FR-004 → US3).
- Instructs the agent to write findings (in the `ReviewFinding[]` shape) to `sidecarRelPath` (FR-005).

## Relationships

```
claude-cli-worker
  ├─ resolveWorkflowOverrides(config, settings, workflow) ──► ResolvedWorkflowConfig.review { profile, blockingSeverity, failThenPass }, maxRemediations
  ├─ constructs ReviewExecutor(agentLauncher, settings, logger)
  └─ injects into PhaseLoopDeps: { reviewExecutor, settings, remediateTrigger }

phase-loop (phase === 'review')
  └─ reviewExecutor.execute(context, deps)
        ├─ readReviewArtifact(checkout, workflowId)          → priorRound
        ├─ buildReviewCharter({ profile, sidecarRelPath, blockingSeverity, round })
        ├─ agentLauncher.launch({ intent: ReviewIntent, … }) → agent writes candidate sidecar
        ├─ read candidate findings + Zod-validate
        ├─ computeVerdict(findings, blockingSeverity)         → verdict (FR-007)
        └─ writeReviewArtifact({ findings, verdict, round, lastReviewedCommitSha })  (atomic)

phase-loop gate block (before seam)
  └─ condition 'on-remediation-limit': round >= maxRemediations → onGateHit(waiting-for:remediation-limit) → pause (FR-011)

phase-loop seam (phase === 'review' && success)
  └─ remediateTrigger(context) = readReviewArtifactSync(...).verdict === 'changes-required'
        ├─ true  → runStubPhase('remediate'); i--; continue  (re-enter review)
        └─ false → continue toward validate
```

## Severity / verdict truth table (SC-002 fixtures)

| Findings (open)                          | blockingSeverity | verdict           |
|------------------------------------------|------------------|-------------------|
| (none)                                   | critical         | clean             |
| minor                                    | critical         | clean             |
| major                                    | critical         | clean             |
| critical                                 | critical         | changes-required  |
| minor                                    | major            | clean             |
| major                                    | major            | changes-required  |
| critical                                 | major            | changes-required  |
| minor                                    | minor            | changes-required  |
| critical (status: resolved)              | critical         | clean             |
| critical (resolved) + minor (open)       | major            | clean             |
