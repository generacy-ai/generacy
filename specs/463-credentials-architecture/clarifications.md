# Clarifications: Core Credential Type Plugins (#463)

## Batch 1 — 2026-04-13

### Q1: Credential Config Access in Mint/Resolve Context
**Context**: `MintContext` provides `credentialId`, `backendKey`, `backend`, `scope`, and `ttl`. `ResolveContext` provides `credentialId`, `backendKey`, and `backend`. However, plugins like `github-app` need credential-specific config fields (`appId`, `installationId`, `privateKey`) that aren't exposed through these context interfaces. The daemon's `session-manager.ts` confirms it only passes `credEntry.backendKey` to the plugin — not the full credential config object.
**Question**: How should plugins access credential-specific config fields at mint/resolve time? Should `MintContext`/`ResolveContext` be extended with a `config` field containing the validated credential config, or should `backendKey` point to a composite secret (JSON blob) that the plugin parses?
**Options**:
- A: Extend `MintContext`/`ResolveContext` with a `config: Record<string, unknown>` field containing the validated credential config from YAML
- B: Use `backendKey` as a composite key — `backend.fetchSecret(backendKey)` returns a JSON blob containing all needed fields (appId, installationId, privateKey, etc.)
- C: Non-secret config fields (appId, installationId) go into `scope`; only the secret reference uses `backendKey`

**Answer**: A — extend `MintContext`/`ResolveContext` with a `config` field.**

```typescript
interface MintContext {
  credentialId: string;
  backendKey: string;
  backend: BackendClient;
  scope: Record<string, unknown>;
  ttl: number;
  config: Record<string, unknown>;  // validated credential entry fields from YAML
}
```

The plugin's `credentialSchema` can define additional YAML fields beyond the common ones (id, type, backend, backendKey, mint). For example, a `github-app` credential might include non-secret fields like `appId` or `installationId` in credentials.yaml — these are config, not secrets, and belong in the YAML declaration. The actual private key comes from the backend via `fetchSecret(backendKey)`.

The `config` field contains the validated credential YAML entry (minus the common structural fields that are already surfaced as dedicated context fields). The plugin gets both: config from YAML for non-secret metadata, and `backend.fetchSecret()` for secret material.

Option B (composite JSON blob from the backend) conflates config and secrets. Option C (non-secret fields in `scope`) misuses scope, which is a role-level concept, not a credential-level one.

---

### Q2: Exposure Rendering — Plugin vs Daemon Responsibility
**Context**: The spec requires each plugin to implement `renderExposure()` for all its declared exposure kinds. However, the daemon's `session-manager.ts` (lines 176-207) only calls `plugin.renderExposure()` for the `env` exposure kind. For `git-credential-helper`, `gcloud-external-account`, and `localhost-proxy`, the daemon renders them directly via its own `ExposureRenderer` class without calling the plugin.
**Question**: Should plugins implement `renderExposure()` for non-env exposure kinds (matching the spec), or should they only handle `env` since the daemon renders the others directly? If plugins should implement them, will the daemon be updated to delegate to `plugin.renderExposure()` for all kinds?
**Options**:
- A: Plugins implement `renderExposure()` for all declared kinds (spec is correct); daemon will be updated to call plugins
- B: Plugins only implement `renderExposure()` for `env`; daemon handles all other kinds (current behavior is intentional)
- C: Split responsibility — plugins render credential-specific parts, daemon wraps with session-specific context (socket paths, etc.)

**Answer**: C — split responsibility.**

Plugins render the **credential-specific** parts. The daemon wraps with **session-specific** infrastructure.

Concretely:
- **`env`**: Plugin returns `{ entries: [{ key: "GITHUB_TOKEN", value: "<token>" }] }`. Daemon writes to the session env file.
- **`git-credential-helper`**: Plugin returns credential data `{ host, protocol, username, password }`. Daemon generates the shell script that pipes this through data.sock, and writes it to the session git/ dir. The plugin doesn't know the data.sock path.
- **`gcloud-external-account`**: Plugin returns GCP-specific fields (audience, token type, etc.). Daemon generates the external account JSON with `credential_source.url` pointing at data.sock.
- **`localhost-proxy`**: Plugin returns `{ upstream, headers }`. Daemon manages the actual proxy lifecycle and port binding.

This gives plugins a clean, testable contract (return credential data) without coupling them to session topology (socket paths, file layout, proxy management). The daemon's `ExposureRenderer` becomes the integration point.

---

