# Data Model: Author-trust gating for workflow-ingested GitHub comments

**Issue**: [#842](https://github.com/generacy-ai/generacy/issues/842)
**Plan**: [plan.md](./plan.md)

## Entity Extensions

### `Comment` (extended)

Location: `packages/workflow-engine/src/types/github.ts`

```ts
export interface Comment {
  id: number;
  body: string;
  author: string;
  created_at: string;
  updated_at: string;

  // PR review comment fields (existing)
  path?: string;
  line?: number;
  in_reply_to_id?: number;
  resolved?: boolean;

  // NEW in #842 — GitHub author_association from REST API.
  // Nullable for fixture / cache / older-response compatibility (FR-011:
  // unset → treated as untrusted, no warn).
  authorAssociation?: string;
}
```

**Validation**: none (free-form string). Trust helper validates against known enums.

**Backwards-compat**: nullable. Existing fixtures and cached objects that don't set this field are treated as untrusted by the helper (fail-closed) without any migration.

## New Entities

### `TrustSurface`

Location: `packages/workflow-engine/src/security/comment-trust.ts`

```ts
export type TrustSurface = 'answer-scanner' | 'clarify-resume' | 'pr-feedback';
```

Enumerates the three ingestion surfaces. Passed into the trust helper so the answer-scanner path can ignore the widen-config (FR-008 / Q4).

### `CommentTrustConfig`

Location: `packages/workflow-engine/src/security/comment-trust-config.ts`

```ts
import { z } from 'zod';

export const CommentTrustConfigSchema = z.object({
  widen: z.object({
    tiers: z.array(z.string()).default([]),
    logins: z.array(z.string()).default([]),
  }).default({ tiers: [], logins: [] }),
}).strict();

export type CommentTrustConfig = z.infer<typeof CommentTrustConfigSchema>;
```

**Loader**: `tryLoadCommentTrustConfig(workspaceDir: string): CommentTrustConfig | undefined`
- Reads `<workspaceDir>/.agency/comment-trust.yaml`.
- Missing file → `undefined` (default posture).
- Malformed YAML → warn-log, `undefined` (default posture, no throw).
- Schema violation → warn-log naming the failed field, `undefined`.
- Extra top-level keys (`.strict()`) → schema violation (protects against typos like `wide:` silently no-op'ing).

**Semantics**:
- `widen.tiers`: additive to the default `[OWNER, MEMBER, COLLABORATOR]` — applied only to context surfaces.
- `widen.logins`: additive login-level allowlist — applied only to context surfaces.
- Neither list can remove default-trusted tiers.
- Empty object `{}` / missing `widen` → same as default posture.

### `CommentTrustContext`

Location: `packages/workflow-engine/src/security/comment-trust.ts`

```ts
export interface CommentTrustContext {
  botLogin?: string;              // Resolved via identity.ts chain in orchestrator startup
  config?: CommentTrustConfig;    // Loaded from .agency/comment-trust.yaml
  logger: Logger;                 // For SC-008 warn on unknown tier
}
```

The helper is a pure function; `logger` is the only side-effect surface (the SC-008 `warn` on unknown tiers). The helper does not read files or env vars.

### `TrustDecision`

Location: `packages/workflow-engine/src/security/comment-trust.ts`

```ts
export type TrustReason =
  | 'owner'
  | 'member'
  | 'collaborator'
  | 'bot'
  | 'widened-tier'
  | 'widened-login'
  | 'none-untrusted'
  | 'first-timer-untrusted'
  | 'first-time-contributor-untrusted'
  | 'mannequin-untrusted'
  | 'contributor-untrusted'
  | 'author-association-unset'
  | 'unknown-tier';

export interface TrustDecision {
  trusted: boolean;
  reason: TrustReason;
}
```

**Callers use `reason` in the FR-010 skip-log line.** No free-form `reason` — enum ensures the log field is countable and testable.

### `SkipLogRecord` (shape convention, not a type)

Location: emitted by callers; documented here as a contract per FR-010 / SC-003.

```ts
{
  event: 'comment-skipped',
  surface: TrustSurface,
  commentId: number,
  author: string,
  authorAssociation: string | undefined,
  reason: TrustReason,
}
```

**Invariant**: No `body` / `comment` / other body-carrying field. Unit tests assert absence.

## Modified Entities

### `ReadPRFeedbackOutput` (extended)

Location: `packages/workflow-engine/src/types/github.ts`

```ts
export interface ReadPRFeedbackOutput {
  comments: Comment[];              // EXISTING — now contains only trusted comments (FR-006)
  has_unresolved: boolean;
  unresolved_count: number;

  // NEW in #842 — untrusted comments partitioned for logging (not surfaced to agent).
  skippedComments?: Array<{
    commentId: number;
    author: string;
    authorAssociation?: string;
    reason: TrustReason;
  }>;
}
```

**Backwards-compat**: `skippedComments` optional. Existing callers see the same `comments` shape but with untrusted entries removed (behavior change, not shape change).

## Relationships

```
+----------------------------------+
| gh-cli.ts (GhCliGitHubClient)    |
| - getIssueComments               |
| - getPRComments                  |
+---------------+------------------+
                |
                | Comment { ... , authorAssociation? }
                v
   +---------------------------+     reads     +--------------------------------------+
   | Three ingestion surfaces  +-------------->+ isTrustedCommentAuthor(comment, ...) |
   | - answer-scanner          |               +----+---------------------------------+
   | - clarify-resume          |                    | uses
   | - pr-feedback             |                    v
   +-----------+---------------+          +--------------------------------+
               |                          | CommentTrustContext            |
               | fenced/filtered          |  - botLogin (from identity.ts) |
               v                          |  - config (from .agency)       |
   +---------------------------+          |  - logger                      |
   | wrapUntrustedData()       |          +--------------------------------+
   +---------------------------+
```

**Ownership**:
- `Comment.authorAssociation`: source-of-truth is the GitHub REST API; `gh-cli.ts` reads it, workflow-engine consumes it. Not persisted anywhere (transient per fetch).
- `CommentTrustConfig`: source-of-truth is `.agency/comment-trust.yaml` (repo-committed). Loaded once per action invocation.
- `botLogin`: source-of-truth is the orchestrator's `identity.ts` chain. Resolved once at startup and cached; passed into workflow-engine via `ActionContext`.

## Validation Rules Summary

| Rule | Where enforced | Test |
|------|----------------|------|
| Unset `authorAssociation` → untrusted | `isTrustedCommentAuthor` | `comment-trust.test.ts` |
| Unknown tier → untrusted + `warn` log | `isTrustedCommentAuthor` | `comment-trust.test.ts` (SC-008) |
| Config cannot remove default tiers | `isTrustedCommentAuthor` (defaults applied first, config added second) | `comment-trust.test.ts` |
| Answer-scanner ignores widen-config | `isTrustedCommentAuthor` (checks `surface` before reading `config`) | `comment-trust.test.ts` (SC-009) |
| Bot login always trusted regardless of tier | `isTrustedCommentAuthor` (login match short-circuits before tier check) | `comment-trust.test.ts` |
| Malformed config → default posture | `tryLoadCommentTrustConfig` | `comment-trust-config.test.ts` |
| Extra top-level keys rejected | Zod `.strict()` | `comment-trust-config.test.ts` |
| Skip-log has no body field | Each call site | `clarification-poster-trust.test.ts`, `pr-feedback-trust.test.ts` |
| `Q<N>:` skip → bot explainer comment | `clarification-poster.ts` | `clarification-poster-trust.test.ts` (SC-007) |
| Bot explainer idempotent | Marker comment `<!-- generacy-untrusted-answer:<commentId> -->` | `clarification-poster-trust.test.ts` |
