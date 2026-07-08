# Contract: `PullRequestDetail.headRepositoryOwner`

**Location**: `packages/cockpit/src/gh/wrapper.ts:48-61` (interface); raw schema at `wrapper.ts:186-210`; assembly at `wrapper.ts:780-796`.

## Field

```typescript
export interface PullRequestDetail {
  // …existing fields…
  headRepositoryOwner: string | null;
  // …existing fields…
}
```

## Semantics

| Value              | Meaning                                                                    |
|--------------------|----------------------------------------------------------------------------|
| `string` (login)   | The org/user login that owns the head repo. Compare to base owner for fork.|
| `null`             | Head fork has been deleted after the PR was opened.                        |

## Data flow

**Source**: `gh pr view <N> --repo <repo> --json headRepositoryOwner` — returns `{ "headRepositoryOwner": { "login": "…", ... } | null }`.

**Wrapper JSON field list expansion**: `getPullRequestDetail`'s `--json` argument gains `headRepositoryOwner`:
```
number,title,url,baseRefName,headRefName,headRepositoryOwner,body,author,state,isDraft,labels
```
(11 fields, up from 10.)

**Raw schema**:
```typescript
const PullRequestDetailRawSchema = z.object({
  // …existing fields…
  headRepositoryOwner: z
    .object({ login: z.string() })
    .passthrough()
    .nullable()
    .optional(),
  // …existing fields…
});
```

**Extraction to public shape**:
```typescript
return {
  // …existing fields…
  headRepositoryOwner: detail.data.headRepositoryOwner?.login ?? null,
  // …existing fields…
};
```

## Caller usage (`runMerge`)

**Cross-fork pre-check** (deterministic):
```typescript
const isCrossFork =
  pr.headRepositoryOwner != null &&
  pr.headRepositoryOwner !== issueRef.owner;
```

- `null` → NOT cross-fork (attempt the delete; any residual error → `delete-failed`).
- Non-null and equal to `issueRef.owner` → NOT cross-fork.
- Non-null and different from `issueRef.owner` → cross-fork; skip delete.

## Test fixtures (SC pins)

### SC-200 — same-owner PR

`gh pr view` stdout includes:
```json
{"headRepositoryOwner":{"login":"acme"},"baseRefName":"main", …}
```
Wrapper returns `PullRequestDetail` with `headRepositoryOwner: "acme"`. `runMerge` for `repo: "acme/widget"` computes `isCrossFork === false`.

### SC-201 — cross-fork PR

`gh pr view` stdout includes:
```json
{"headRepositoryOwner":{"login":"contributor42"},"baseRefName":"main", …}
```
Wrapper returns `PullRequestDetail` with `headRepositoryOwner: "contributor42"`. `runMerge` for `repo: "acme/widget"` computes `isCrossFork === true`; skips `deleteHeadRef`.

### SC-202 — deleted head fork

`gh pr view` stdout includes:
```json
{"headRepositoryOwner":null,"baseRefName":"main", …}
```
Wrapper returns `PullRequestDetail` with `headRepositoryOwner: null`. `runMerge` computes `isCrossFork === false` (falls through to `deleteHeadRef` call — outcome depends on gh's response).

## Backwards compatibility

- **Source-additive**: new field on an existing interface. TypeScript consumers that destructure without the field are unaffected.
- **Wire-additive**: `gh pr view` returns `headRepositoryOwner` even on older gh versions (verified back to gh 2.14 — well below the pinned floor of 2.96).
- **No shim needed**: no removed field; no renamed field.

## Non-changes

- The `PullRequestDetail.base` and `PullRequestDetail.head` fields (ref names) stay as-is. `headRepositoryOwner` is orthogonal — it identifies the *repo* the head lives in, not the *ref* name.
- Existing consumers (`context.ts` review-context payload assembly, cockpit's other verbs) neither read nor render `headRepositoryOwner`. No downstream ambiguity from the widening.
