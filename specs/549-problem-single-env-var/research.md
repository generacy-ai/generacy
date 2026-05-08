# Research: Disambiguate `GENERACY_CLOUD_URL`

**Issue**: #549 | **Branch**: `549-problem-single-env-var`

## Technology Decisions

### 1. Deprecation logging pattern

**Decision**: Debug-level, once-per-process deprecation log via module-scoped flag.

**Rationale**: The codebase uses Pino for logging. A module-level `let warned = false` flag ensures the deprecation message fires once per process lifetime, avoiding log spam. Debug level is appropriate because this is informational for operators, not an error.

**Pattern**:
```ts
let deprecationLogged = false;
function resolveApiUrl(flagValue?: string): string {
  if (flagValue) return flagValue;
  const apiUrl = process.env['GENERACY_API_URL'];
  if (apiUrl) return apiUrl;
  const legacyUrl = process.env['GENERACY_CLOUD_URL'];
  if (legacyUrl) {
    if (!deprecationLogged) {
      logger.debug('[deprecated] GENERACY_CLOUD_URL is ambiguous, prefer GENERACY_API_URL');
      deprecationLogged = true;
    }
    return legacyUrl;
  }
  return 'https://api.generacy.ai';
}
```

**Alternatives considered**:
- `process.emitWarning()` — Too noisy for production, shows stack trace
- Warn level — Too prominent for a non-breaking deprecation
- No log at all — Operators would never know to migrate

### 2. Schema evolution strategy (Zod)

**Decision**: Optional `cloud` object alongside deprecated `cloudUrl`, using Zod `.optional()`.

**Rationale**: The cloud-side `LaunchConfig` response may or may not include the new `cloud` object depending on deployment timing. Using `.optional()` means both old and new responses parse without error. Consumers use `config.cloud?.apiUrl ?? config.cloudUrl` pattern.

**Pattern**:
```ts
const CloudUrlsSchema = z.object({
  apiUrl: z.string().url(),
  appUrl: z.string().url(),
  relayUrl: z.string().url(),
});

export const LaunchConfigSchema = z.object({
  // ... existing fields ...
  cloudUrl: z.string().url(),           // deprecated, kept for compat
  cloud: CloudUrlsSchema.optional(),    // new, preferred when present
});
```

**Alternatives considered**:
- Zod `.transform()` to normalize — Adds hidden complexity, harder to debug
- Union type (old shape | new shape) — Overly complex, same runtime behavior
- Required `cloud` field — Would break with old cloud responses

### 3. Env var file generation (scaffolder)

**Decision**: Conditional generation based on `LaunchConfig.cloud` presence.

**Rationale**: The scaffolder must work in two modes:
1. **New cloud** (has `cloud` object): Write `cloud.apiUrl` and `cloud.relayUrl` directly
2. **Old cloud** (no `cloud` object): Derive using existing `deriveRelayUrl()` from `cloudUrl`

Both modes write `GENERACY_API_URL` and `GENERACY_RELAY_URL` (never the old `GENERACY_CLOUD_URL`). The difference is only whether URLs are cloud-provided or locally derived.

### 4. Registry field naming

**Decision**: Keep `cloudUrl` field name in `RegistryEntrySchema` / `~/.generacy/clusters.json`.

**Rationale**: This is persisted data. Renaming would require a migration of all existing `clusters.json` files or a version-aware loader. The field stores what was originally the app URL (for `generacy open` browser deep-links). The value is correct — only the env var name was ambiguous, not the registry storage. Renaming the field is deferred to Phase 4 cleanup if desired.

### 5. Function rename: `resolveCloudUrl` → `resolveApiUrl`

**Decision**: Rename the internal helper function to match its actual purpose.

**Rationale**: `resolveCloudUrl()` in `cloud-url.ts` resolves an HTTP API URL, not a generic "cloud URL." Renaming to `resolveApiUrl()` aligns with the new naming convention. This is internal — no external API break. All callers (launch `index.ts`, deploy `index.ts`) are updated in the same PR.

## Key Sources

- Issue #549 spec and clarifications
- Existing codebase patterns (Pino logging, Zod schemas, atomic file writes)
- Node.js `process.env` reading conventions
