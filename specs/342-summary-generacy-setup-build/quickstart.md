# Quickstart: Testing the Phase 4 Fix

## Prerequisites

- Node.js ≥ 20
- `@generacy-ai/agency` installed globally with `.md` command files included (requires updated agency package)

## Testing the Fix

### Simulate external project (no agency source)

```bash
# Ensure /workspaces/agency does NOT exist (or use a fresh container)
# Run the build command
generacy setup build

# Verify commands were copied
ls ~/.claude/commands/
# Should show: specify.md, clarify.md, plan.md, tasks.md, implement.md, etc.
```

### Verify fallback order

Run with `LOG_LEVEL=debug` to see which fallback path was used:

```bash
LOG_LEVEL=debug generacy setup build 2>&1 | grep -E 'Phase 4|marketplace|fallback|npm|commands'
```

Expected output for external project:
```
Phase 4: Installing Claude Code integration
Failed to register generacy-marketplace
Marketplace plugin install failed, trying fallback
Copied speckit command definitions from npm global
```

### Verify existing paths still work

With agency source available:
```bash
# In devcontainer with /workspaces/agency present
generacy setup build
# Should use marketplace or source-copy path as before
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "No speckit commands available" | `@generacy-ai/agency` not installed globally or missing `commands/` | Run `npm install -g @generacy-ai/agency@latest` |
| Commands not found by Claude Code | Files not in `~/.claude/commands/` | Check file permissions, re-run `generacy setup build` |
| MCP server not configured | Agency CLI not found globally | Verify `npm root -g` contains `@generacy-ai/agency/dist/cli.js` |
