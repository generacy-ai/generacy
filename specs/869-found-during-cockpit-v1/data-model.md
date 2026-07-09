# Data Model: PR-feedback trust-aware enqueue + dedupe-on-exit

**Feature**: `869-found-during-cockpit-v1`
**Date**: 2026-07-09

## Entities and Interfaces

### E1. `CommentTrustContext` (MODIFIED — additive)

**Module**: `packages/workflow-engine/src/security/comment-trust.ts`

Adds one optional field. Existing consumers (clarify answer-scanner, clarify resume prompt, PR-feedback reader) type-check unchanged.

```typescript
export interface CommentTrustContext {
  /** Bot login (GitHub App identity used for prompt-injection defense). */
  botLogin?: string;
  /**
   * NEW (#869 / FR-001): Resolved cluster GitHub identity — the acting
   * account the cockpit posts reviews as. Distinct from `botLogin` so that
   * SC-005's grep audit can distinguish "trusted because cluster identity"
   * from "trusted because bot".
   *
   * Populated by callers from `resolveClusterIdentity()` (packages/orchestrator/
   * src/services/identity.ts, the #830 chain). May be `undefined` on degraded
   * clusters (FR-007); the predicate treats absence as "no cluster-identity
   * trust rule fires" — association-tier trust still applies.
   */
  clusterIdentity?: string;
  config?: CommentTrustConfig;
  logger: Logger;
}
```

### E2. `TrustReason` union (MODIFIED — additive)

**Module**: same file.

```typescript
export type TrustReason =
  | 'owner'
  | 'member'
  | 'collaborator'
  | 'bot'
  | 'cluster-identity'   // NEW (#869 / FR-001)
  | 'widened-tier'
  | 'widened-login'
  | 'none-untrusted'
  | 'first-timer-untrusted'
  | 'first-time-contributor-untrusted'
  | 'mannequin-untrusted'
  | 'contributor-untrusted'
  | 'author-association-unset'
  | 'unknown-tier';
```

### E3. `isTrustedCommentAuthor` decision order (MODIFIED)

Existing decisions 1-7 preserved. New decision 1.5 (cluster-identity login match) fires before the tier lookup:

```text
1. Bot login match                     → trusted, reason='bot'
1.5 Cluster-identity login match       → trusted, reason='cluster-identity'   ← NEW
2. authorAssociation unset             → NOT trusted, reason='author-association-unset'
3. Default-trusted tier                → trusted, reason='owner'|'member'|'collaborator'
4. widen-config login (non-answer-scanner)  → trusted, reason='widened-login'
5. widen-config tier  (non-answer-scanner)  → trusted, reason='widened-tier'
6. Known untrusted tier                → NOT trusted, reason='none-untrusted'|...
7. Unknown tier                        → NOT trusted, reason='unknown-tier', WARN
```

**Validation**: cluster-identity match wins over `author_association: NONE` (the observed live case) — this is the entire point of FR-001. Tier `OWNER` on a comment authored by the cluster identity is trusted with `reason='cluster-identity'` (decision 1.5 fires before decision 3); note that decision 3 would *also* have trusted it, so the observable behavior is unchanged in the tie case, only the emitted reason string differs. Callers reading `reason` for diagnostics should not depend on the tie order.

### E4. `PrFeedbackMonitorService` — new fields (MODIFIED — additive)

**Module**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`

```typescript
export class PrFeedbackMonitorService {
  // ... existing fields ...

  /**
   * #869 / FR-004: Tracks whether each PR was in "zero-trusted" state on
   * the previous poll cycle. Keyed as `${owner}/${repo}#${prNumber}`.
   * On transition into zero-trusted (previous !== true), post the notice
   * (marker-checked). On transition out (previous === true, now trusted or
   * no unresolved), reset to false — allows a fresh notice on any future
   * re-entry.
   *
   * Not persisted: a monitor restart re-triggers the notice, which is
   * idempotency-safe via the FR-004 body marker check.
   */
  private lastZeroTrustedState: Map<string, boolean> = new Map();

