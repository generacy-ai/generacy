# Data Model: Remediate phase executor (#1128)

## Modified entity — `ReviewArtifact` (review sidecar)

File: `<checkoutPath>/.generacy/review-findings-<sanitized-workflowId>.json`
Schema: `ReviewArtifactSchema` in `packages/orchestrator/src/worker/review-artifact.ts`.

### Added field

| Field | Type | Default | Reset on resume | Notes |
|-------|------|---------|-----------------|-------|
| `remediationCount` | `number` (int, ≥ 0) | `0` | **Yes** (→ 0) | Distinct from `round`. +1 per `remediate` execution (incl. timeouts). Caps the review↔remediate loop. |

### Unchanged fields (for context)

| Field | Type | Reset on resume | Notes |
|-------|------|-----------------|-------|
| `findings` | `ReviewFinding[]` | No | Open blocking subset feeds the remediation charter. |
| `verdict` | `'clean' \| 'changes-required'` | No | Engine-computed; gate conjunct. |
| `round` | `number` (int, ≥ 1) | **No — monotonic** | Required by #1126 delta-scoped re-review. Never touched by this issue. |
| `lastReviewedCommitSha` | `string` | No | Stamped by the review executor. |

### Zod change

```ts
export const ReviewArtifactSchema = z.object({
  findings: z.array(ReviewFindingSchema),
  verdict: VerdictSchema,
  round: z.number().int().positive(),
  lastReviewedCommitSha: z.string().min(1),
  remediationCount: z.number().int().nonnegative().default(0), // NEW
});
```

`.default(0)` is load-bearing: #1124 artifacts written before this deploy lack the field and must still parse (else `readReviewArtifact` returns `null` and the gate/seam break).

## New helpers — `review-artifact.ts`

```ts
/** Read → +1 → atomic write. Returns the new count. No-op returns 0 if artifact missing. */
export async function bumpRemediationCount(checkoutPath: string, workflowId: string): Promise<number>;

/** Read → set remediationCount = 0 → atomic write. No-op if artifact missing. */
export async function resetRemediationCount(checkoutPath: string, workflowId: string): Promise<void>;
```

Both reuse `readReviewArtifact` (null-safe) + `writeReviewArtifact` (temp+rename).

## New entity — `RemediateIntent` (launch intent)

File: `packages/generacy-plugin-claude-code/src/launch/types.ts`. Mirrors `ReviewIntent`.

```ts
export interface RemediateIntent {
  kind: 'remediate';
  issueNumber: number;   // logging/tracing
  prompt: string;        // engine-built remediation charter
  provider?: string;
  model?: string;
  effort?: Effort;
}
```

Added to `ClaudeCodeIntent` union; exported from `index.ts`.

## Charter input — `RemediateCharterInput`

File: `packages/orchestrator/src/worker/remediate-charter.ts` (new). Pure builder, no I/O.

```ts
export interface RemediateCharterInput {
  findings: ReviewFinding[];      // open blocking findings only
  round: number;                  // current review round (for context)
  remediationCount: number;       // attempt N (for the agent's awareness)
  blockingSeverity: 'critical' | 'major' | 'minor';
}
```

Charter structure (findings-only now; validate-evidence section admittable later per Q2=A):
1. Title + attempt/round context.
2. **"Findings to address"** — one block per finding: `severity`, `file[:line]`, `title`, `detail`.
3. Instruction: make the code changes to fix these findings; do **not** resolve review threads, do **not** mark the PR ready — verification happens in the next review round.
4. (Reserved) "Validate failures to fix" — absent this issue; #1129 appends.

## Gate predicate (re-keyed)

`phase-loop.ts` `on-remediation-limit` branch:

```
gateActive =
  artifact !== null &&
  artifact.remediationCount >= maxRemediations &&   // was: artifact.round
  artifact.verdict === 'changes-required';
```

`maxRemediations` from `resolveWorkflowOverrides(config, deps.settings, workflowName)`: `speckit-feature` → 3, `speckit-bugfix` → 2.

## Label vocabulary

| Label | State | Registered in |
|-------|-------|---------------|
| `waiting-for:remediation-limit` | gate (exists, #1124) | `label-definitions.ts:46` |
| `agent:paused` | gate (exists) | existing |
| `completed:remediation-limit` | **NEW** satisfaction | `label-definitions.ts` (add) |

## Gate mapping (unchanged, FR-010)

`GATE_MAPPING['remediation-limit'] = { phase: 'review', resumeFrom: 'review' }` — verified `phase-resolver.ts:17`. No change.
