# Data Model: Remove hardcoded 999 cap in createFeature()

## Affected Types

### `CreateFeatureInput` (types.ts:32-43)

```typescript
export interface CreateFeatureInput {
  description: string;
  short_name?: string;
  number?: number;        // JSDoc change: remove "(1-999)" range
  parent_epic_branch?: string;
  cwd?: string;
}
```

**Change**: JSDoc on `number` field updated from `(1-999)` to unrestricted.

### `CreateFeatureOutput` (types.ts:150-163)

```typescript
export interface CreateFeatureOutput {
  success: boolean;
  branch_name: string;
  feature_num: string;
  spec_file: string;
  feature_dir: string;
  git_branch_created: boolean;
  branched_from_epic?: boolean;
  parent_epic_branch?: string;
  base_commit?: string;
  error?: string;          // No type change — ensure all failure paths populate this
}
```

**Change**: No structural change. Behavioral contract: all `success: false` returns must include a non-empty `error` string.

## Validation Rules

- `featureNumInt`: No upper bound. Lower bound implicitly >= 1 (from `getNextFeatureNumber` or `input.number`).
- `branchName`: Must match `FEATURE_NAME_PATTERN` (`/^\d+-[a-z0-9]+(?:-[a-z0-9]+)*$/`).
- Branch length: Must be <= `MAX_BRANCH_LENGTH` (244 chars). Not explicitly checked in current code but enforced by git.
