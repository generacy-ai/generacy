# Clarifications — #462 Config File Loading & Validation

## Batch 1 — 2026-04-13

### Q1: Plugin Registry for Exposure Validation
**Context**: FR-009 requires validating that each role's exposure kinds are supported by the credential's plugin (`supportedExposures`). The `CredentialTypePlugin` interface defines `supportedExposures` as a runtime property on plugin instances, but at config-loading time plugins may not be instantiated yet.
**Question**: Should the config loader receive a plugin registry as a constructor dependency to perform exposure validation at load time, or should exposure-against-plugin validation be deferred to a separate step after plugins are loaded?
**Options**:
- A: Loader receives a plugin registry (or a `Map<string, ExposureKind[]>`) and validates immediately
- B: Loader validates schema structure only; exposure-against-plugin validation is a separate post-load step
- C: Loader accepts an optional registry — validates if provided, skips if not

**Answer**: *Pending*

### Q2: Backend Cross-Reference Validation
**Context**: Each credential entry has a `backend` field referencing a backend id. The spec lists ref validation for roles→credentials (FR-008) but does not explicitly list cross-validation of credentials→backends.
**Question**: Should the config loader validate that each credential's `backend` value matches an `id` declared in `backends.yaml`? This cross-file reference isn't explicitly listed in the FRs but seems like a natural consistency check.
**Options**:
- A: Yes — validate credentials→backend references as part of config loading (add to FRs)
- B: No — backend reference validation happens at runtime when secrets are actually fetched

**Answer**: *Pending*

### Q3: Error Accumulation Strategy
**Context**: FR-015 says "fail closed on any validation error" and FR-014 requires all errors to include file/line/field. The spec doesn't clarify whether the loader should report multiple errors at once or abort on the first.
**Question**: Should the loader collect all validation errors across all files and report them in a single batch (better developer experience — fix everything in one pass), or abort on the first error encountered?
**Options**:
- A: Collect all errors across all files, then fail with the complete list
- B: Fail on first error encountered (simpler implementation)
- C: Collect errors per-file but stop loading subsequent files on first file failure

**Answer**: *Pending*

### Q4: Roles Directory Optionality
**Context**: `backends.yaml` and `credentials.yaml` are explicitly marked as required files. The spec says to glob `.agency/roles/*.yaml` but doesn't state whether the directory itself or any role files are required.
**Question**: Is the `.agency/roles/` directory required to exist? What's the expected behavior if it doesn't exist or contains no YAML files — is an empty-roles configuration valid, or should it be an error?
**Options**:
- A: Directory is required and must contain at least one role file
- B: Directory is optional — missing directory or zero files means no roles (valid config)
- C: Directory is required but may be empty (zero role files is valid)

**Answer**: *Pending*

### Q5: Trusted-Plugins Cross-Validation
**Context**: `trusted-plugins.yaml` pins non-core plugins by SHA-256. The spec says it's "only needed if non-core plugins are used" but doesn't specify what constitutes a "core" vs "non-core" plugin, or whether the loader should cross-check credential types against the trust store.
**Question**: Should the config loader validate that credential types referencing non-core plugins have corresponding entries in `trusted-plugins.yaml`? If so, how does the loader distinguish core from non-core plugins — is there a hardcoded list, or is it derived from the plugin registry?
**Options**:
- A: Loader cross-validates credential types against trusted-plugins when the file exists (needs a core plugin list)
- B: Trust validation is a separate concern handled at plugin load time, not during config loading
- C: Loader validates the file's schema only; cross-referencing is out of scope for this phase

**Answer**: *Pending*
