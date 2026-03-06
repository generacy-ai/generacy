# Data Model: Build configuration

## Existing interface (no changes)

```typescript
interface BuildConfig {
  skipCleanup: boolean;
  skipAgency: boolean;
  skipGeneracy: boolean;
  agencyDir: string;      // default: '/workspaces/agency'
  generacyDir: string;    // default: '/workspaces/generacy'
  latencyDir: string;     // default: '/workspaces/latency'
  latestPlugin: boolean;
}
```

## New helper function

```typescript
/**
 * Detect whether we're running in an external project context
 * (no source repos present) vs multi-repo development.
 */
function isExternalProject(config: BuildConfig): boolean {
  return !existsSync(config.agencyDir) && !existsSync(config.latencyDir);
}
```

No new types, interfaces, or data structures are required. The fix operates on the existing `BuildConfig` and adds logic guards.
