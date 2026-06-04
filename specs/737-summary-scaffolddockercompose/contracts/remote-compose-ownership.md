# Contract: `remote-compose.ts` — idempotent ownership-fix SSH step

**Function**: `deployToRemote(target, bundleDir, remotePath, registryCredentials?)`
**File**: `packages/generacy/src/cli/commands/deploy/remote-compose.ts`
**Applies when**: This function is invoked. (It is only invoked by `generacy deploy`, which always passes `claudeConfigMode: 'volume'` — so the fix can run unconditionally without testing the mode.)

## The Command

After `scpDirectory(target, bundleDir, remotePath)` and `writeRemoteDockerConfig(...)` (if credentials), and **before** the `docker compose pull` step, run:

```sh
test -f "${remotePath}/claude.json" \
  || install -o 1000 -g 1000 -m 0600 /dev/null "${remotePath}/claude.json"; \
chown 1000:1000 "${remotePath}/claude.json" 2>/dev/null || true
```

Invocation:

```ts
sshExec(target, `test -f "${remotePath}/claude.json" || install -o 1000 -g 1000 -m 0600 /dev/null "${remotePath}/claude.json"; chown 1000:1000 "${remotePath}/claude.json" 2>/dev/null || true`);
```

## Preconditions

| # | Precondition | Source |
|---|--------------|--------|
| P1 | `scpDirectory(...)` has already run, so the SCP'd `claude.json` (or no file, if first deploy) is on the VM at `<remotePath>/claude.json`. | Existing `deployToRemote` flow. |
| P2 | `target` is an SSH-reachable host with `sh`, `test`, `install`, and `chown` available. | All standard utilities; present on any POSIX VM. |
| P3 | `${remotePath}` is a directory the SSH user can read (writability required only for the `install` branch, which runs when SCP did not include the file). | SCP itself requires this. |

## Postconditions

| # | Postcondition | Conditions |
|---|---------------|------------|
| R1 | `${remotePath}/claude.json` exists. | Always (either SCP put it there, or `install` did). |
| R2 | The file is owned by `1000:1000` and has mode `0600`. | When the SSH user can chown (root, or has `CAP_CHOWN`, or uid is already 1000 on the file's parent). |
| R3 | The file is owned by the SSH user (or by whoever owned it pre-SCP). | When the SSH user cannot chown — `chown` fails silently via `2>/dev/null || true`. |
| R4 | The `sshExec` call returns success. | Always when P1–P3 hold. The `|| true` swallows the `chown` failure; the `test -f || install` branch only runs when the file is missing, in which case `install` runs as the SSH user and should succeed. |

## Error / Degradation Behavior

| Scenario | What happens | Caller-visible outcome |
|----------|--------------|------------------------|
| SSH user is root, file present | Both `test -f` and `chown` succeed cleanly. | File ends up `0600` and owned by `1000:1000`. Best outcome. |
| SSH user is root, file absent (first deploy) | `install` creates the file with the right ownership; `chown` is a redundant no-op. | Same as above. |
| SSH user is non-root, file present, file owned by SSH user (typical Ubuntu deploy account) | `test -f` succeeds; `chown` fails (EPERM) but is swallowed. | Container starts; if SSH user's uid happens to be 1000, mount works perfectly; otherwise container reads OK and may not be able to write (Claude will treat `claude.json` as read-only). |
| SSH user lacks privilege to `install` in `${remotePath}` (no write on the directory) | First-deploy code path errors. But this case also breaks SCP, so we will have already failed earlier. | Not reachable in practice. |
| SSH user lacks any of `test`/`install`/`chown` | `sshExec` fails. | `deployToRemote` throws. Acceptable — those tools are POSIX-mandatory; if a target lacks them, `docker compose` will not work either. |

## Idempotency

- Running the command N times produces the same result on call 1 and call N. `test -f` short-circuits the `install` after the first call; `chown` is idempotent on an already-correctly-owned file (and silently no-ops via `|| true` when it can't act).

## What This Contract Does NOT Cover

- The local-side `claude.json` creation — see [scaffolder-volume-mode.md](./scaffolder-volume-mode.md).
- Cleanup of `claude.json` on `generacy destroy` over SSH — handled (or not) by the existing remote-destroy flow; out of scope for this fix.
- Coexistence with other ownership-management tools on the VM (e.g., a cron job that resets ownership) — out of scope.
