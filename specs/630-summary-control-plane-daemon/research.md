# Research: Control-plane daemon path resolution fix

## Current State

The bug is in `packages/control-plane/src/routes/app-config.ts:42-46`:

```typescript
function getGeneracyDir(): string {
  return process.env['GENERACY_PROJECT_DIR']
    ? path.join(process.env['GENERACY_PROJECT_DIR'], '.generacy')
    : DEFAULT_GENERACY_DIR;  // '.generacy' (relative)
}
```

`DEFAULT_GENERACY_DIR` is the string literal `'.generacy'`, which resolves relative to `process.cwd()`. The daemon's CWD is `/workspaces` (set by orchestrator entrypoint), not `/workspaces/<project-name>`.

## Environment Context

In the standard cluster layout:
- Orchestrator entrypoint spawns control-plane with CWD `/workspaces`
- Project lives at `/workspaces/<project-name>/`
- `.generacy/cluster.yaml` is at `/workspaces/<project-name>/.generacy/cluster.yaml`
- `GENERACY_PROJECT_DIR` is NOT set in production clusters
- `WORKSPACE_DIR` may be set by some cluster configurations

## Approach: 4-Tier Discovery

### Tier 1: `GENERACY_PROJECT_DIR` (explicit override)
- Highest priority — if an operator sets this, it's authoritative
- Already exists but never populated in production

### Tier 2: `WORKSPACE_DIR` (orchestrator convention)
- Some cluster configurations set this to the project root
- Pattern: `${WORKSPACE_DIR}/.generacy`

### Tier 3: Glob discovery (auto-detect)
- Scan `/workspaces/*/` for directories containing `.generacy/cluster.yaml`
- Single match → use it
- Multiple matches → ambiguous, warn and fall through
- Zero matches → fall through

### Tier 4: CWD-relative (backwards compat)
- `path.resolve(process.cwd(), '.generacy')`
- Same behavior as current code — preserves backwards compatibility

## Alternatives Considered

### Fix in cluster-base entrypoint only (Option B from spec)
- Rejected as primary fix: requires cluster-base repo change, not all clusters will update
- Good defense-in-depth for later

### Use `node:fs.existsSync` walk-up pattern
- Walk up from CWD looking for `.generacy/cluster.yaml`
- Rejected: CWD is `/workspaces` which IS the parent of the project — would need to walk DOWN
- Not a standard pattern for this use case

### Add `glob` npm dependency
- Rejected: only need single shallow directory listing
- `fs.readdir('/workspaces')` + `fs.stat` per entry is sufficient and zero-dep

## Implementation Pattern

The resolver follows the same singleton/cached pattern used elsewhere in the control-plane:
- `probeCodeServerSocket()` in orchestrator
- `getRelayPushEvent()` / `setRelayPushEvent()` in control-plane

Cache is a simple module-level `let resolved: string | null = null` with a `resetCache()` export for testing.
