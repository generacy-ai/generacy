# Contract: `isTrustedCommentAuthor`

**Issue**: [#842](https://github.com/generacy-ai/generacy/issues/842)
**Data model**: [../data-model.md](../data-model.md)

## Signature

```ts
export function isTrustedCommentAuthor(
  comment: Comment,
  surface: TrustSurface,
  ctx: CommentTrustContext,
): TrustDecision;
```

## Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `comment.id` | `number` | yes | GitHub comment ID (for log correlation only; not read by the trust logic) |
| `comment.author` | `string` | yes | GitHub login of the comment author |
| `comment.authorAssociation` | `string?` | no | GitHub `author_association` value; unset → treated as untrusted (FR-011) |
| `surface` | `TrustSurface` | yes | One of `'answer-scanner' \| 'clarify-resume' \| 'pr-feedback'` |
| `ctx.botLogin` | `string?` | no | Cluster's own GitHub login; unset → association-tier trust only, no warn (D4) |
| `ctx.config` | `CommentTrustConfig?` | no | Widen-config; unset → default posture |
| `ctx.logger` | `Logger` | yes | Used only for the SC-008 `warn` on unknown tier |

## Output

```ts
{ trusted: boolean, reason: TrustReason }
```

`reason` is always populated (both trusted and untrusted). See `data-model.md` for the enum.

## Trust Decision Order

Applied in strict order — first match wins.

1. **Bot login match** (FR-012): `ctx.botLogin && comment.author === ctx.botLogin` → `{ trusted: true, reason: 'bot' }`.
2. **Unset `authorAssociation`** (FR-011): → `{ trusted: false, reason: 'author-association-unset' }`. No warn log.
3. **Default trusted tier**: `authorAssociation` in `['OWNER', 'MEMBER', 'COLLABORATOR']` → `{ trusted: true, reason: <tier-lowered> }`.
4. **Widen-config login match** (context surfaces only): `surface !== 'answer-scanner' && ctx.config?.widen.logins.includes(comment.author)` → `{ trusted: true, reason: 'widened-login' }`.
5. **Widen-config tier match** (context surfaces only): `surface !== 'answer-scanner' && ctx.config?.widen.tiers.includes(comment.authorAssociation)` → `{ trusted: true, reason: 'widened-tier' }`.
6. **Known untrusted tier** (`NONE`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `MANNEQUIN`, `CONTRIBUTOR`): → `{ trusted: false, reason: '<tier>-untrusted' }`. No warn log.
7. **Otherwise** (unknown / future tier): warn-log `{ authorAssociation, commentId: comment.id }` "unrecognized author_association tier; treating as untrusted" (SC-008). → `{ trusted: false, reason: 'unknown-tier' }`.

## Invariants

- **Pure function except for the SC-008 warn log** — no file I/O, no env reads, no network. All context comes through `ctx`.
- **Config is widen-only** — no code path allows removing `OWNER`/`MEMBER`/`COLLABORATOR` from trust. Steps 3 runs before any config check.
- **Answer-scanner ignores widen-config** — steps 4 and 5 short-circuit when `surface === 'answer-scanner'`.
- **Reason enum is closed** — no free-form strings. Callers can depend on the enum for log field cardinality.
- **Never throws** — every input shape returns a decision.

## Trust Matrix (table-driven test)

| `authorAssociation` | `surface` | `config.widen` | `botLogin` match | Expected |
|--------------------|-----------|----------------|-------------------|----------|
| `OWNER` | any | any | no | trusted, `owner` |
| `MEMBER` | any | any | no | trusted, `member` |
| `COLLABORATOR` | any | any | no | trusted, `collaborator` |
| `CONTRIBUTOR` | any | none | no | untrusted, `contributor-untrusted` |
| `CONTRIBUTOR` | `pr-feedback` | `{tiers:['CONTRIBUTOR']}` | no | trusted, `widened-tier` |
| `CONTRIBUTOR` | `clarify-resume` | `{tiers:['CONTRIBUTOR']}` | no | trusted, `widened-tier` |
| `CONTRIBUTOR` | `answer-scanner` | `{tiers:['CONTRIBUTOR']}` | no | untrusted, `contributor-untrusted` (SC-009) |
| `NONE` | any | any | no | untrusted, `none-untrusted` |
| `FIRST_TIME_CONTRIBUTOR` | any | any | no | untrusted, `first-time-contributor-untrusted` |
| `FIRST_TIMER` | any | any | no | untrusted, `first-timer-untrusted` |
| `MANNEQUIN` | any | any | no | untrusted, `mannequin-untrusted` |
| `NONE` | `pr-feedback` | `{logins:['alice']}` (author=alice) | no | trusted, `widened-login` |
| `NONE` | `answer-scanner` | `{logins:['alice']}` (author=alice) | no | untrusted, `none-untrusted` |
| unset | any | any | no | untrusted, `author-association-unset` |
| `SPONSOR` (future) | any | any | no | untrusted, `unknown-tier` + warn log (SC-008) |
| `NONE` | any | any | **yes** | trusted, `bot` (FR-012) |
| unset | any | any | **yes** | trusted, `bot` (FR-012) |

## Non-Goals

- Attachment / URL scanning (out of scope per spec).
- Following non-`OWNER`/`MEMBER`/`COLLABORATOR` attachments is a hard "no" enforced by prompt templates via `wrapUntrustedData` (FR-009), NOT by this helper. This helper decides trust for context ingestion; attachment-follow is a separate downstream check.
- Persisting trust decisions. Every call is fresh; there is no cache.
