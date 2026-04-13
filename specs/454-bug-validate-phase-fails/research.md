# Research: Validate phase fails after worker restart

## Root Cause Analysis

The issue is a missing build step in the `preValidateCommand` pipeline. The chain of events:

1. Worker restarts → `bootstrap-worker.sh` does a fresh clone
2. Validate phase runs `preValidateCommand` (`pnpm install`) → links workspace packages
3. Workspace packages like `@generacy-ai/orchestrator` declare `"types": "./dist/index.d.ts"` in `package.json`
4. `dist/` doesn't exist because no build has run → `tsc` fails with TS2307

## Fix Strategy: Change default only

**Decision**: Modify the Zod `.default()` value for `preValidateCommand` in `WorkerConfigSchema`.

**Alternatives considered**:

| Alternative | Rejected because |
|------------|-----------------|
| Modify `bootstrap-worker.sh` to pre-build packages | Out of scope per spec; couples bootstrap to build knowledge |
| Add a separate `preBuildCommand` config field | Over-engineering for a one-line default change |
| Build packages inside `validateCommand` instead | Would break the separation of concerns; validate already runs `pnpm test && pnpm build` |
| Use `pnpm -r build` (no filter) | Would also build root and potentially trigger recursive issues |

## pnpm filter behavior

The command `pnpm -r --filter ./packages/* build` is correct:
- `-r` runs recursively across workspace packages
- `--filter ./packages/*` restricts to packages under the `packages/` directory
- pnpm respects dependency order, building dependencies first
- Packages without a `build` script are silently skipped
- Idempotent: re-running when `dist/` exists just overwrites with identical output

## Impact on existing flows

- **Warm workers** (dist/ already exists): Build is a no-op-ish (fast recompile, ~5s)
- **Cold workers** (fresh clone): Build runs fully (~30-60s), then validation proceeds
- **Custom preValidateCommand**: Unaffected — only the Zod default changes
