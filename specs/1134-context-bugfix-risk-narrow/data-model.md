# Data Model: #1134 Bugfix profiles

## Classification (diff-classifier.ts)

```ts
export type Classification =
  | { kind: 'full-fallback'; reason: string }
  | { kind: 'single-package-plain'; reason: string }
  | { kind: 'docs-only-skip-tests' }
  | { kind: 'test-only'; testFiles: string[] }
  | { kind: 'targeted' };

export interface ClassifyInput {
  /** Changed-file paths, repo-relative, against origin/<base>. */
  changedFiles: string[];
  /** True iff pnpm-workspace.yaml exists at the checkout root. */
  isWorkspace: boolean;
}

export function classifyDiff(input: ClassifyInput): Classification;
```

Empty `changedFiles` → `full-fallback` (nothing to narrow safely; conservative).

## Guard globs (Q2=A — closed set)

| Category | Globs | Effect |
|----------|-------|--------|
| root-config (force full) | `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `pnpm-workspace.yaml`, root `tsconfig*.json` (root only, not nested), `.github/workflows/**` | `full-fallback` |
| docs-only | `**/*.md`, `docs/**` | `docs-only-skip-tests` (if ALL changed files match) |
| test-only | `**/*.{test,spec}.{ts,tsx,js,jsx}`, `**/__tests__/**` | `test-only` (if ALL changed files match) |

Root `tsconfig*.json` = a top-level `tsconfig.json` / `tsconfig.base.json` etc.; a
nested `packages/x/tsconfig.json` does NOT force full.

## Precedence (order-sensitive, first match wins)

1. any file ∈ root-config → `full-fallback`
2. `!isWorkspace` → `single-package-plain`
3. all files ∈ docs → `docs-only-skip-tests`
4. all files ∈ test → `test-only` (carry the matched test files)
5. else → `targeted`

## Effective-command resolution (phase-loop wiring)

Input: `Classification`, `config.validateCommand`, `base` (bare name, `origin/`
stripped), `isBuiltInDefault = config.validateCommand === DEFAULT_VALIDATE_COMMAND`.

| Classification | isBuiltInDefault | Effective command |
|----------------|------------------|-------------------|
| targeted | true | `pnpm --filter "...[origin/<base>]" build && pnpm --filter "...[origin/<base>]" test` |
| targeted | false | custom command, verbatim |
| docs-only-skip-tests | true | `pnpm --filter "...[origin/<base>]" build` (no test) |
| docs-only-skip-tests | false | custom command, verbatim |
| test-only | true | `pnpm vitest run <testFiles...>` (build skipped) |
| test-only | false | custom command, verbatim |
| single-package-plain | any | plain configured command, verbatim |
| full-fallback | any | plain configured command, verbatim |

Every row is logged: `{ event: 'targeted-validate', classification, isBuiltInDefault, base, effectiveCommand }` (FR-009 / US2 AC "logged").

## FailThenPass model (fail-then-pass.ts)

```ts
export interface FailThenPassInput {
  checkoutPath: string;
  baseRef: string;           // origin/<base>
  changedTestFiles: string[]; // diff set ∩ test globs
  signal: AbortSignal;
}
export type FailThenPassResult =
  | { kind: 'noop' }                                  // empty test set
  | { kind: 'pass' }                                  // base fails, branch passes
  | { kind: 'fail'; reason: 'base-passed' | 'branch-failed'; evidence: string };
```

- `noop` is non-blocking (Q3=A).
- base-ref run happens in a detached worktree; branch run happens in the existing
  checkout.
- `fail` short-circuits the validate phase with actionable evidence.

## Config surface (existing — reference only)

- `WorkerConfig.validateCommand` default `DEFAULT_VALIDATE_COMMAND` (`config.ts:142`).
- `ResolvedWorkflowConfig.review.{profile,blockingSeverity,failThenPass}` from
  `resolveWorkflowOverrides`.
- `resolveAgentForPhase(config, workflowName, 'review'|'remediate')` — unchanged.

## Charter model (existing — reference only)

`ReviewCharterInput.profile: 'standard' | 'verification'` (`review-charter.ts`). Only
the `verification` branch text changes (FR-001).
