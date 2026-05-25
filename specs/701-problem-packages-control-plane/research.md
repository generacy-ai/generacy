# Research: atomicWrite EXDEV Fix

## Root Cause

POSIX `rename(2)` requires source and destination to be on the same filesystem. When they're on different mount points (e.g., container overlay `/tmp` vs. Docker named volume `/workspaces/`), the kernel returns `EXDEV` (cross-device link not permitted).

## Solution Pattern

Place the temp file in `dirname(targetPath)` — guaranteed same filesystem as the target. This is the standard pattern used by:
- `credhelper-daemon/src/backends/file-store.ts` (this codebase — uses `.tmp` + rename in same dir)
- `orchestrator/src/activation/persistence.ts` (this codebase — uses `.tmp` suffix + rename)
- Node.js `fs.writeFileSync` with `{ flag: 'wx' }` pattern
- Python's `tempfile.NamedTemporaryFile(dir=target_dir)`

## Alternatives Considered

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| `dirname(targetPath)` temp file | Same-filesystem guarantee, minimal change | Temp file visible briefly in target dir | **Chosen** — dot-prefix makes it hidden |
| `copyFile` + `unlink` fallback | Works cross-device | Non-atomic — partial writes visible, more code | Rejected |
| `fs.writeFileSync` direct write | Simplest | Non-atomic — corrupt file on crash/power loss | Rejected |
| Shared utility extraction | DRY with other atomic writers | Out of scope per spec | Deferred |

## Existing Patterns in Codebase

The codebase already uses the `dirname`-based temp file pattern in at least two places:
- `packages/credhelper/src/backends/file-store.ts` — `CredentialFileStore` atomic writes
- `packages/orchestrator/src/activation/persistence.ts` — key file persistence

The fix aligns `worker-scaler.ts` with these established patterns.

## Test Gap

Current tests use `os.tmpdir()` for both the temp dir and the target dir, so source and target are always on the same filesystem. The EXDEV only manifests in production where `/tmp` is overlay and `/workspaces/` is a named volume.
