# Quickstart: verifying the `volume`-mode scaffolder fix

This is a bug-fix feature. The "quickstart" is a recipe to reproduce the original failure, apply the fix (or pull a branch that has it), and confirm the success criteria.

## Prerequisites

- Repo cloned and on branch `737-summary-scaffolddockercompose` (or a branch built from it).
- `pnpm` available, `pnpm install` already run in the repo root.
- Docker daemon running locally (`docker info` works).
- Optional, for SC-005: an SSH-reachable Linux VM you can `ssh user@host` into without a password prompt.

## 1. Reproduce the bug on `main`

Confirm what we're fixing.

```bash
# from a scratch directory
cd /tmp
mkdir broken-volume-cluster && cd broken-volume-cluster
mkdir .generacy

# write a minimal compose using the BROKEN volume-mode output:
cat > .generacy/docker-compose.yml <<'EOF'
name: broken
services:
  orchestrator:
    image: alpine:3
    command: sleep 5
    volumes:
      - claude-config:/home/node/.claude.json
volumes:
  claude-config:
EOF

cd .generacy
docker compose up
# Expected error:
#   Error response from daemon: source /var/lib/docker/volumes/.../_data
#   is not directory
```

If you don't see that error, the daemon may have already created the named volume as a directory from a prior run; `docker compose down -v` and retry.

## 2. Run the scaffolder against a temp dir and inspect output

After the fix lands, `scaffoldDockerCompose(... , { claudeConfigMode: 'volume' })` should produce a working compose. Use the package's vitest suite or call the scaffolder directly:

```bash
cd /workspaces/generacy/packages/generacy
pnpm vitest run src/cli/commands/cluster/__tests__/scaffolder.test.ts
```

All scaffolder tests should pass, including the new volume-mode assertions (compose-relative bind, `claude.json` created, top-level `claude-config:` absent).

Manual one-shot:

```bash
node --experimental-strip-types - <<'EOF'
import { scaffoldDockerCompose } from './src/cli/commands/cluster/scaffolder.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'scaffold-volume-'));
scaffoldDockerCompose(dir, {
  imageTag: 'ghcr.io/generacy-ai/cluster-base:preview',
  clusterId: 'clust_demo',
  projectId: 'proj_demo',
  projectName: 'demo',
  cloudUrl: 'https://api.generacy.ai',
  variant: 'cluster-base',
  orgId: 'org_demo',
  claudeConfigMode: 'volume',
});
console.log('scaffolded in:', dir);
EOF
```

Verify:

```bash
cat "$dir/docker-compose.yml"   # bind line is ./claude.json:/home/node/.claude.json
cat "$dir/claude.json"          # exactly "{}\n"
ls -l "$dir/claude.json"        # mode 0600 if scaffolder ran as root; uid 1000 if chown succeeded
```

## 3. Verify SC-001 — `volume`-mode cluster boots

```bash
cd "$dir"
docker compose up -d
docker compose ps               # orchestrator + worker + redis should be running / healthy
docker compose logs orchestrator | head
#   Should NOT contain: "source ... /home/node/.claude.json is not directory"
```

Tear down:

```bash
docker compose down -v
```

## 4. Verify SC-002 — `bind`-mode output unchanged

The vitest suite captures the `bind`-mode YAML output as a fixture. Re-run:

```bash
pnpm vitest run src/cli/commands/cluster/__tests__/scaffolder.test.ts -t "bind mode"
```

A byte-equality assertion (`expect(emittedYaml).toBe(snapshot)`) covers SC-002. If the snapshot changes, the fix has accidentally touched the `bind` branch.

## 5. Verify SC-003 — Claude session survives container recreation

```bash
cd "$dir"
docker compose up -d
docker compose exec orchestrator claude /login
# follow the prompts; once logged in:

docker compose down
docker compose up -d
docker compose exec orchestrator claude  # should NOT re-prompt for login
```

Inspect the host file to confirm Claude wrote real content:

```bash
cat "$dir/claude.json" | jq .
# expect non-empty config (sessionToken, etc.)
```

## 6. Verify SC-004 — Re-scaffold preserves the session token

```bash
sha256sum "$dir/claude.json"     # capture pre-hash
node --experimental-strip-types - <<EOF
import { scaffoldDockerCompose } from '$PWD/src/cli/commands/cluster/scaffolder.ts';
scaffoldDockerCompose('$dir', { /* same input as step 2 */ });
EOF
sha256sum "$dir/claude.json"     # should match the pre-hash exactly
```

## 7. Verify SC-005 — `deploy` to a non-root VM

(Requires a VM and a working `generacy deploy` setup.)

```bash
# As a non-root user (e.g. `ubuntu`) on the target VM:
generacy deploy ssh://ubuntu@your-vm

# Expected:
#   - Bundle SCPs (claude.json included).
#   - Pre-pull SSH ownership-fix command runs; chown emits no error to stdout
#     (it's silenced via 2>/dev/null || true).
#   - docker compose pull + up succeed.
#   - Orchestrator container becomes healthy.
# On the VM, the file ownership reflects what the SSH user could achieve:
ssh ubuntu@your-vm 'ls -l ~/generacy-clusters/proj_*/claude.json'
#   - If SSH user is uid 1000 or has CAP_CHOWN: owned by 1000:1000, mode 0600.
#   - Otherwise: owned by the SSH user; container still starts and mounts.
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `source ... /home/node/.claude.json is not directory` on `up` | You're running an old `docker-compose.yml` from before the fix. | Re-run `generacy launch` or `generacy deploy` to re-scaffold; or hand-edit the bind to `./claude.json:/home/node/.claude.json` and `touch claude.json`. |
| `EPERM` warning in scaffolder logs | Scaffolder ran as non-root and could not chown. | Informational. Linux: if your first user is uid 1000 (common), Claude can write fine. macOS Docker Desktop: bind remapping handles it. Otherwise, the container will treat `claude.json` as read-only. |
| Container starts but Claude prompts re-login after `down && up` | Either `claude.json` was overwritten (it should never be), or its ownership is wrong and Claude failed to persist to it. | Check `ls -l claude.json`; chown to uid 1000 manually if needed. |
| Snapshot test for `bind` mode fails after this change | The fix accidentally modified the `bind` branch. | The fix MUST be additive to the `volume` branch only. Check `if (claudeConfigMode === 'volume')` guards. |

## Files changed by this feature

- `packages/generacy/src/cli/commands/cluster/scaffolder.ts` — `scaffoldDockerCompose` volume-mode branch.
- `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts` — extended volume-mode assertions; bind-mode byte-equality snapshot.
- `packages/generacy/src/cli/commands/deploy/remote-compose.ts` — new pre-pull SSH ownership-fix command.

## Next step

Run `/speckit:tasks` to generate the task list.
