# Clarifications: Core Credential Type Plugins (#463)

## Batch 1 — 2026-04-13

### Q1: Credential Config Access in Mint/Resolve Context
**Context**: `MintContext` provides `credentialId`, `backendKey`, `backend`, `scope`, and `ttl`. `ResolveContext` provides `credentialId`, `backendKey`, and `backend`. However, plugins like `github-app` need credential-specific config fields (`appId`, `installationId`, `privateKey`) that aren't exposed through these context interfaces. The daemon's `session-manager.ts` confirms it only passes `credEntry.backendKey` to the plugin — not the full credential config object.
**Question**: How should plugins access credential-specific config fields at mint/resolve time? Should `MintContext`/`ResolveContext` be extended with a `config` field containing the validated credential config, or should `backendKey` point to a composite secret (JSON blob) that the plugin parses?
**Options**:
- A: Extend `MintContext`/`ResolveContext` with a `config: Record<string, unknown>` field containing the validated credential config from YAML
- B: Use `backendKey` as a composite key — `backend.fetchSecret(backendKey)` returns a JSON blob containing all needed fields (appId, installationId, privateKey, etc.)
- C: Non-secret config fields (appId, installationId) go into `scope`; only the secret reference uses `backendKey`

**Answer**: *Pending*

### Q2: Exposure Rendering — Plugin vs Daemon Responsibility
**Context**: The spec requires each plugin to implement `renderExposure()` for all its declared exposure kinds. However, the daemon's `session-manager.ts` (lines 176-207) only calls `plugin.renderExposure()` for the `env` exposure kind. For `git-credential-helper`, `gcloud-external-account`, and `localhost-proxy`, the daemon renders them directly via its own `ExposureRenderer` class without calling the plugin.
**Question**: Should plugins implement `renderExposure()` for non-env exposure kinds (matching the spec), or should they only handle `env` since the daemon renders the others directly? If plugins should implement them, will the daemon be updated to delegate to `plugin.renderExposure()` for all kinds?
**Options**:
- A: Plugins implement `renderExposure()` for all declared kinds (spec is correct); daemon will be updated to call plugins
- B: Plugins only implement `renderExposure()` for `env`; daemon handles all other kinds (current behavior is intentional)
- C: Split responsibility — plugins render credential-specific parts, daemon wraps with session-specific context (socket paths, etc.)

**Answer**: *Pending*

### Q3: Core Plugin File Structure and Discovery
**Context**: The plugin loader from #460 discovers plugins by scanning directories for `package.json` files with a `credhelperPlugin` manifest field, matching naming patterns like `generacy-credhelper-plugin-*`. The spec states core plugins are "discovered by path (not by npm package naming convention)" and live inside `packages/credhelper/src/plugins/`.
**Question**: Should each core plugin be structured as its own subdirectory with a `package.json` containing the `credhelperPlugin` manifest (matching the loader's existing discovery mechanism), or should there be a separate registration path for core plugins (e.g., a static import map or index file)?
**Options**:
- A: Each core plugin gets its own subdirectory + `package.json` with `credhelperPlugin` manifest (reuse existing loader)
- B: Core plugins are simple `.ts` files; a static index/map registers them without going through the discovery pipeline
- C: Add a new "core plugin" discovery mode to the loader that scans for `.ts` files exporting `CredentialTypePlugin`

**Answer**: *Pending*

### Q4: aws-sts roleArn in Both Credential and Scope Schemas
**Context**: The spec defines `roleArn` in both the `credentialSchema` (validates `roleArn`, `externalId?`, `region?`) and the `scopeSchema` (validates `roleArn: string`, `sessionPolicy?: object`) for the `aws-sts` plugin. This creates ambiguity about which `roleArn` the plugin should use when calling STS AssumeRole.
**Question**: What is the intended relationship between `roleArn` in the credential config vs. the role scope?
**Options**:
- A: Credential `roleArn` is the default; scope `roleArn` overrides it per-role (scope takes precedence)
- B: They are different — credential `roleArn` defines the trust/assume config, scope `roleArn` is what's actually assumed (but this doesn't match STS semantics)
- C: `roleArn` should only be in one schema — remove from `credentialSchema` and keep in `scopeSchema` only (or vice versa)

**Answer**: *Pending*

### Q5: env-passthrough backendKey Mapping
**Context**: The `env-passthrough` credential schema validates `envVar: string`. The spec says the plugin reads `process.env[backendKey]` without a backend client call. But `ResolveContext` provides `backendKey` as a field set by the daemon from `credEntry.backendKey` — it's unclear how `envVar` from the credential config maps to this.
**Question**: For `env-passthrough`, is the daemon expected to set `credEntry.backendKey` to the value of `envVar` from the credential config (making `process.env[ctx.backendKey]` correct), or does the plugin need to access the `envVar` field from the credential config separately (which circles back to Q1)?

**Answer**: *Pending*
