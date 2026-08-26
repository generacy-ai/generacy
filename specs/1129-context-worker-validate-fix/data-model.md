# Data Model: Route validate failures into the remediate loop

No new persisted schema is introduced. This feature advances an existing
artifact and adds one in-memory loop control. All types below already exist unless
marked **NEW**.

## Entity 1 — Review-findings artifact (filesystem sidecar) — REUSED

Source of truth for the remediation counter and the `remediateTrigger` verdict.
Defined in `worker/review-artifact.ts`.

```ts
type Severity = 'critical' | 'major' | 'minor';
type FindingStatus = 'open' | 'resolved';

interface ReviewFinding {
  severity: Severity;
  file: string;          // min length 1
  line?: number;         // positive int
  title: string;         // min length 1
  detail: string;        // min length 1
  round: number;         // >= 0
  status: FindingStatus;
}

interface ReviewArtifact {
  findings: ReviewFinding[];
  verdict: 'clean' | 'changes-required';
  round: number;               // int > 0
  lastReviewedCommitSha: string; // min length 1
}
```

Path: `<checkoutPath>/.generacy/review-findings-<sanitizedWorkflowId>.json`
(`workflowId = "<owner>/<repo>#<issueNumber>"`, sanitized `[^a-zA-Z0-9_-] → _`).

### Validate-synthesis mutation (FR-001/FR-002)

On a routed validate red, the phase loop advances this artifact:

| Field                   | Value written on synthesis                                          |
|-------------------------|--------------------------------------------------------------------|
| `round`                 | `(prior?.round ?? 0) + 1` — the shared `maxRemediations` counter    |
| `verdict`               | `'changes-required'` (set explicitly, **not** recomputed)          |
| `lastReviewedCommitSha` | current `HEAD` SHA in the checkout                                  |
| `findings`              | prior findings + one **synthesized** validate finding (below)      |

Synthesized validate finding:

| Field      | Value                                                                        |
|------------|------------------------------------------------------------------------------|
| `severity` | `'critical'` (guarantees `computeVerdict` blocks at any `blockingSeverity`)   |
| `file`     | the validate command string (sentinel; the failure is not file-anchored)     |
| `title`    | `'validate phase failed'`                                                     |
| `detail`   | bounded tail of the validate evidence (stdout/stderr/exit)                    |
| `round`    | the advanced `round`                                                          |
| `status`   | `'open'`                                                                      |

Validation: written via `writeReviewArtifact` (atomic temp+rename); read by
`readReviewArtifactSync` (trigger/gate) and `readReviewArtifact`. Both return
`null` on missing/invalid — never throw.

**Verdict invariant**: `computeVerdict(findings, blockingSeverity)` returns
`changes-required` iff ≥1 `status:'open'` finding ranks ≥ `blockingSeverity`
(`critical:3 > major:2 > minor:1`). The synthesized `critical`/`open` finding
guarantees the routed artifact is `changes-required` under this rule too, so the
explicit verdict and the computed verdict agree.

## Entity 2 — Validate failure evidence — REUSED

Captured in the validate-failure branch from the `PhaseResult`.

```ts
interface ValidateEvidence {
  stdout: string;   // result.capturedStdout ?? ''
  stderr: string;   // result.capturedStderr ?? result.error?.output ?? ''
  exitCode: number | null;
}
```

Feeds both the synthesized finding `detail` and the thin adapter's fix prompt.

## Entity 3 — `pendingValidateRemediation` (in-loop control) — NEW

Block-local variable in `PhaseLoop.executeLoop`. **Not persisted, not on
`WorkerContext`.** One-shot: set on synthesis, consumed at the remediate seam,
`undefined` otherwise.

```ts
type PendingValidateRemediation =
  | undefined
  | {
      evidence: ValidateEvidence;
      prNumber: number;
      baseBranch: string;   // 'origin/'-stripped
    };
```

Lifecycle within one uninterrupted loop:

1. `undefined` at loop start.
2. Set in the validate-failure branch after synthesis; `i` backtracks to `review`.
3. On the immediate `review` re-entry: while set → **skip**
   `runReviewConvergence` + `reviewExecutor.execute()`; the phase result is a
   synthetic success.
4. At the remediate seam: while set → run the thin adapter with its fields, then
   clear to `undefined`.
5. Next `review` re-entry: `undefined` → real delta-scoped executor runs (FR-003).

Not read across pause/resume; the persisted artifact (Entity 1) is authoritative
after a gate pause.

## Entity 4 — Fingerprint occurrence (derived) — REUSED

```ts
fingerprint = computeFailureFingerprint({ phase: 'validate', evidence });
priorCount  = failureFingerprintTracker.countPriorOccurrences(owner, repo, issue, fingerprint);
occurrence  = priorCount + 1;
// occurrence >= REPEAT_FAILURE_THRESHOLD (2) ⇒ failed:validate-repeated (terminal)
```

Counted from prior failure-alert comments on the issue. Recorded by
`postFailureAlert` (posted each routed red, without `onError('validate')`).

## Entity 5 — Thin adapter surface (`ValidateFixHandler`) — MODIFIED

Signature unchanged; behavior reduced (FR-005).

```ts
handle(
  item: QueueItem,
  checkoutPath: string,
  target: { prNumber: number; baseBranch: string },
  evidence: ValidateEvidence,
  github: GitHubClient,
  workflowName: string,
): Promise<void>;
```

- **Removed as live gates**: one-attempt-per-evidence-hash cap (superseded by
  `maxRemediations`); ownership of `failed:*` escalation (the loop owns it now).
- **Preserved**: evidence→fix prompt, commit, sibling-owned-file enumeration and
  revert-on-overlap guard (FR-010).

## Label vocabulary (all pre-existing — no additions)

| Label                          | When (routed path)                                    |
|--------------------------------|-------------------------------------------------------|
| `waiting-for:remediation-limit`| `on-remediation-limit` gate active (budget exhausted) |
| `agent:paused`                 | accompanies the exhaustion pause                      |
| `failed:validate-repeated`     | `occurrence >= REPEAT_FAILURE_THRESHOLD` (sole terminal failure) |
| ~~`failed:validate`~~          | **no longer applied on the routed path** (FR-009)     |
