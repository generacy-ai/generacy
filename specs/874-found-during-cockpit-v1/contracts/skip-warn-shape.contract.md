# Contract: FR-005 skip-warn context shape

Two log sites gain the extended context. Field order/nomenclature is normative — downstream log-parsing tools (grafana boards, cockpit review UI) will grep against these field names.

## Site 1: `PrFeedbackMonitorService.pollRepo()` zero-trusted warn

**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:285`
**Message**: `'PR has unresolved threads but every comment author is untrusted'`
**Level**: `warn`

### Before (current shape)

```typescript
{
  owner, repo, prNumber, issueNumber,
  totalUnresolvedThreads,
  untrustedCommentSkips: [
    { commentId, author, authorAssociation, reason }
  ]
}
```

### After (FR-005 extension)

```typescript
{
  owner, repo, prNumber, issueNumber,
  totalUnresolvedThreads,
  clusterIdentity: string | null,              // NEW — raw provisioned value, null if unresolved
  normalizedClusterIdentity: string | null,    // NEW — normalizeLogin(clusterIdentity), null if unresolved
  untrustedCommentSkips: [
    {
      commentId, author, authorAssociation, reason,
      normalizedAuthor: string,                // NEW — normalizeLogin(author)
    }
  ]
}
```

## Site 2: `PrFeedbackHandler.handle()` zero-trusted-retention warn

**File**: `packages/orchestrator/src/worker/pr-feedback-handler.ts:263`
**Message**: `'Zero-trusted unresolved threads — retaining waiting-for:address-pr-feedback label (FR-002)'`
**Level**: `warn`

Same field additions as Site 1. The `untrustedSkips` array gains `normalizedAuthor` per element; the top-level context gains `clusterIdentity` and `normalizedClusterIdentity`.

## Site 3: `PrFeedbackHandler.handle()` per-skip info line

**File**: `packages/orchestrator/src/worker/pr-feedback-handler.ts:210`
**Message**: `'Skipped PR review comment from untrusted author'`
**Level**: `info` (unchanged)

### Before

```typescript
{
  event: 'comment-skipped',
  surface: 'pr-feedback',
  commentId, author, authorAssociation, reason,
}
```

### After

```typescript
{
  event: 'comment-skipped',
  surface: 'pr-feedback',
  commentId, author, authorAssociation, reason,
  normalizedAuthor: string,              // NEW
  clusterIdentity: string | null,        // NEW
  normalizedClusterIdentity: string | null,  // NEW
}
```

## Nullability convention

- `clusterIdentity: null` (JSON) — the resolver returned `undefined` (env var unset). Serialized as `null` in structured pino output.
- `clusterIdentity: '<string>'` — resolved value, pre-normalization.

Consumers grepping for "degraded mode" match `clusterIdentity: null`. Consumers grepping for "trust decision audit" match on the pair `(normalizedAuthor, normalizedClusterIdentity)`.

## SC-003 measurability

Any 10-minute log window with at least one zero-trusted skip contains:
- `clusterIdentity` on every skip entry (either raw value or `null`).
- `normalizedClusterIdentity` on every skip entry (either raw value or `null`).
- `normalizedAuthor` on every per-skip element inside `untrustedCommentSkips`.

The boot window contains exactly one `error`-level line naming `triedChain: ['CLUSTER_ACTING_LOGIN']` **iff** resolution returned nothing. Zero when resolution succeeded.

## Non-goals

- No PII redaction: GitHub logins are public identifiers.
- No emission on the happy path (trusted comments do not produce these lines — only the *skip* paths do).
- No pretty-printing of the normalized-form pair; the raw pair is available and callers can compute equality themselves.
