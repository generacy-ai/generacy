# Contract: `normalizeLogin`

**Module**: `packages/workflow-engine/src/security/comment-trust.ts`

## Signature

```typescript
export function normalizeLogin(raw: string): string;
```

## Pipeline (order significant)

```typescript
raw.trim().toLowerCase().replace(/\[bot\]$/, '');
```

## Fixture matrix (SC-002 — 16 pairs)

Every (provisioned, observed) pair must produce equal `normalizeLogin()` outputs.

| # | provisioned         | observed              | normalized (both sides) |
|---|---------------------|-----------------------|-------------------------|
| 1 | `generacy-ai`       | `generacy-ai`         | `generacy-ai`           |
| 2 | `generacy-ai`       | `generacy-ai[bot]`    | `generacy-ai`           |
| 3 | `generacy-ai[bot]`  | `generacy-ai`         | `generacy-ai`           |
| 4 | `generacy-ai[bot]`  | `generacy-ai[bot]`    | `generacy-ai`           |
| 5 | `Generacy-AI`       | `generacy-ai`         | `generacy-ai`           |
| 6 | `Generacy-AI`       | `generacy-ai[bot]`    | `generacy-ai`           |
| 7 | `Generacy-AI[bot]`  | `generacy-ai`         | `generacy-ai`           |
| 8 | `Generacy-AI[bot]`  | `generacy-ai[bot]`    | `generacy-ai`           |
| 9 | ` generacy-ai `     | `generacy-ai`         | `generacy-ai`           |
|10 | ` generacy-ai `     | `generacy-ai[bot]`    | `generacy-ai`           |
|11 | ` generacy-ai[bot] `| `generacy-ai`         | `generacy-ai`           |
|12 | ` generacy-ai[bot] `| `generacy-ai[bot]`    | `generacy-ai`           |
|13 | ` Generacy-AI `     | `generacy-ai`         | `generacy-ai`           |
|14 | ` Generacy-AI `     | `generacy-ai[bot]`    | `generacy-ai`           |
|15 | ` Generacy-AI[bot] `| `generacy-ai`         | `generacy-ai`           |
|16 | ` Generacy-AI[bot] `| `generacy-ai[bot]`    | `generacy-ai`           |

## Negative fixtures

Neither side may compare equal after normalization when they refer to different accounts.

| # | provisioned         | observed              | expected equality |
|---|---------------------|-----------------------|-------------------|
| 1 | `generacy-ai`       | `generacy-cloud`      | not equal         |
| 2 | `generacy-ai`       | `generacy-ai-staging` | not equal         |
| 3 | `generacy-ai[bot]`  | `dependabot[bot]`     | not equal         |
| 4 | `generacy-ai`       | `christrudelpw`       | not equal — kills the FR-007 accidental widening |

## Empty / edge inputs

| input      | output |
|------------|--------|
| `''`       | `''`   |
| `'   '`    | `''`   |
| `'[bot]'`  | `''`   |
| `' [bot] '`| `''`   |
| `'A[BOT]'` | `'a[bot]'` — regex is case-sensitive on the literal `[bot]` marker (input `A[BOT]` post-lowercase becomes `a[bot]`, which then does match; validate this) |

**Note on the `A[BOT]` case**: `.toLowerCase()` runs before the regex, so `A[BOT]` becomes `a[bot]` and the strip fires. Result: `'a'`. Confirmed intended.

## Callers

- `packages/workflow-engine/src/security/comment-trust.ts:87` — `botLogin === comment.author` check becomes `normalizeLogin(ctx.botLogin) === normalizeLogin(comment.author)`.
- `packages/workflow-engine/src/security/comment-trust.ts:94` — `clusterIdentity === comment.author` check becomes `normalizeLogin(ctx.clusterIdentity) === normalizeLogin(comment.author)`.
- Skip-warn context (both callsites) — used to compute `normalizedAuthor` and `normalizedClusterIdentity` fields.

## Non-goals

- No Unicode normalization (GitHub logins are ASCII-only).
- No IDNA / punycode transform.
- No fuzzy matching (Levenshtein etc). Equality only.