  /**
   * #869 / FR-007: Resolved cluster identity — passed to the shared trust
   * predicate. Same value as `LabelMonitorService`'s clusterGithubUsername.
   * `undefined` triggers degraded FR-007 behavior in the handler; here it
   * just means the cluster-identity trust rule doesn't fire in the monitor's
   * pre-enqueue filter (association-tier trust still applies).
   */
  private readonly clusterIdentity: string | undefined;
}
```

### E5. `PrFeedbackHandler` — new constructor dependency (MODIFIED)

**Module**: `packages/orchestrator/src/worker/pr-feedback-handler.ts`

```typescript
export class PrFeedbackHandler {
  constructor(
    private readonly config: WorkerConfig,
    private readonly logger: Logger,
    private readonly agentLauncher: AgentLauncher,
    private readonly phaseTracker: PhaseTracker,        // NEW #869 / FR-006
    private readonly clusterIdentity: string | undefined, // NEW #869 / FR-001, FR-007
    private readonly sseEmitter?: SSEEventEmitter,
  ) {
    // ...
  }
}
```

`ClaudeCliWorkerDeps` (per `CLAUDE.md` #849 entry) already carries `phaseTracker?: PhaseTracker`. Wire the same `phaseTracker` (and the orchestrator-startup-resolved `clusterIdentity`) into the `new PrFeedbackHandler(...)` call at `claude-cli-worker.ts:265`. If `phaseTracker` is unavailable (older test injection), the handler falls back to a no-op clear (with a `warn` log line) — preserves testability without regressing observable behavior.

### E6. `PhaseTracker.clear` — no change

**Module**: `packages/orchestrator/src/types/monitor.ts`

Already exists in the interface (line 268). No modification needed:

```typescript
export interface PhaseTracker {
  isDuplicate(owner: string, repo: string, issue: number, phase: string): Promise<boolean>;
  markProcessed(owner: string, repo: string, issue: number, phase: string): Promise<void>;
  clear(owner: string, repo: string, issue: number, phase: string): Promise<void>;    // ← reused
  tryMarkProcessed(owner: string, repo: string, issue: number, phase: string): Promise<boolean>;
}
```

**Key format**: `phase-tracker:<owner>:<repo>:<issue>:address-pr-feedback` (produced by `PhaseTrackerService`, layout stable through #862 per spec-note in Q3-A).

## Type Definitions — New

### T1. `UntrustedNoticeMarker` constant

**Module**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`

```typescript
/**
 * FR-004 idempotency marker embedded in bot-authored top-level PR comments.
 * Grep-checked against `gh pr view --json comments` before posting to
 * guarantee one notice per zero-trusted episode. Marker format mirrors the
 * codebase's other idempotency markers (see `<!-- generacy-stage:… -->`,
 * `<!-- cockpit -->`, #865's marker).
 */
const UNTRUSTED_NOTICE_MARKER = '<!-- generacy:pr-feedback-untrusted-notice -->';
```

### T2. `PrTrustedComment` internal shape (monitor path)

Return shape of the monitor's pre-enqueue trust filter. Not exported.

```typescript
interface PrTrustFilterResult {
  /** Unresolved thread's `rootCommentId` list where at least one comment is trusted. */
  trustedUnresolvedThreadIds: number[];
  /**
   * Total unresolved threads observed (trusted + untrusted-only) — used
   * for both existing state-transition logging and FR-002/FR-003/FR-004
   * decision.
   */
  totalUnresolvedThreads: number;
  /**
   * Comment-level trust decisions for untrusted-only threads, keyed by
   * comment id. Populated only when at least one thread is fully untrusted;
   * used to build the FR-003 warn log and FR-004 notice body.
   */
  untrustedCommentSkips: Array<{
    commentId: number;
    author: string;
    authorAssociation: string | undefined;
    reason: TrustReason;
  }>;
}
```

## Validation Rules

