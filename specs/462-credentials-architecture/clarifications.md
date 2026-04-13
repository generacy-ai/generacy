# Clarifications — #462 Config File Loading & Validation

## Batch 1 — 2026-04-13

### Q1: Plugin Registry for Exposure Validation
**Context**: FR-009 requires validating that each role's exposure kinds are supported by the credential's plugin (`supportedExposures`). The `CredentialTypePlugin` interface defines `supportedExposures` as a runtime property on plugin instances, but at config-loading time plugins may not be instantiated yet.
**Question**: Should the config loader receive a plugin registry as a constructor dependency to perform exposure validation at load time, or should exposure-against-plugin validation be deferred to a separate step after plugins are loaded?
**Options**:
- A: Loader receives a plugin registry (or a `Map<string, ExposureKind[]>`) and validates immediately
- B: Loader validates schema structure only; exposure-against-plugin validation is a separate post-load step
- C: Loader accepts an optional registry — validates if provided, skips if not

**Answer**: C — accept an optional registry.**

```typescript
function loadConfig(options: {
  agencyDir: string;
  pluginRegistry?: Map<string, ExposureKind[]>;  // optional
}): ConfigResult
```

The config loader's primary job is reading and validating files. Exposure-against-plugin validation is a cross-cutting concern that depends on both config and plugins being loaded. Making the registry optional keeps the loader testable in isolation (unit tests don't need to mock a plugin registry) while allowing the daemon boot sequence to pass the real registry for full validation.

When the registry is provided: validate that every role's exposure kinds are in the credential's plugin `supportedExposures`. When absent: skip exposure validation (schema-level validation still catches structural errors like invalid `kind` values).

---

### Q2: Backend Cross-Reference Validation
**Context**: Each credential entry has a `backend` field referencing a backend id. The spec lists ref validation for roles→credentials (FR-008) but does not explicitly list cross-validation of credentials→backends.
**Question**: Should the config loader validate that each credential's `backend` value matches an `id` declared in `backends.yaml`? This cross-file reference isn't explicitly listed in the FRs but seems like a natural consistency check.
**Options**:
- A: Yes — validate credentials→backend references as part of config loading (add to FRs)
- B: No — backend reference validation happens at runtime when secrets are actually fetched

**Answer**: A — yes, validate credential→backend references during config loading.**

The loader already validates role→credential refs. Credential→backend refs are the same kind of cross-file reference validation and should be caught at the same time. A typo in a `backend` field should surface at config load (boot) — not when a workflow first tries to use that credential minutes or hours later.

Add to the cross-reference validation step: for each credential, check that `credential.backend` matches a `backend.id` in the loaded `backends.yaml`. Same pattern as role→credential validation.

---

### Q3: Error Accumulation Strategy
**Context**: FR-015 says "fail closed on any validation error" and FR-014 requires all errors to include file/line/field. The spec doesn't clarify whether the loader should report multiple errors at once or abort on the first.
**Question**: Should the loader collect all validation errors across all files and report them in a single batch (better developer experience — fix everything in one pass), or abort on the first error encountered?
**Options**:
- A: Collect all errors across all files, then fail with the complete list
- B: Fail on first error encountered (simpler implementation)
- C: Collect errors per-file but stop loading subsequent files on first file failure

**Answer**: A — collect all errors across all files, then fail with the complete list.**

Developer experience matters here. Config files are small and loaded once at boot — there's no performance concern with continuing to validate after the first error. Failing on first error means: fix one thing → re-run → get another error → fix → re-run... That's painful when there are multiple issues (e.g. a new role references two missing credentials and a nonexistent backend).

Implementation is straightforward: accumulate errors in an array instead of throwing. At the end, if the array is non-empty, throw a single `ConfigValidationError` containing all of them. Each error should include file path, field path, and message (per the spec's error reporting requirement).

---

### Q4: Roles Directory Optionality
**Context**: `backends.yaml` and `credentials.yaml` are explicitly marked as required files. The spec says to glob `.agency/roles/*.yaml` but doesn't state whether the directory itself or any role files are required.
**Question**: Is the `.agency/roles/` directory required to exist? What's the expected behavior if it doesn't exist or contains no YAML files — is an empty-roles configuration valid, or should it be an error?
**Options**:
- A: Directory is required and must contain at least one role file
- B: Directory is optional — missing directory or zero files means no roles (valid config)
- C: Directory is required but may be empty (zero role files is valid)

**Answer**: B — optional. Missing or empty means no roles (valid config).**

A project might start with just `credentials.yaml` and `backends.yaml` using the `env` backend — no roles defined yet. The `scaffold-legacy` command (generacy-ai/tetrad-development#60) generates a legacy role, but projects that haven't run it yet shouldn't fail to boot.

No roles = workflows run without credential scoping (current behavior, backwards-compatible). The directory and roles become functionally required only when `defaults.role` is set in `.generacy/config.yaml` — but that's the orchestrator's concern (the AgentLauncher interceptor checks for a role and skips credentials when none is configured), not the config loader's. The loader should be permissive; the daemon and orchestrator enforce policy.

---

### Q5: Trusted-Plugins Cross-Validation
**Context**: `trusted-plugins.yaml` pins non-core plugins by SHA-256. The spec says it's "only needed if non-core plugins are used" but doesn't specify what constitutes a "core" vs "non-core" plugin, or whether the loader should cross-check credential types against the trust store.
**Question**: Should the config loader validate that credential types referencing non-core plugins have corresponding entries in `trusted-plugins.yaml`? If so, how does the loader distinguish core from non-core plugins — is there a hardcoded list, or is it derived from the plugin registry?
**Options**:
- A: Loader cross-validates credential types against trusted-plugins when the file exists (needs a core plugin list)
- B: Trust validation is a separate concern handled at plugin load time, not during config loading
- C: Loader validates the file's schema only; cross-referencing is out of scope for this phase

**Answer**: B — trust validation happens at plugin load time (#460), not during config loading.**

The config loader doesn't know which plugins are core vs. non-core — that distinction is a function of where they're installed on disk:
- Core: `/usr/local/lib/generacy-credhelper/` (baked into the container image)
- Community: `.agency/secrets/plugins/node_modules/` (installed by the developer)

The loader reads `trusted-plugins.yaml`, validates its schema, and produces a `Map<string, string>` of name→SHA pin. That map is passed to the plugin loader (#460), which uses it during its SHA256 verification step. The config loader doesn't need to understand the trust model — it just parses the file.

Cross-referencing credential types against trusted plugins would require the loader to know the plugin discovery results, creating a circular dependency between #460 and #462. Keep the concerns separate: #462 loads config, #460 loads plugins, and the daemon (#461) cross-validates at boot.
