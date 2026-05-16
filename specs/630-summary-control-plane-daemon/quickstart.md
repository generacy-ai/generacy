# Quickstart: Testing the path resolution fix

## Development Setup

```bash
cd /workspaces/generacy
pnpm install
```

## Running Unit Tests

```bash
cd packages/control-plane
pnpm test -- --run tests/unit/project-dir-resolver.test.ts
```

## Manual Verification

### Simulating the bug (before fix)

```bash
# In a cluster container, confirm current broken behavior:
docker exec <orchestrator> sh -c \
  'curl --silent --unix-socket /run/generacy-control-plane/control.sock \
  -H "x-control-plane-actor: {\"id\":\"test\"}" \
  http://localhost/app-config/manifest'
# Returns: null
```

### Verifying the fix

```bash
# After deploying the fix, same request should return the appConfig:
docker exec <orchestrator> sh -c \
  'curl --silent --unix-socket /run/generacy-control-plane/control.sock \
  -H "x-control-plane-actor: {\"id\":\"test\"}" \
  http://localhost/app-config/manifest'
# Returns: {"schemaVersion":"1","env":[...],"files":[...]}
```

### Testing each tier

```bash
# Tier 1: Explicit env var
GENERACY_PROJECT_DIR=/workspaces/my-project node -e "..."

# Tier 2: WORKSPACE_DIR fallback
WORKSPACE_DIR=/workspaces/my-project node -e "..."

# Tier 3: Glob discovery (default cluster layout)
# Just ensure /workspaces/<name>/.generacy/cluster.yaml exists

# Tier 4: CWD-relative (backwards compat)
cd /path/with/.generacy && node -e "..."
```

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Manifest returns `null` | Path resolution failed, no `cluster.yaml` at resolved path | Check daemon logs for tier warnings |
| "Multiple projects found" warning | More than one `/workspaces/*/.generacy/cluster.yaml` | Set `GENERACY_PROJECT_DIR` explicitly |
| Works locally but not in container | CWD differs between local dev and container | Set `GENERACY_PROJECT_DIR` in container env |
