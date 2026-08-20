# Contract: `classifyDiff` (diff-classifier.ts)

Pure, deterministic, no I/O (FR-003).

## Signature

```ts
function classifyDiff(input: {
  changedFiles: string[];
  isWorkspace: boolean;
}): Classification;
```

`Classification` discriminated union — see data-model.md.

## Behavior (ordered, first match wins)

| # | Condition | Result |
|---|-----------|--------|
| 0 | `changedFiles` empty | `full-fallback` (reason `'empty-diff'`) |
| 1 | any file matches a **root-config** glob | `full-fallback` (reason `'root-config: <file>'`) |
| 2 | `!isWorkspace` | `single-package-plain` (reason `'not-a-workspace'`) |
| 3 | **all** files match a **docs** glob | `docs-only-skip-tests` |
| 4 | **all** files match a **test** glob | `test-only` (`testFiles` = the changed files) |
| 5 | otherwise | `targeted` |

## Glob sets (Q2=A — closed)

- root-config: `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`,
  `pnpm-workspace.yaml`, root-only `tsconfig*.json`, `.github/workflows/**`
- docs: `**/*.md`, `docs/**`
- test: `**/*.{test,spec}.{ts,tsx,js,jsx}`, `**/__tests__/**`

"root-only `tsconfig*.json`" = the path has no `/` before the filename (top-level).

## Invariants

- Given identical input, identical output (pure).
- Exactly one branch fires (ordered precedence).
- Never throws.

## Test matrix (SC-001 — every branch + guard)

1. empty diff → `full-fallback`
2. lockfile touched (+ other src) → `full-fallback`
3. `pnpm-workspace.yaml` touched → `full-fallback`
4. root `tsconfig.json` touched → `full-fallback`; nested `packages/x/tsconfig.json` → NOT full
5. `.github/workflows/ci.yml` touched → `full-fallback`
6. `isWorkspace: false` with package source → `single-package-plain`
7. all `*.md` / under `docs/` → `docs-only-skip-tests`
8. mixed docs + source → `targeted` (not docs-only)
9. all `*.test.ts` / `__tests__/**` → `test-only` with `testFiles`
10. mixed test + source → `targeted` (not test-only)
11. plain package source, workspace → `targeted`
