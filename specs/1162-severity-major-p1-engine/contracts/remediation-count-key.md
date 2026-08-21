# Contract: Remediation-count Redis persistence (FR-003)

**Store**: `PhaseTracker` (`getValueRaw` / `setValueRaw` / `clearRaw`), best-effort no-op
when Redis is unavailable.
**Sites**: `packages/orchestrator/src/worker/phase-loop.ts` (mirror, reconcile, reset) +
a new `seedRemediationCount` helper in `review-artifact.ts`.

## Key

```
remediation-count:${owner}:${repo}:${issueNumber}:${branch}
```

- `branch = context.branch ?? 'no-branch'` (mirrors the `review-findings:` key shape).
- Value: decimal string of `remediationCount`.
- TTL: `PHASE_START_REF_TTL_SECONDS` (7 days).

## Operations

| Trigger                                   | Action |
|-------------------------------------------|--------|
| Remediate executor returns (phase-loop seam) | read post-bump disk count → `setValueRaw(key, String(count), TTL)` |
| `on-remediation-limit` gate entry (re-entry) | `redis = getValueRaw(key)`; if `redis > disk` → `seedRemediationCount(disk := redis)` before `readReviewArtifactSync` |
| `completed:remediation-limit` resume       | `resetRemediationCount` (disk := 0) **and** `clearRaw(key)` |

## Guarantees

- **G1 (FR-003 / SC-003)**: After a worker restart or fresh re-clone (disk sidecar absent),
  the gate observes the remediation count spent before the restart. The cap fires at the
  same effective attempt count as before the fix.
- **G2**: Reconcile never lowers a spent budget — effective count = `max(disk, redis)`.
- **G3**: When Redis is down, all three operations degrade to no-op/null; behavior falls back
  to the current disk-only semantics (no crash, no false cap).
- **G4**: The synchronous gate reader (`readReviewArtifactSync`) is unchanged — reconcile
  seeds the disk sidecar so the existing read observes the durable value.
- **G5**: The remediate executor and `bumpRemediationCount` / `resetRemediationCount` fs
  helpers stay Redis-free (all tracker I/O is in the phase-loop layer).

## Test assertions

- SC-003: persist count = N via the mirror; simulate re-clone (delete disk sidecar); on gate
  entry the reconciled count = N and the cap fires correctly.
- Redis-down: `getValueRaw` returns null ⇒ gate uses disk value ⇒ no crash.
- Reset: `completed:remediation-limit` ⇒ disk = 0 and `clearRaw` invoked.
