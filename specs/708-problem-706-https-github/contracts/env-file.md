# Contract — `.generacy/.env` `WORKER_COUNT` line

## Scope

This contract documents how the `.env` file's `WORKER_COUNT` key is read and written by the two writers introduced/restored in #708. The `.env` file as a whole has no formal schema; this contract narrows to the one line owned by this feature.

## Producers

| Writer | Trigger | Write semantics |
|---|---|---|
| `scaffoldEnvFile()` in `packages/generacy/src/cli/commands/cluster/scaffolder.ts` | First-time scaffold (`launch`, `deploy`) | Emits the full `.env` including `WORKER_COUNT=<workers>`. Pre-existing — not modified by this PR. |
| `doScale()` in `packages/control-plane/src/services/worker-scaler.ts` | Cloud-UI scale via Engine API | After `cluster.yaml` write succeeds, replace or append `WORKER_COUNT=<actualCount>` via `atomicWrite`. Skip-and-warn if file missing. |
| `reconcileWorkerCount()` in `packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts` | Every `npx generacy up` / `npx generacy update` invocation | Read `cluster.yaml`, sanitize, replace or append `WORKER_COUNT=<sanitized>` via atomic temp+rename. Skip-and-warn if `.env` missing. |

## Consumers

| Reader | Trigger | Read semantics |
|---|---|---|
| `docker compose` (host CLI) | `docker compose up -d`, `docker compose pull`, etc. | Reads `.env` from the same directory as the compose file (or project root). Interpolates `${WORKER_COUNT:-1}` in `docker-compose.yml`. Treats the last occurrence of any key as authoritative. |

## Line format

**On disk** (when present):

```
WORKER_COUNT=<positive integer>
```

- No quotes.
- No whitespace around `=`.
- No trailing whitespace before the newline.
- Value is a base-10 positive integer (no leading zeros, no sign).

**Replace pattern** (regex): `/^WORKER_COUNT=.*$/m`

- Replaces the entire matched line (preserving the surrounding lines and the trailing newline).
- Anchored to line start (`^`) and line end (`$`) under multiline mode.

**Append pattern** (when no match): emit a single line `WORKER_COUNT=<N>\n` at end-of-file. If the file does not already end with a newline, the writer prepends one before the new line.

## File-level invariants enforced by writers

1. **No comments are modified or removed.** Lines beginning with `#` are preserved verbatim.
2. **No other key/value lines are modified.** Only the `WORKER_COUNT` line is touched.
3. **Atomic visibility.** The file is written to a sibling temp path then `rename(2)`'d into place — no readers ever see a half-written file.
4. **No file creation.** If `.env` does not exist when a writer runs, the writer logs a warning and exits successfully. It does NOT create a one-line `.env` (per FR-008, Q1=B).

## Error handling

| Error | Producer behavior | Caller observation |
|---|---|---|
| `.env` does not exist | Log warning; do not throw; do not create file. | Scale or `up`/`update` succeeds; warning visible in stdout/stderr. |
| `.env` read fails (permissions, IO) | Log warning; do not throw. | Same as above. |
| Temp file write fails | Log warning; do not throw. | Same as above. |
| `rename(2)` fails | Log warning; do not throw. | Same as above. |

The `WORKER_COUNT` line in `.env` is best-effort secondary state. Its source of truth is `cluster.yaml`. A failure in any writer is recoverable on the next `npx generacy up` / `update` invocation, which re-runs `reconcileWorkerCount` and reconciles `.env` from `cluster.yaml`.

## Compose interpolation

The compose file references `WORKER_COUNT` exactly once:

```yaml
services:
  worker:
    deploy:
      replicas: ${WORKER_COUNT:-1}
```

(Source: `packages/generacy/src/cli/commands/cluster/scaffolder.ts:210`.)

The `:-1` default means: if `.env` is missing the key entirely, compose interpolates `1`. This default is the safety net behind D3 / FR-008's skip-and-warn behavior — a missing `.env` produces a 1-replica cluster, not a crash.
