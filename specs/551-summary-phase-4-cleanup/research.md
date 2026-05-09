# Research: Phase 4 Cleanup — Remove `GENERACY_CLOUD_URL` Fallback Chains

## Technology Decisions

### 1. Commander.js Hidden Alias Pattern

**Decision**: Use Commander.js `hideHelp` + custom option aliasing for `--cloud-url` → `--api-url` migration.

**Rationale**: Commander.js doesn't natively support "hidden alias with deprecation warning." The recommended pattern is:
- Register `--api-url <url>` as the canonical option
- Register `--cloud-url <url>` as a separate hidden option (`.hideHelp()`)
- In the action handler, check if `--cloud-url` was used, print deprecation warning, and copy its value to `apiUrl`

**Alternative considered**: Using Commander's built-in `--cloud-url` as an alias via `.alias()` — rejected because `.alias()` is for command aliases, not option aliases.

**Implementation pattern**:
```typescript
command
  .option('--api-url <url>', 'Cloud API URL (overrides GENERACY_API_URL env var)')
  .addOption(
    new Option('--cloud-url <url>', 'Deprecated: use --api-url')
      .hideHelp()
  )
  .action(async (opts) => {
    if (opts.cloudUrl && !opts.apiUrl) {
      console.warn('[deprecated] --cloud-url is deprecated, use --api-url');
      opts.apiUrl = opts.cloudUrl;
    }
    const cloudUrl = resolveApiUrl(opts.apiUrl);
    // ...
  });
```

### 2. Orchestrator Fail-Loud Strategy

**Decision**: Throw a descriptive error at config load time when `GENERACY_API_URL` is missing in orchestrator context.

**Rationale**: The orchestrator runs unattended inside a Docker container. Missing env vars indicate a scaffolding bug — silent fallback to a default URL could connect to the wrong endpoint. Failing loud at startup surfaces the problem immediately.

**Pattern**: The orchestrator config loader already has precedent for required env vars (e.g., `GENERACY_API_KEY` for relay). Follow the same pattern: check after all env var reads, throw if required vars are unset.

**CLI exemption**: The CLI runs interactively and defaults to production (`https://api.generacy.ai`). Requiring explicit env var configuration would be pure friction with no safety benefit.

### 3. Negative Test Assertions

**Decision**: Add explicit tests verifying `GENERACY_CLOUD_URL` is NOT read.

**Pattern**:
```typescript
it('should NOT fall back to GENERACY_CLOUD_URL', () => {
  process.env['GENERACY_CLOUD_URL'] = 'https://old.example.com';
  delete process.env['GENERACY_API_URL'];
  const url = resolveApiUrl();
  expect(url).toBe('https://api.generacy.ai'); // default, not old var
  delete process.env['GENERACY_CLOUD_URL'];
});
```

This ensures future contributors don't accidentally reintroduce the fallback.

## Key Sources

- #549 — Umbrella issue for cloud URL disambiguation
- #545 — Original `--cloud-url` flag addition and `resolveCloudUrl` → `resolveApiUrl` rename
- Commander.js docs: [Options](https://github.com/tj/commander.js#options) — `hideHelp()` method
- Existing codebase patterns in `cloud-url.ts`, `loader.ts`
