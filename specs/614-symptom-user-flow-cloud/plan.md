# Implementation Plan: Fix Stale Credential Surface After Cluster Re-Add

**Feature**: After archiving a cluster and re-adding it with a new claim code, GitHub API calls 401 because (A) `handlePutCredential` doesn't refresh `GH_TOKEN` env file or `gh` auth state, and (B) stale activation key files in the Docker volume prevent re-activation.
**Branch**: `614-symptom-user-flow-cloud`
**Status**: Complete

## Summary

Two independent fixes that together close the stale-credential gap:

- **Fix A (P1)**: After `writeCredential()` succeeds for `github-app` or `github-pat` types, regenerate `wizard-credentials.env` (restart path) and run `gh auth login --with-token` (live-refresh path).
- **Fix B (P2)**: When the CLI receives `--claim`, clear stale `cluster-api-key` and `cluster.json` from the `generacy-data` Docker volume before `docker compose up`, so the orchestrator runs the full activation flow.

## Technical Context

- **Language**: TypeScript (ESM, Node >= 22)
- **Framework**: Native `node:http` (control-plane), Commander.js (CLI)
- **Key packages**: `packages/control-plane`, `packages/generacy` (CLI)
- **Testing**: Vitest
- **Build**: pnpm monorepo

## Fix A — Credential Live-Refresh (control-plane)

### Problem
`handlePutCredential` in `packages/control-plane/src/routes/credentials.ts` calls `writeCredential()` which persists the secret and writes YAML metadata, but:
1. Does NOT regenerate `/var/lib/generacy/wizard-credentials.env` (used on container restart)
2. Does NOT run `gh auth login --with-token` (used for live `gh` CLI refresh)

### Solution

#### A1: Post-write hook in `handlePutCredential`
After the existing `writeCredential()` call succeeds, for `github-app` or `github-pat` credential types:

1. Call `writeWizardEnvFile({ agencyDir, envFilePath })` to regenerate the env file with the new `GH_TOKEN=...` line. This is load-bearing for container restarts.
2. Call a new `refreshGhAuth(token)` helper that shells out to `echo "$TOKEN" | gh auth login --with-token --hostname github.com`. This updates `~/.config/gh/hosts.yml` immediately.

