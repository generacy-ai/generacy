# Clarifications: Phase 4 Cleanup — Remove `GENERACY_CLOUD_URL` Fallback Chains

## Batch 1 — 2026-05-09

### Q1: CLI Flag Rename (`--cloud-url` → `--api-url`)
**Context**: The #549 spec explicitly stated: "The flag should be renamed `--api-url` once this issue lands, since 'cloud URL' is now ambiguous." However, the #551 spec does not mention this rename. Both `launch` and `deploy` commands currently register `--cloud-url`, and their help text references `GENERACY_CLOUD_URL`. This is a user-facing CLI breaking change.
**Question**: Should the `--cloud-url` CLI flag be renamed to `--api-url` as part of this PR, or is it intentionally deferred?
**Options**:
- A: Rename to `--api-url` in this PR (matches #549's stated intent, single breaking change alongside env var removal)
- B: Keep `--cloud-url` flag name, only update its help text to reference `GENERACY_API_URL` (non-breaking, flag name is already established)
- C: Rename to `--api-url` and keep `--cloud-url` as a hidden alias for one release cycle

**Answer**: **C** — Rename to `--api-url` and keep `--cloud-url` as a hidden alias for one release cycle. The flag has no prior deprecation cycle (added by #545); removing without transition breaks scripts. Add `--api-url` as canonical, keep `--cloud-url` hidden with deprecation warning, file follow-up to remove after one release. SC-001 targets the env var name; flag rename tracked separately.

### Q2: CLI Default URL vs US2 Error Requirement
**Context**: `resolveApiUrl()` in `cloud-url.ts` falls back to `https://api.generacy.ai` when no env var or flag is set. This default is convenient for CLI users targeting production. However, US2's acceptance criteria state: "Missing `GENERACY_API_URL` produces a clear error (not silent fallback)." These seem contradictory in the CLI context. In the orchestrator context (where env vars come from compose), requiring explicit configuration makes sense.
**Question**: Does US2's "clear error on missing env var" apply only to the orchestrator (in-cluster) context, or should the CLI also drop its default and require explicit `GENERACY_API_URL` / `--api-url`?
**Options**:
- A: US2 applies only to the orchestrator — CLI keeps its `https://api.generacy.ai` default (recommended, no UX regression for CLI users)
- B: US2 applies everywhere — CLI also requires explicit configuration (breaking change for all CLI users)

**Answer**: **A** — US2 applies only to the orchestrator; CLI keeps `https://api.generacy.ai` default. Orchestrator runs unattended (missing config = upstream bug), CLI runs interactively (requiring explicit config is pure friction). Spec should scope US2 to orchestrator context only.

### Q3: File and Export Cleanup Scope
**Context**: Beyond the 3 fallback chains enumerated in scope, SC-001 says "Zero references to `GENERACY_CLOUD_URL` in generacy repo." A grep reveals additional references: (1) `cloud-client.ts:132` has a user-facing 404 error message telling users to "Set GENERACY_CLOUD_URL", (2) `resolveCloudUrl` deprecated alias export in `cloud-url.ts:40`, (3) CLI option descriptions in `launch/index.ts:39` and `deploy/index.ts:114` say "overrides GENERACY_CLOUD_URL env var", (4) test files asserting `GENERACY_CLOUD_URL` behavior. Are all of these in scope per SC-001, or should the PR stick to the 3 enumerated items?
**Question**: Should this PR chase down every `GENERACY_CLOUD_URL` reference in the repo (per SC-001's zero-hits target), or only address the 3 fallback chains listed in scope?
**Options**:
- A: Chase all references — SC-001 is the definitive criterion (recommended, otherwise SC-001 can't pass)
- B: Only the 3 enumerated fallback chains — additional references are follow-up work

**Answer**: **A** — Chase all references. The 3 enumerated chains were a starting list, not exhaustive. Handle: (1) update error messages to reference `GENERACY_API_URL`, (2) remove `resolveCloudUrl` deprecated alias, (3) update CLI option descriptions, (4) update tests with new env var name + add negative assertions for old name. Refined SC-001: zero refs in `src/` excluding tests; tests contain only negative assertions verifying old name is rejected.
