# Data Model: Repeat-Identical Phase Failure Detection (#942)

## Types

### `FailureFingerprint`
```ts
/**
 * Stable derived string identifying a phase failure by its underlying defect.
 * Two failures produce the same fingerprint iff they share phase + classifier
 * + reason text (Q1→B default). Format: lowercase 16-char hex (sha256 prefix).
 */
export type FailureFingerprint = string;   // e.g. "9c4d3e2a1b0f8a7b"
```

Length is 16 hex chars — sufficient collision resistance for a per-issue bounded scan (< 100 alerts historically) and short enough to fit inline in the marker without pushing line 1 over reasonable width.

### `FailureFingerprintInput`
```ts
export interface FailureFingerprintInput {
  phase: WorkflowPhase | string;   // reused from types.ts — allows 'label-op' passthrough
  evidence: CommandExitEvidence;   // reused from types.ts
}
```

### Extended `FailureAlertData`
```ts
// packages/orchestrator/src/worker/types.ts — MODIFIED

export interface FailureAlertData {
  stage: StageType | 'label-op';
  runId: string;
  phase: WorkflowPhase | string;
  evidence: CommandExitEvidence;
  labelOp?: string;

  // NEW — populated by phase-loop.ts at every alert site.
  fingerprint: FailureFingerprint;

  // NEW — 1-based count including this occurrence. On the 2nd (Q3→A: N=2)
  // the escalation label is applied by phase-loop.ts BEFORE the alert post.
  occurrence: number;
}
```

Backwards-compat note: existing tests in `stage-comment-manager.test.ts` construct `BASE_ALERT` with the pre-#942 fields. The migration step in `plan.md` §"Implementation Sequence" step 2 adds `fingerprint: 'test-fp'` and `occurrence: 1` to `BASE_ALERT` so all existing suites keep passing without semantic change.

### Marker regex
```ts
// packages/orchestrator/src/worker/types.ts — NEW

/** Second HTML comment on failure-alert line 1. Matches v2 marker only. */
export const FAILURE_ALERT_MARKER_V2_REGEX =
  /<!-- fp:([0-9a-f]{16}):(\d+) -->/;
```

### Parser return type
```ts
// packages/orchestrator/src/worker/failure-fingerprint.ts — NEW

export interface ParsedFailureAlertMarker {
  fingerprint: FailureFingerprint;
  occurrence: number;
}

/**
 * Returns null for v1 (pre-#942) comments. Non-throwing.
 */
export function parseFailureAlertMarker(
  commentBody: string,
): ParsedFailureAlertMarker | null;
```

### Fingerprint tracker (Q2→A default)
```ts
// packages/orchestrator/src/services/failure-fingerprint-tracker.ts — NEW

export interface FailureFingerprintTracker {
  /**
   * Count of prior failure-alert comments on the issue whose parsed v2 marker
   * carries a matching fingerprint. Excludes the current in-flight failure
   * (call BEFORE postFailureAlert).
   *
   * Failure-tolerant: any thrown error → warn + return 0. Never propagates
   * (fail-open: escalation may be missed once, but the alert still posts and
   * the next failure will catch up).
   */
  countPriorOccurrences(
    owner: string,
    repo: string,
    issue: number,
    fingerprint: FailureFingerprint,
  ): Promise<number>;
}
```

### Q2→B/C alternative shape (contingency, not default)
Under Q2→B, the same interface is preserved, but the implementation is:
```ts
class RedisFailureFingerprintTracker implements FailureFingerprintTracker {
  constructor(private readonly redis: Redis | null, private readonly logger: Logger) {}

  async countPriorOccurrences(owner, repo, issue, fingerprint) {
    if (!this.redis) return 0;
    const key = `failure-fp:${owner}:${repo}:${issue}:${fingerprint}`;
    const count = await this.redis.incr(key);
    await this.redis.expire(key, 86400 * 30);   // 30d TTL — well past any active issue
    return count - 1;   // exclude the current increment from "prior"
  }
}
```

Under Q2→C, both implementations run and the Redis path is authoritative; the GitHub-scan path is invoked only when Redis is unavailable.

## LabelManager extension

