# Contract: `WORKFLOW_LABELS` description-length invariant

**Location**: `packages/workflow-engine/src/actions/github/__tests__/label-definitions.test.ts` (test)
**Source of truth**: `packages/workflow-engine/src/actions/github/label-definitions.ts` (`WORKFLOW_LABELS`)

## Invariant

For every entry `label ∈ WORKFLOW_LABELS`:

```
label.description.length <= 100
```

100 chars is GitHub's `createLabel` REST API limit on the `description` field. Exceeding it produces `HTTP 422 Validation Failed / description is too long (maximum is 100 characters)`.

## Failure surface

If any entry violates the invariant, the parameterized Vitest test in `label-definitions.test.ts` fails. CI's test job fails. Merge is blocked. This is the never-regress guarantee for a class of defect that was previously silent (see spec §Fix and #916).

## Test structure

```ts
import { describe, expect, it } from 'vitest';
import { WORKFLOW_LABELS } from '../label-definitions.js';

describe('WORKFLOW_LABELS description-length invariant', () => {
  it.each(WORKFLOW_LABELS)(
    '$name description is at most 100 characters',
    ({ name, description }) => {
      expect(description.length, `${name} description exceeds 100 chars (${description.length})`).toBeLessThanOrEqual(100);
    },
  );

  it('every WORKFLOW_LABELS entry satisfies the invariant', () => {
    // Bulk sanity check symmetric with `describe.each` above.
    const violations = WORKFLOW_LABELS.filter((l) => l.description.length > 100);
    expect(violations.map((l) => `${l.name}=${l.description.length}`)).toEqual([]);
  });
});
```

## Non-goals

- Not a general schema-validity check. Does not validate color codes, name uniqueness, or reserved-prefix hygiene — those are separate concerns.
- Does not test GitHub API behavior. The invariant is derived from GitHub's documented limit (spec §Assumptions confirms stability); the test is a client-side pre-flight, not an integration test.
- Does not run against arbitrary label arrays. Bound to `WORKFLOW_LABELS` — the single source of truth.

## Adding a new label

When adding a new `WORKFLOW_LABELS` entry:

1. Write the entry with a description ≤100 chars.
2. Run `pnpm --filter @generacy-ai/workflow-engine test src/actions/github/__tests__/label-definitions.test.ts`.
3. If the test fails, shorten the description and repeat.

The failure message names the offending label and its actual length, making iteration cheap.
