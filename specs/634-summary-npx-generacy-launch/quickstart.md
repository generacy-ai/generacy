# Quickstart: Verify #634 scaffolder fix

## Run tests

```bash
cd /workspaces/generacy
pnpm --filter @generacy-ai/generacy test -- --run src/cli/commands/cluster/__tests__/scaffolder.test.ts
```

All scaffolder tests should pass, including the new app-config assertions.

## Manual verification

Generate a compose file and inspect it:

```bash
# From a test directory or via npx generacy launch --claim=<code>
# Then inspect the generated file:
grep -A2 'tmpfs' .generacy/docker-compose.yml
# Should show /run/generacy-app-config entry

grep 'generacy-app-config-data' .generacy/docker-compose.yml
# Should show volume on orchestrator (rw) and worker (ro)
# Should show top-level declaration
```

## Expected compose entries

After the fix, `docker-compose.yml` should contain:

1. **tmpfs** (both services): `/run/generacy-app-config:mode=1750,uid=1000,gid=1000`
2. **Orchestrator volume**: `generacy-app-config-data:/var/lib/generacy-app-config`
3. **Worker volume**: `generacy-app-config-data:/var/lib/generacy-app-config:ro`
4. **Top-level**: `generacy-app-config-data:` under `volumes:`

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Test `includes tmpfs mounts` fails | tmpfs entry not added to `tmpfsMounts` array | Check `scaffolder.ts:162-165` |
| Test `declares all expected named volumes` fails | Top-level volume missing | Check `scaffolder.ts:247-255` |
| App-config lost on restart | Volume not declared or not mounted | Run `docker compose config` and verify volume entries |