### V1. Identity-unresolvable degradation (FR-007)

- **Input**: `clusterIdentity === undefined` at handler runtime and comments observed with no association-tier match.
- **Output**: `error`-level log line naming each chain link tried, then continue applying FR-002/FR-003/FR-004 unconditionally.
- **Forbidden**: throwing a `ClusterIdentityUnresolvedError` (Q4-C rejected); marking the worker failed; skipping the FR-002 loud retention (Q4-B rejected).

### V2. Notice idempotency (FR-004 / SC-004)

- **Precondition**: monitor detects transition into zero-trusted state on PR X.
- **Check**: fetch `gh pr view <n> --json comments --jq '.comments[].body'`; if any body contains `UNTRUSTED_NOTICE_MARKER`, skip posting.
- **Action**: `gh pr comment <n> --body "<marker>\n\n<user-visible text>"`; do not delete/edit prior notices (audit trail per Q2-A).
- **State**: set `lastZeroTrustedState[PR] = true`.
- **Reset**: on next transition out (trusted comment appears or unresolved drops to 0), set to `false`.
- **SC-004 counting**: ≤ 1 marker-carrying comment per PR per zero-trusted episode.

### V3. Handler exit-path invariant (FR-006 / SC-003)

Handler enters after monitor enqueue. Every terminal exit MUST invoke
`await phaseTracker.clear(owner, repo, issueNumber, 'address-pr-feedback')` exactly once:

| Exit path | Label state | Clear invoked? |
|-----------|-------------|----------------|
| Success (`success=true` at end) | Removed | **Yes** |
| Zero-trusted retention (race window) | Kept | **Yes** |
| CLI failed/timeout (`success=false` at end) | Kept | **Yes** |
| Uncaught exception in outer try | Untouched | **Yes** (in outer catch, before re-throw) |
| Non-critical exception in reply/label removal | Removed | **Yes** |

**Test**: unit test SC-003 asserts `phaseTracker.clear` invoked exactly once on each of the five paths.

### V4. Shared-predicate call-site audit (SC-005)

Grep audit at test time asserts that:
- `isTrustedCommentAuthor` has exactly one production import in `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`.
- `isTrustedCommentAuthor` has exactly one production import in `packages/orchestrator/src/worker/pr-feedback-handler.ts`.
- No inline `authorAssociation === 'OWNER' || …` checks exist in either file (grep for the raw string).

## Relationships

```text
resolveClusterIdentity() ─────► orchestrator startup ─────► WorkerConfig / ClaudeCliWorkerDeps
                                                                        │
                                                                        ▼
   PrFeedbackMonitorService.clusterIdentity ◄────────── same value threaded to both
                    │
                    │ processPrReviewEvent()
                    ▼
   isTrustedCommentAuthor(comment, 'pr-feedback', { clusterIdentity, botLogin, config, logger })
                    │
        ┌───────────┴───────────┐
        │ any-trusted           │ zero-trusted
        ▼                       ▼
   PhaseTracker.tryMarkProcessed()   → lastZeroTrustedState[PR] = true
        │                            → gh pr view --json comments (grep marker)
        │                            → if no marker: gh pr comment ...
        │                            → warn log with untrustedCommentSkips[]
        ▼
   Queue.enqueue()
        │
        ▼
   PrFeedbackHandler.handle()
        │
        │ isTrustedCommentAuthor(comment, 'pr-feedback', { clusterIdentity, botLogin, config, logger })
        │
   (same predicate — SC-005) — race-window fallback
        │
        ▼
   phaseTracker.clear() on every terminal path (FR-006 / SC-003)
```

## Interface Contracts

See `contracts/`:
- `trust-predicate.md` — `isTrustedCommentAuthor` extension + decision order.
- `monitor-decision.md` — `PrFeedbackMonitorService` trust-aware enqueue + zero-trusted transition + notice-posting.
- `handler-exit-paths.md` — `PrFeedbackHandler` dedupe-clear invariant + degraded-identity behavior.