#### A2: New helper — `refreshGhAuth`
- Location: `packages/control-plane/src/services/gh-auth-refresh.ts`
- Uses `child_process.execFile` to run `gh auth login --with-token`
- Pipes the token via stdin (never appears in argv)
- Returns success/failure; caller treats failure as non-fatal (logs warning, doesn't fail the PUT)

#### A3: Extract token from credential value
- `github-app` values are JSON: `{ installationId, token, ... }` — parse and extract `token`
- `github-pat` values are raw token strings
- Reuse `mapCredentialToEnvEntries` logic from `wizard-env-writer.ts` for token extraction

### Files Modified

| File | Change |
|------|--------|
| `packages/control-plane/src/routes/credentials.ts` | After `writeCredential()`, call `writeWizardEnvFile()` + `refreshGhAuth()` for github types |
| `packages/control-plane/src/services/gh-auth-refresh.ts` | **NEW** — `refreshGhAuth(token)` helper |
| `packages/control-plane/src/services/wizard-env-writer.ts` | No changes needed (already handles github-app/github-pat) |

### Sequence Diagram (Fix A)

```
Cloud ──PUT /credentials/github-main-org──► Control-Plane
                                                │
                                          writeCredential()
                                                │
                                          ┌─────┴─────┐
                                          │ setSecret()│  (credhelper store)
                                          │ writeYAML()│  (credentials.yaml)
                                          │ relayEvent │
                                          └─────┬─────┘
                                                │
                                          if github-app/github-pat:
                                                │
                                          ┌─────┴─────┐
                                          │ writeWizardEnvFile()  │  ← P1: restart path
                                          │ refreshGhAuth(token)  │  ← P1: live-refresh
                                          └─────┬─────┘
                                                │
                                          200 { ok: true }
```

## Fix B — CLI Force-Reactivation (generacy CLI)

### Problem
When `--claim` is passed to `generacy launch`, the CLI scaffolds a new project directory but reuses the existing `generacy-data` Docker volume. The stale `cluster-api-key` file causes `activate()` to short-circuit.

### Solution

#### B1: Clear stale activation files from Docker volume
In `launchAction()`, after scaffolding but before `docker compose up`, when `--claim` is provided:

1. Run `docker run --rm -v <composeName>_generacy-data:/v alpine rm -f /v/cluster-api-key /v/cluster.json`
2. This removes the stale key file so `readKeyFile()` returns null and activation runs fresh

The compose project name is derived from `sanitizeComposeProjectName(config.projectName, config.clusterId)`, which is already computed during scaffolding.

#### B2: Also clear the wizard env file
Additionally remove `/v/wizard-credentials.env` so the new wizard run writes a fresh one.

### Files Modified

| File | Change |
|------|--------|
| `packages/generacy/src/cli/commands/launch/index.ts` | Add volume-cleanup step between scaffold and compose-up when `--claim` is present |
| `packages/generacy/src/cli/commands/launch/compose.ts` | **or** new helper in `launch/volume-cleanup.ts` |

### Key Decision: Use `docker run --rm` instead of `docker volume rm`
- `docker volume rm` destroys ALL persisted state (audit logs, master key, scratch dirs)
- `docker run --rm -v ... alpine rm -f` surgically removes only the activation files
- Zero orchestrator code changes required

## Project Structure

```
packages/
├── control-plane/
│   └── src/
│       ├── routes/
│       │   └── credentials.ts          ← MODIFIED (Fix A: post-write hook)
│       └── services/
│           ├── gh-auth-refresh.ts      ← NEW (Fix A: gh auth login helper)
│           └── wizard-env-writer.ts    ← unchanged (already correct)
│
└── generacy/
    └── src/
        └── cli/
            └── commands/
                └── launch/
                    ├── index.ts         ← MODIFIED (Fix B: volume cleanup)
                    └── volume-cleanup.ts ← NEW (Fix B: docker run rm helper)
```

## Edge Cases

1. **No `gh` binary in container**: `refreshGhAuth` fails — non-fatal, logs warning. Restart path (env file) still works.
2. **Concurrent PUTs**: `writeWizardEnvFile` uses atomic write (temp + rename). Safe under concurrency.
3. **Non-github credential types**: Post-write hook is gated on `type === 'github-app' || type === 'github-pat'`. Other types skip both refresh steps.
4. **Volume doesn't exist yet**: `docker run --rm -v` creates an empty volume if none exists — the `rm -f` is a no-op. No harm.
5. **Docker not running when clearing volume**: The `docker run` command fails — but `docker compose up` will also fail moments later, so this is a consistent error path.

## Testing Strategy

### Unit Tests
- `handlePutCredential` with `type: 'github-app'`: verify `writeWizardEnvFile` called, `refreshGhAuth` called with extracted token
- `handlePutCredential` with `type: 'github-pat'`: verify same flow with raw token
- `handlePutCredential` with `type: 'api-key'`: verify NO env rewrite or gh refresh
- `refreshGhAuth`: mock `execFile`, verify token piped via stdin (not argv)
- Volume cleanup: mock `execSync`, verify correct docker command with compose name

### Integration Tests (manual)
- Archive cluster → re-add → `npx generacy launch --claim=<new>` → verify activation runs
- PUT fresh github-app credential → verify orchestrator's next `gh` call succeeds
- Container restart after credential PUT → verify `GH_TOKEN` in env file is updated

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `gh auth login` not available in container | Low | Medium | Non-fatal; env file rewrite still covers restart path |
| Docker volume name mismatch | Low | High | Use same `sanitizeComposeProjectName` as scaffolder |
| Concurrent credential PUTs race | Low | Low | Atomic writes; last-writer-wins is acceptable |

## Dependencies

- No new npm packages needed
- `gh` CLI expected in container PATH (installed by cluster-base image)
- `alpine` image available for `docker run --rm` (standard, cached)
