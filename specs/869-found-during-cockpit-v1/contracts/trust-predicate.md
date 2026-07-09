# Contract: `isTrustedCommentAuthor` — cluster-identity extension

**Feature**: `869-found-during-cockpit-v1` (FR-001)
**Module**: `packages/workflow-engine/src/security/comment-trust.ts`
**Change type**: Additive to interface, additive to decision order.

## Signature (unchanged)

```typescript
export function isTrustedCommentAuthor(
  comment: Comment,
  surface: TrustSurface,
  ctx: CommentTrustContext,
): TrustDecision;
```

## Input contract

### `Comment` (unchanged)

Fields consulted:
- `comment.author: string` — GitHub login of the comment author.
- `comment.authorAssociation?: string` — GitHub author-association tier (`OWNER`, `MEMBER`, `COLLABORATOR`, `NONE`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `MANNEQUIN`, `CONTRIBUTOR`, or unknown).

### `CommentTrustContext` (extended)

Existing fields (`botLogin`, `config`, `logger`) unchanged. NEW:

- `clusterIdentity?: string` — resolved cluster GitHub login (the acting operator identity the cockpit posts as). Sourced from `resolveClusterIdentity()`. May be `undefined`.

### `TrustSurface` (unchanged)

`'answer-scanner' | 'clarify-resume' | 'pr-feedback'`. The cluster-identity rule fires on all three surfaces (parallel to `botLogin`) — no surface-specific gating. Rationale: the same acting identity posts across all cockpit surfaces; segmenting the rule would drift from the mental model.

## Output contract

Existing `TrustDecision` shape. `TrustReason` gains one variant: `'cluster-identity'`.

## Decision order (extended)

The new rule fires at position 1.5, between the existing bot-login match (decision 1) and the unset-authorAssociation guard (decision 2). Rationale: a `clusterIdentity` login match is trusted *regardless* of `authorAssociation`, matching the observed sub-defect (author is the cluster, tier is `NONE`, comment is a first-party feedback payload).

```text
1. Bot login match                        → trusted, reason='bot'
1.5 clusterIdentity present AND
    comment.author === clusterIdentity    → trusted, reason='cluster-identity'
2. authorAssociation unset/empty          → NOT trusted, reason='author-association-unset'
3. Default-trusted tier                   → trusted, reason='owner'|'member'|'collaborator'
4. widen-config login (non-answer-scanner) → trusted, reason='widened-login'
5. widen-config tier  (non-answer-scanner) → trusted, reason='widened-tier'
6. Known untrusted tier                   → NOT trusted, reason='none-untrusted'|...
7. Unknown tier                           → NOT trusted, reason='unknown-tier', WARN
```

## Reference implementation

```typescript
export function isTrustedCommentAuthor(
  comment: Comment,
  surface: TrustSurface,
  ctx: CommentTrustContext,
): TrustDecision {
  // 1. Bot login match — unchanged.
  if (ctx.botLogin && comment.author === ctx.botLogin) {
    return { trusted: true, reason: 'bot' };
  }

  // 1.5 Cluster-identity match — NEW (#869 / FR-001).
  //     Fires before tier gate so `author_association: NONE` on the cluster's
  //     own cockpit-posted review is trusted.
  if (ctx.clusterIdentity && comment.author === ctx.clusterIdentity) {
    return { trusted: true, reason: 'cluster-identity' };
  }

  const tier = comment.authorAssociation;

  if (tier === undefined || tier === null || tier === '') {
    return { trusted: false, reason: 'author-association-unset' };
  }

  const trustedReason = TIER_TO_TRUSTED_REASON[tier];
  if (trustedReason) {
    return { trusted: true, reason: trustedReason };
  }

  if (surface !== 'answer-scanner' && ctx.config) {
    const widenLogins = ctx.config.widen.logins;
    if (widenLogins.includes(comment.author)) {
      return { trusted: true, reason: 'widened-login' };
    }
    const widenTiers = ctx.config.widen.tiers;
    if (widenTiers.includes(tier)) {
      return { trusted: true, reason: 'widened-tier' };
    }
  }

  const untrustedReason = TIER_TO_UNTRUSTED_REASON[tier];
  if (untrustedReason) {
    return { trusted: false, reason: untrustedReason };
  }

  ctx.logger.warn('unrecognized author_association tier; treating as untrusted', {
    authorAssociation: tier,
    commentId: comment.id,
  });
  return { trusted: false, reason: 'unknown-tier' };
}
```

## Invariants

- **I1** (backward compatibility): callers passing no `clusterIdentity` observe the pre-#869 behavior byte-for-byte. `TrustReason` addition is additive — existing exhaustive-`switch` consumers gain one new case they can safely map to "trusted" (per the union structure).
- **I2** (pure function): no I/O, no env reads, no time reads. Identity resolution I/O is the caller's job.
- **I3** (cluster-identity beats association-unset): the observed live case has both — the extension makes the beat explicit and testable.
- **I4** (no regression on hostile edge case): a hostile attacker who spoofs `comment.author = clusterIdentity` cannot post a review because GitHub authenticates the review author against the API caller's identity. The predicate can trust the login field because GitHub's authenticated API guarantees it.

## Test contract

Unit test cases (add to `packages/workflow-engine/src/security/__tests__/comment-trust.test.ts`):

| # | Input | Expected |
|---|-------|----------|
| T1 | `author='cluster-app[bot]'`, `authorAssociation='NONE'`, ctx.`clusterIdentity='cluster-app[bot]'` | `{ trusted: true, reason: 'cluster-identity' }` |
| T2 | `author='cluster-app[bot]'`, `authorAssociation='OWNER'`, ctx.`clusterIdentity='cluster-app[bot]'` | `{ trusted: true, reason: 'cluster-identity' }` (decision 1.5 wins) |
| T3 | `author='alice'`, `authorAssociation='NONE'`, ctx.`clusterIdentity='cluster-app[bot]'` | `{ trusted: false, reason: 'none-untrusted' }` |
| T4 | `author='alice'`, `authorAssociation='NONE'`, ctx.`clusterIdentity=undefined` | `{ trusted: false, reason: 'none-untrusted' }` |
| T5 | `author='mybot'`, `authorAssociation='NONE'`, ctx.`botLogin='mybot'`, ctx.`clusterIdentity='alice'` | `{ trusted: true, reason: 'bot' }` (decision 1 fires first) |
| T6 | `author='mybot'`, `authorAssociation='NONE'`, ctx.`botLogin='mybot'`, ctx.`clusterIdentity='mybot'` | `{ trusted: true, reason: 'bot' }` (decision 1 still wins in the collision — deterministic) |
