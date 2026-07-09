# Data Model

## Entities

### 1. Acting Identity (new concept)

A resolved GitHub login string representing the account that authors the cluster's cockpit-driven review comments. Distinct from the assignee identity.

**Source**: process env var `CLUSTER_ACTING_LOGIN`, provisioned by the scaffolder.

**Type**: `string | undefined`.

**Lifecycle**: resolved once during `createServer()`, cached for the process lifetime.

**Validation**:
- Non-empty after `trim()`.
- No structural validation on the login format itself (GitHub login rules aren't enforced at this layer).
- After normalization, expected to equal the normalized form of comment authors emitted by the cluster.

### 2. `ScaffoldEnvInput.actingLogin` (new field)

Optional field on `ScaffoldEnvInput` type in `packages/generacy/src/cli/commands/cluster/scaffolder.ts`.

```typescript
export interface ScaffoldEnvInput {
  // ...existing fields...
  actingLogin?: string;  // NEW — written as CLUSTER_ACTING_LOGIN=<value> when set
}
```

**Emission rule** in `scaffoldEnvFile()`: if `input.actingLogin` is set (truthy after trim), emit exactly one line:
```
CLUSTER_ACTING_LOGIN=${input.actingLogin}
```
Placed in the "Identity (from cloud LaunchConfig — do not edit)" section, directly below `GENERACY_ORG_ID`. No emission when unset (falls back to FR-006 at runtime).

### 3. `LaunchConfig.actingLogin` (new schema field)

Extension of `LaunchConfigSchema` in `packages/generacy/src/cli/commands/launch/types.ts`:

```typescript
export const LaunchConfigSchema = z.object({
  // ...existing fields...
  actingLogin: z.string().min(1).optional(),
});
```

**Cross-repo contract**: `generacy-cloud`'s `buildLaunchConfig` populates this field with the App bot slug (without `[bot]` suffix). Follow-up issue tracks this per FR-004 / Q5=A.

**Backwards compatibility**: field is optional; existing cloud responses that omit it are accepted (cluster boots without acting identity → FR-006 error line fires).

### 4. `normalizeLogin(raw: string): string`

Pure function exported from `packages/workflow-engine/src/security/comment-trust.ts`.

**Signature**:
```typescript
export function normalizeLogin(raw: string): string;
```

**Pipeline** (order matters):
1. `raw.trim()` — remove leading/trailing whitespace.
2. `.toLowerCase()` — case-insensitive comparison.
3. `.replace(/\[bot\]$/, '')` — strip the REST-form `[bot]` suffix.

**Post-condition**: return value is safe to compare with `===` against another normalized login.

**Edge cases**:
- Empty input → `''`.
- Whitespace-only → `''` after trim.
- `''` result does **not** match anything in the predicate — callers must guard.

### 5. `TrustDecision` (unchanged public shape, extended internal logic)

Existing shape in `packages/workflow-engine/src/security/comment-trust.ts`:

```typescript
export interface TrustDecision {
  trusted: boolean;
  reason: TrustReason;
}
```

The `'cluster-identity'` and `'bot'` reasons still exist and semantics don't change from a caller's perspective. Internally, both comparisons now go through `normalizeLogin()` on both sides.

### 6. Skip-warn context (FR-005 extension)

Existing `untrustedCommentSkips` array element in both `PrFeedbackMonitorService` and `PrFeedbackHandler` gains three new fields:

```typescript
interface UntrustedCommentSkip {
  commentId: number;
  author: string;
  authorAssociation: string | undefined;
  reason: TrustReason;
  normalizedAuthor: string;              // NEW — normalizeLogin(author)
}

interface SkipWarnContext {
  owner: string;
  repo: string;
  prNumber: number;
  issueNumber: number;
  totalUnresolvedThreads: number;
  untrustedCommentSkips: UntrustedCommentSkip[];
  clusterIdentity: string | null;         // NEW — raw provisioned value, or null when unresolved
  normalizedClusterIdentity: string | null; // NEW — normalizeLogin(clusterIdentity), or null when unresolved
}
```

### 7. FR-006 boot log line

Structured pino log entry emitted from `resolveActingIdentity()`:

```typescript
{
  level: 'error',
  triedChain: ['CLUSTER_ACTING_LOGIN'],
  outcome: 'unset-or-empty',
  msg: 'Acting identity unresolvable — cluster-identity trust rule will not fire. Set CLUSTER_ACTING_LOGIN to the App bot login (e.g., generacy-ai).',
}
```

Emitted at most once per process (called once at boot).

## Relationships

```
scaffoldEnvFile(input)  ──writes──► .env ("CLUSTER_ACTING_LOGIN=...")
                                     │
                                     │ docker compose env_file
                                     ▼
                              process.env['CLUSTER_ACTING_LOGIN']
                                     │
                                     │ read once at boot
                                     ▼
                        resolveActingIdentity(logger)  ──emits FR-006 log if unset──► pino error
                                     │
                                     │ normalized (Q3=C)
                                     ▼
                              actingIdentity: string | undefined
                                     │
                        ┌────────────┴────────────┐
                        ▼                         ▼
       PrFeedbackMonitorService     ClaudeCliWorker → PrFeedbackHandler
                        │                         │
                        └────────────┬────────────┘
                                     │
                                     │ ctx.clusterIdentity
                                     ▼
                     isTrustedCommentAuthor(comment, surface, ctx)
                                     │
                                     │ normalizeLogin(both sides)
                                     ▼
                              TrustDecision { trusted, reason }
                                     │
                                     ▼
                    if reason === 'cluster-identity': trust
                    else: skip warn with normalized-form pair (FR-005)
```

### Concept boundary

- **Acting identity** — used by trust predicate (`ctx.clusterIdentity`). Sourced from `CLUSTER_ACTING_LOGIN`. Never falls back to assignee chain (FR-007).
- **Assignee identity** — used by `filterByAssignee()`. Sourced from `CLUSTER_GITHUB_USERNAME` → `GH_USERNAME` → `gh api /user`. Untouched by this change.

The two never mix. `resolveActingIdentity()` and `resolveClusterIdentity()` are sibling functions with no shared code paths.
