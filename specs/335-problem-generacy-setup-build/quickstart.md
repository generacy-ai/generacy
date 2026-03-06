# Quickstart: Build phase fix for external projects

## Testing the fix

### External project scenario (source repos absent)

```bash
# Run build without source repos present
generacy setup build

# Expected output:
# INFO: Starting build process
# INFO: Phase 1: Cleaning stale Claude plugin state
# INFO: Phase 1 complete: Plugin state cleaned
# INFO: Skipping source build for agency/latency — using installed packages
# INFO: Skipping source build for generacy — using installed packages
# INFO: Phase 4: Installing Claude Code integration (speckit commands + Agency MCP)
# INFO: Installed agency-spec-kit plugin via marketplace
# INFO: Phase 4 complete: Claude Code integration installed
# INFO: Build process complete
```

### Multi-repo dev scenario (source repos present)

```bash
# Build with source repos cloned at /workspaces/agency and /workspaces/latency
generacy setup build

# Expected: same behavior as before (builds from source)
```

### Skip flags (unchanged)

```bash
generacy setup build --skip-cleanup     # Skip Phase 1
generacy setup build --skip-agency      # Skip Phase 2
generacy setup build --skip-generacy    # Skip Phase 3
generacy setup build --latest           # Use latest plugin version
```

## Running tests

```bash
cd packages/generacy
pnpm test -- src/__tests__/setup/build.test.ts
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Phase 2/3 still tries to build | Source repo dirs exist but are empty/broken | Remove the dirs or use `--skip-agency`/`--skip-generacy` |
| Marketplace plugin install fails | No network or marketplace not configured | Plugin will fall back to file copy if agency source exists; otherwise warns |
| MCP configuration skipped | Agency CLI not installed globally or from source | Install agency via npm (`npm i -g @generacy-ai/agency`) |
