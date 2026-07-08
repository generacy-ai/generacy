# Contract: ESLint `no-restricted-imports` rule for `parseIssueRef`

**File**: `.eslintrc.json` (repo root)
**Related**: FR-006, Q1 → C in [clarifications.md](../clarifications.md), [contracts/parse-issue-ref.md](./parse-issue-ref.md).

## Purpose

Prevent any cockpit subcommand from silently regressing to `parseIssueRef` in isolation (bypassing `resolveIssueContext`'s cwd-origin inference). Fires in-editor at the moment of the mistake — before commit, before CI, before the user sees a "bare-number rejected" surprise.

## Rule shape

Added as a new `overrides` entry in `.eslintrc.json`, positioned after the existing per-file-allow-list `overrides` (currently at lines 33-72):

```json
{
  "files": ["packages/generacy/src/cli/commands/cockpit/**/*.ts"],
  "excludedFiles": [
    "packages/generacy/src/cli/commands/cockpit/resolver.ts",
    "packages/generacy/src/cli/commands/cockpit/__tests__/**"
  ],
  "rules": {
    "no-restricted-imports": ["error", {
      "paths": [
        {
          "name": "child_process",
          "message": "Direct child_process usage is forbidden. Use ProcessFactory or AgentLauncher instead. See #437."
        },
        {
          "name": "node:child_process",
          "message": "Direct child_process usage is forbidden. Use ProcessFactory or AgentLauncher instead. See #437."
        },
        {
          "name": "./resolver.js",
          "importNames": ["parseIssueRef"],
          "message": "Import `resolveIssueContext` from './resolver.js' instead. `parseIssueRef` is a strict qualified-forms parser — cockpit verbs must go through `resolveIssueContext` so bare-number cwd-origin inference works uniformly. See #850."
        }
      ]
    }]
  }
}
```

### Why the existing `child_process` entries are carried forward

ESLint `overrides` **replace** the parent config's rule value; they do not merge. The root `.eslintrc.json:20-32` already restricts `child_process` and `node:child_process`. Without carrying those forward in the cockpit override, we would silently re-permit them in the cockpit directory.

### Why `paths[]` and not `patterns[]`

The two current call sites (`advance.ts:32`, `context.ts:27`) both use the exact relative specifier `./resolver.js`. `paths[]` matches by exact module name, which is deterministic and gives a clean error message. If a future cockpit-adjacent file lands with a different relative path (`../resolver.js`), the rule would need to be re-scoped — either add the new specifier to `paths[]`, or switch to `patterns[]` (see fallback below).

### Fallback rule shape (if `paths[].importNames` is unsupported)

If the CI lint step rejects `importNames` under `paths[]` (unlikely on ESLint 8+, but the top-level config doesn't pin a version), swap to the `patterns[]` form:

```json
{
  "files": ["packages/generacy/src/cli/commands/cockpit/**/*.ts"],
  "excludedFiles": [
    "packages/generacy/src/cli/commands/cockpit/resolver.ts",
    "packages/generacy/src/cli/commands/cockpit/__tests__/**"
  ],
  "rules": {
    "no-restricted-imports": ["error", {
      "paths": [
        { "name": "child_process", "message": "…" },
        { "name": "node:child_process", "message": "…" }
      ],
      "patterns": [
        {
          "group": ["**/resolver.js"],
          "importNames": ["parseIssueRef"],
          "message": "Import `resolveIssueContext` from './resolver.js' instead. See #850."
        }
      ]
    }]
  }
}
```

Trade-off: `patterns[].group` is a glob that matches any import path ending in `resolver.js`. Under the current cockpit-directory glob there is no other `resolver.js`, so behavior is identical. Default to `paths[]` for the more specific match; only switch if forced.

## Scope

- **Enforced**: any `.ts` file under `packages/generacy/src/cli/commands/cockpit/` except `resolver.ts` itself and files under `__tests__/`.
- **Not enforced** (via `excludedFiles`):
  - `resolver.ts` — defines `parseIssueRef` and calls it internally from `resolveIssueContext`.
  - `__tests__/**` — the unit tests for `resolver.ts` legitimately import both `parseIssueRef` and `resolveIssueContext`.
- **Not touched**: files outside the cockpit directory. This rule is *scoped* to the regression class it targets; broader lint policy is out of scope.

The root `.eslintrc.json:62-71` already disables `no-restricted-imports` for `**/__tests__/**`, `**/tests/**`, `**/*.test.ts`, `**/*.spec.ts`. The `excludedFiles` block here documents intent explicitly and survives future test-glob changes.

## What the rule catches

Positive cases (rule fires):
```ts
// packages/generacy/src/cli/commands/cockpit/advance.ts
import { parseIssueRef } from './resolver.js';                // ❌ error
import { parseIssueRef, type IssueRef } from './resolver.js'; // ❌ error (multi-name form)
import { parseIssueRef as pir } from './resolver.js';         // ❌ error (alias)
```

Negative cases (rule silent):
```ts
// packages/generacy/src/cli/commands/cockpit/advance.ts
import { resolveIssueContext, type IssueRef } from './resolver.js';  // ✓
import { type IssueRef } from './resolver.js';                        // ✓
import type { IssueRef } from './resolver.js';                        // ✓

// packages/generacy/src/cli/commands/cockpit/resolver.ts (excludedFiles)
export function parseIssueRef(...) { ... }                            // ✓ (defining site)

// packages/generacy/src/cli/commands/cockpit/__tests__/resolver.test.ts (excludedFiles)
import { parseIssueRef, resolveIssueContext } from '../resolver.js';  // ✓ (test suite)
```

## Verification

- `pnpm lint` (or the package's equivalent) runs cleanly after the migration in this PR (post-D1 there are zero remaining `parseIssueRef` imports outside `resolver.ts` and `__tests__/`).
- Intentional-violation test (manual, not shipped): temporarily add `import { parseIssueRef } from './resolver.js';` to `advance.ts` and confirm `pnpm lint` fails with the rule's message. Revert.
- CI's existing lint step (whichever job runs `eslint` across the repo) picks up the new rule automatically; no CI config change.

## Interaction with `@internal` annotation

The plan adds an `@internal` JSDoc tag on `parseIssueRef` in `resolver.ts`. This is a documentation signal, not a compile-time or lint-time enforcement mechanism — the ESLint rule here is the actual gate. `@internal` reinforces intent to code readers and to IDEs that surface it in hover text; the two mechanisms are complementary but independent.

## Non-goals

- This rule does NOT catch a runtime call to `parseIssueRef` reached through a re-export or aliased barrel import. There are no such barrels or aliases in the cockpit directory today, so the concrete regression surface (someone imports `parseIssueRef` directly from `./resolver.js`) is fully covered.
- This rule does NOT enforce the invariant on cockpit-adjacent code outside `packages/generacy/src/cli/commands/cockpit/`. The invariant is scoped by design: `resolveIssueContext` is *the* cockpit-CLI entry point, and no cockpit code should live outside this directory.