```ts
// packages/orchestrator/src/worker/label-manager.ts — MODIFIED

class LabelManager {
  // ... existing methods ...

  /**
   * Called when a phase fails with the same fingerprint N or more times (N=2).
   * Supplements failed:<phase> — does NOT remove it (Q3→A).
   *
   * Idempotent: `applyLabels` de-dupes when label already present.
   */
  async onRepeatedError(phase: WorkflowPhase): Promise<void> {
    const escalationLabel = `failed:${phase}-repeated`;
    await this.retryWithBackoff(async () => {
      await this.ensureRepoLabelsExist();

      this.logger.info(
        { phase, issue: this.issueNumber, escalationLabel },
        `Repeat-identical failure escalation: adding ${escalationLabel}`,
      );

      await this.applyLabels([escalationLabel]);
    }, { site: 'error-repeated', labelOp: `addLabels([${escalationLabel}])` });
  }
}
```

## Constants

```ts
// packages/orchestrator/src/worker/failure-fingerprint.ts — NEW

/** Q3→A: escalate on the 2nd same-fingerprint failure. */
export const REPEAT_FAILURE_THRESHOLD = 2;

/** Q1→B: hex prefix length. 16 chars = 64 bits of entropy — sufficient for per-issue scan. */
export const FINGERPRINT_HEX_LENGTH = 16;
```

## Validation rules

- **Fingerprint is deterministic across runs**: `computeFailureFingerprint(input)` MUST return byte-identical output for two calls with structurally equal inputs. Guarded by unit test: pass a synthetic `CommandExitEvidence` twice, assert equality.
- **Fingerprint is sensitive to classifier**: two evidence blobs identical except for `exitDescriptor` classifier substring MUST produce different fingerprints. Guarded by unit test.
- **Fingerprint is stable under `runId` variation**: `runId` is NOT part of the tuple — different `runId`s with same phase+classifier+reason MUST produce the same fingerprint. This is the load-bearing invariant for the whole feature.
- **Marker parse is v1-tolerant**: `parseFailureAlertMarker` on a pre-#942 comment MUST return `null`, not throw.
- **Marker regex bounded**: the `\d+` occurrence field is bounded implicitly by "one alert per phase failure, one phase failure per queue cycle, ~months of failures" — 4 digits is the practical ceiling. No hard cap in the regex.
- **Tracker fail-open**: any transport error (GitHub 5xx, Redis TIMEOUT) → warn-log + return `0`. Never throws upward.

## Relationships

```
                                          ┌───────────────────────────┐
                                          │  phase-loop.ts (6 sites)  │
                                          └─────────────┬─────────────┘
                                                        │  buildErrorEvidence()
                                                        ▼
                                          ┌───────────────────────────┐
                                          │  CommandExitEvidence      │
                                          │  { command, exitDescriptor,│
                                          │    outputTail, reason? }  │
                                          └─────────────┬─────────────┘
                                                        │
                            ┌───────────────────────────┼───────────────────────────┐
                            ▼                           ▼                           ▼
              ┌──────────────────────┐    ┌──────────────────────────┐    ┌──────────────────┐
              │ computeFailure       │    │ tracker.countPrior       │    │ labelManager     │
              │   Fingerprint()      │    │   Occurrences(owner,     │    │   .onError()     │
              │ → FailureFingerprint │    │   repo, issue, fp)       │    │ → failed:<phase> │
              └─────────┬────────────┘    │ (scans getIssueComments) │    └────────┬─────────┘
                        │                 │ → prior: number          │             │
                        │                 └────────┬─────────────────┘             │
                        │                          │                                │
                        └────────┬─────────────────┴─────────┬──────────────────────┘
                                 ▼                           ▼
                    ┌──────────────────────┐   ┌────────────────────────────────┐
                    │ if occurrence ≥ 2:   │   │ postFailureAlert({             │
                    │   labelManager       │   │   ..., fingerprint, occurrence │
                    │     .onRepeatedError │──▶│ })                             │
                    │ → failed:<phase>     │   │ → v2 marker on line 1:         │
                    │        -repeated     │   │   <!-- fp:HEX:N -->            │
                    └──────────────────────┘   └────────────────────────────────┘
```