### Q3: Core Plugin File Structure and Discovery
**Context**: The plugin loader from #460 discovers plugins by scanning directories for `package.json` files with a `credhelperPlugin` manifest field, matching naming patterns like `generacy-credhelper-plugin-*`. The spec states core plugins are "discovered by path (not by npm package naming convention)" and live inside `packages/credhelper/src/plugins/`.
**Question**: Should each core plugin be structured as its own subdirectory with a `package.json` containing the `credhelperPlugin` manifest (matching the loader's existing discovery mechanism), or should there be a separate registration path for core plugins (e.g., a static import map or index file)?
**Options**:
- A: Each core plugin gets its own subdirectory + `package.json` with `credhelperPlugin` manifest (reuse existing loader)
- B: Core plugins are simple `.ts` files; a static index/map registers them without going through the discovery pipeline
- C: Add a new "core plugin" discovery mode to the loader that scans for `.ts` files exporting `CredentialTypePlugin`

**Answer**: B — core plugins are simple `.ts` files with static registration.**

Core plugins ship with the credhelper and are known at compile time. Running them through the discovery pipeline (directory scanning, package.json parsing, SHA pin verification) adds unnecessary overhead for code that's part of the same package.

```typescript
// packages/credhelper-daemon/src/plugins/core/index.ts
import { githubAppPlugin } from './github-app';
import { githubPatPlugin } from './github-pat';
import { gcpServiceAccountPlugin } from './gcp-service-account';
import { awsStsPlugin } from './aws-sts';
import { stripeRestrictedKeyPlugin } from './stripe-restricted-key';
import { apiKeyPlugin } from './api-key';
import { envPassthroughPlugin } from './env-passthrough';

export const CORE_PLUGINS: CredentialTypePlugin[] = [
  githubAppPlugin, githubPatPlugin, gcpServiceAccountPlugin,
  awsStsPlugin, stripeRestrictedKeyPlugin, apiKeyPlugin, envPassthroughPlugin,
];
```

The plugin loader from #460 handles community plugin discovery. The daemon registers core plugins directly + whatever #460 discovers. Two paths, clean separation.

---

### Q4: aws-sts roleArn in Both Credential and Scope Schemas
**Context**: The spec defines `roleArn` in both the `credentialSchema` (validates `roleArn`, `externalId?`, `region?`) and the `scopeSchema` (validates `roleArn: string`, `sessionPolicy?: object`) for the `aws-sts` plugin. This creates ambiguity about which `roleArn` the plugin should use when calling STS AssumeRole.
**Question**: What is the intended relationship between `roleArn` in the credential config vs. the role scope?
**Options**:
- A: Credential `roleArn` is the default; scope `roleArn` overrides it per-role (scope takes precedence)
- B: They are different — credential `roleArn` defines the trust/assume config, scope `roleArn` is what's actually assumed (but this doesn't match STS semantics)
- C: `roleArn` should only be in one schema — remove from `credentialSchema` and keep in `scopeSchema` only (or vice versa)

**Answer**: C — `roleArn` only in `credentialSchema`, remove from `scopeSchema`.**

In AWS STS, `roleArn` identifies which IAM role to assume — that's a fixed property of the credential, not something that varies per role. If different roles need different AWS IAM roles, create separate credential entries (one per AWS IAM role).

What varies per role is the **session policy** (a permissions restriction applied on top of the assumed role's permissions). So:

- `credentialSchema`: `{ roleArn: string, externalId?: string, region?: string }` — fixed trust config
- `scopeSchema`: `{ sessionPolicy?: object, durationSeconds?: number }` — per-role restrictions

This matches AWS STS semantics: AssumeRole takes a role ARN (fixed) plus an optional session policy (variable).

---

### Q5: env-passthrough backendKey Mapping
**Context**: The `env-passthrough` credential schema validates `envVar: string`. The spec says the plugin reads `process.env[backendKey]` without a backend client call. But `ResolveContext` provides `backendKey` as a field set by the daemon from `credEntry.backendKey` — it's unclear how `envVar` from the credential config maps to this.
**Question**: For `env-passthrough`, is the daemon expected to set `credEntry.backendKey` to the value of `envVar` from the credential config (making `process.env[ctx.backendKey]` correct), or does the plugin need to access the `envVar` field from the credential config separately (which circles back to Q1)?

**Answer**: `backendKey` in credentials.yaml IS the env var name — the `envVar` field is unnecessary.**

For env-passthrough, the credentials.yaml looks like:
```yaml
- id: github-token
  type: env-passthrough
  backend: env
  backendKey: GITHUB_TOKEN
```

The `env` backend's `fetchSecret("GITHUB_TOKEN")` reads `process.env["GITHUB_TOKEN"]`. The plugin calls `ctx.backend.fetchSecret(ctx.backendKey)` and gets the value. No extra field needed.

If the spec generated an `envVar` field in the credential schema, **remove it** — it's redundant with `backendKey`, which is the standard field all credential types use to reference their backend secret. The env-passthrough plugin's `credentialSchema` should validate just the common fields (or be empty/minimal), not introduce a duplicate key.
