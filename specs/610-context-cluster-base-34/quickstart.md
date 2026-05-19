# Quickstart: Verify vscode-cli volume mount fix

## Verify the code change

After applying the fix, inspect the scaffolder output:

```bash
# Check that the old values are gone
grep -n 'vscode-cli:/home/node/.vscode-cli' packages/generacy/src/cli/commands/cluster/scaffolder.ts
# Should return nothing

# Check that the new values are present
grep -n 'vscode-cli-state:/home/node/.vscode/cli' packages/generacy/src/cli/commands/cluster/scaffolder.ts
# Should show the orchestrator volumes line

grep -n "'vscode-cli-state'" packages/generacy/src/cli/commands/cluster/scaffolder.ts
# Should show the top-level volumes declaration
```

## Verify generated compose file

```bash
# If you have a test that scaffolds compose output, run it:
pnpm --filter @generacy-ai/generacy test

# Or manually inspect a scaffolded file:
# Look for `vscode-cli-state:/home/node/.vscode/cli` in services.orchestrator.volumes
# Look for `vscode-cli-state: null` in top-level volumes
```

## End-to-end verification

1. Run `npx generacy launch --claim=<code>` to scaffold a new cluster
2. Inspect `.generacy/docker-compose.yml`
3. Confirm `vscode-cli-state:/home/node/.vscode/cli` in orchestrator volumes
4. Confirm `vscode-cli-state:` in top-level volumes section
5. Start tunnel, authorize, `docker compose down && up`, confirm tunnel reconnects without re-auth
