# Contract: `FailureFingerprintTracker`

**Location**: `packages/orchestrator/src/services/failure-fingerprint-tracker.ts` (NEW)

## Interface

```ts
export interface FailureFingerprintTracker {
  countPriorOccurrences(
    owner: string,
    repo: string,
    issue: number,
    fingerprint: FailureFingerprint,
  ): Promise<number>;
}
```

## Default implementation (Q2→A — GitHub comment scan)

```ts
export class GitHubCommentFailureFingerprintTracker implements FailureFingerprintTracker {
  constructor(
    private readonly github: GitHubClient,
    private readonly logger: Logger,
  ) {}

  async countPriorOccurrences(owner, repo, issue, fingerprint) {
    try {
      const comments = await this.github.getIssueComments(owner, repo, issue);
      let count = 0;
      for (const c of comments) {
        if (!c.body.startsWith(FAILURE_ALERT_MARKER_PREFIX)) continue;
        const parsed = parseFailureAlertMarker(c.body);
        if (parsed?.fingerprint === fingerprint) count++;
      }
      return count;
    } catch (err) {
      this.logger.warn(
        { err: String(err), owner, repo, issue, fingerprint },
        'Failed to scan issue comments for fingerprint history; treating as first occurrence',
      );
      return 0;
    }
  }
}
```

## Alternative implementation (Q2→B — Redis)

```ts
export class RedisFailureFingerprintTracker implements FailureFingerprintTracker {
  constructor(
    private readonly redis: Redis | null,
    private readonly logger: Logger,
  ) {}

  async countPriorOccurrences(owner, repo, issue, fingerprint) {
    if (!this.redis) {
      this.logger.warn('Redis unavailable for failure fingerprint tracker, treating as first occurrence');
      return 0;
    }
    const key = `failure-fp:${owner}:${repo}:${issue}:${fingerprint}`;
    try {
      const raw = await this.redis.get(key);
      return raw ? parseInt(raw, 10) : 0;
    } catch (err) {
      this.logger.warn({ err, key }, 'Redis read failed, treating as first occurrence');
      return 0;
    }
  }

  /** Called by phase-loop.ts AFTER escalation decision (so prior count is authoritative). */
  async recordOccurrence(owner, repo, issue, fingerprint) {
    if (!this.redis) return;
    const key = `failure-fp:${owner}:${repo}:${issue}:${fingerprint}`;
    try {
      await this.redis.incr(key);
      await this.redis.expire(key, 86400 * 30);   // 30d TTL
    } catch (err) {
      this.logger.warn({ err, key }, 'Redis write failed, counter may be stale');
    }
  }
}
```

## Wiring (server.ts)

Under Q2→A (default), constructor is:
```ts
const failureFingerprintTracker = new GitHubCommentFailureFingerprintTracker(github, server.log);
// pass into ClaudeCliWorkerDeps or PhaseLoop deps
```

Under Q2→B, needs Redis client + a `recordOccurrence` call in `phase-loop.ts` after the escalation decision.

Under Q2→C, wrap the Redis impl with a Github-scan fallback in the `catch` branch.

## Invariants

- **INV-T1** — `count === 0` for a first-ever failure with a novel fingerprint on the issue.
- **INV-T2** — `count === N` for the `(N+1)`th same-fingerprint failure (counts the N prior comments, EXCLUDES the current in-flight one — the caller invokes `countPriorOccurrences` BEFORE `postFailureAlert`).
- **INV-T3** — Failure of the underlying storage (GitHub 5xx / Redis timeout) returns `0`, never throws.
- **INV-T4** — Non-marker comments and v1-only markers are silently skipped (no throw, no false count).
- **INV-T5** — Ordering-independent: the returned count does not depend on comment insertion order (a fingerprint appearing 3× in any position on the issue returns `3`).

## Cost model

- Q2→A: 1 `getIssueComments` API call per terminal failure. Typical page size: 100 comments; issue-scoped, so bounded by human+bot activity on the specific issue. Rate limit budget: comfortable (existing `postFailureAlert` already calls `getIssueComments` at line 340 — this is a shared code path, opportunity for refactoring to reuse the fetch in a follow-up).
- Q2→B: 1 `GET` per terminal failure (~<1ms). Requires `INCR` + `EXPIRE` on the write path (2 more Redis ops).
- Q2→C: same as B for the fast path; A for the fallback.

## Reuse of `getIssueComments`

`stage-comment-manager.postFailureAlert` already calls `getIssueComments(owner, repo, issue)` at line 340 for its runId-dedup check. A future refactor could hoist this fetch and pass the comment array into both the tracker and the dedup check — one API call instead of two. **This refactor is out of scope for #942** (kept as a follow-up to keep the diff surface small and reversible), but the tracker interface accepts the raw comments call chain, so the extraction is a signature-preserving change.
