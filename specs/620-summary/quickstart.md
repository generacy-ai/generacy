# Quickstart: Orchestrator GitHub Monitors Credential Resolution

## Prerequisites

- Node >= 22
- pnpm installed
- Generacy monorepo checked out on branch `620-summary`

## Build & Test

```bash
# Install dependencies
pnpm install

# Build affected packages
pnpm -F @generacy-ai/workflow-engine build
pnpm -F @generacy-ai/orchestrator build

# Run unit tests
pnpm -F @generacy-ai/workflow-engine test
pnpm -F @generacy-ai/orchestrator test
```

## Verification Checklist

### SC-001: No ambient auth paths

Verify no orchestrator-process `gh` invocation relies on ambient `hosts.yml`:

```bash
# All gh CLI spawn sites should pass GH_TOKEN in env
# Monitor services: via tokenProvider in GhCliGitHubClient
# WebhookSetupService: via env option in executeCommand calls
# Worker processes: pass undefined (credhelper handles it)

# Grep for executeCommand('gh' calls without env in orchestrator package
grep -rn "executeCommand.*'gh'" packages/orchestrator/src/services/
```

### SC-002: Token freshness

The token provider re-reads the env file when `mtime` changes, so monitors pick up refreshed tokens within one poll interval (typically 30-60s).

### Manual Testing

1. Start the development stack:
   ```bash
   /workspaces/tetrad-development/scripts/stack start
   source /workspaces/tetrad-development/scripts/stack-env.sh
   ```

2. Create a test wizard-credentials.env:
   ```bash
   sudo mkdir -p /var/lib/generacy
   echo "GH_TOKEN=ghp_test_token_value" | sudo tee /var/lib/generacy/wizard-credentials.env
   sudo chmod 600 /var/lib/generacy/wizard-credentials.env
   ```

3. Start the orchestrator:
   ```bash
   pnpm -F @generacy-ai/orchestrator dev
   ```

4. Verify monitors log token resolution on startup and use the token for `gh` CLI calls.

5. Remove the env file to verify graceful degradation:
   ```bash
   sudo rm /var/lib/generacy/wizard-credentials.env
   ```
   Expected: one warning log on next poll cycle, monitors skip cycle, no crash.

6. Recreate the env file to verify recovery:
   ```bash
   echo "GH_TOKEN=ghp_new_token" | sudo tee /var/lib/generacy/wizard-credentials.env
   ```
   Expected: one info log ("resumed"), monitors use new token.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Monitors log "token resolution failed" on every poll | State-transition tracking broken | Check `lastFailed` flag in token provider |
| `gh` calls still use ambient auth | `tokenProvider` not wired | Verify `server.ts` passes provider to all 4 consumers |
| Worker processes fail with auth errors | Worker passed token provider instead of `undefined` | Worker callsites must pass `undefined` — they use credhelper session env |
| Env file not refreshed after credential update | `handlePutCredential` not calling `writeWizardEnvFile` | Check `credentials.ts` route handler (#614) |
