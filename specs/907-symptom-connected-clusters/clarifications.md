# Clarifications

## Batch 1 — 2026-07-10

### Q1: `0.0.0` fallback collision
**Context**: FR-004 lists `package.json` as an acceptable fallback source. In this monorepo, `packages/orchestrator/package.json` is likely to declare `"version": "0.0.0"` (workspace default). If the build-time env var is missing and the fallback reads `"0.0.0"` from disk, the handler would emit the literal string `"0.0.0"` — indistinguishable from the pre-fix bug. This directly conflicts with FR-003 ("Never emit the literal `\"0.0.0\"` from the handler when a real value is resolvable") and with the intent of FR-005 (sentinel behaviour).
**Question**: When a fallback source (e.g. `package.json`) resolves to the literal string `"0.0.0"`, should the handler treat it as "no real version resolved" and emit the FR-005 sentinel instead?
**Options**:
- A: Yes — the string `"0.0.0"` from *any* source is treated as unresolved; emit the sentinel.
- B: No — pass through whatever the source returns verbatim, even the literal `"0.0.0"`.
- C: Only the *fallback* source (package.json) is subject to the `"0.0.0"` guard; the env var is trusted verbatim (so operators can force `"0.0.0"` for testing).

**Answer**: *Pending*

### Q2: Sentinel string exact value
**Context**: FR-005 requires a sentinel "clearly distinguishable from `\"0.0.0\"`" when no version source is resolvable, and suggests `"unknown"` as an example. The exact string affects the FR-007 test assertion, the dashboard's rendering, and how operators grep logs for misconfigured clusters. Fixing it now avoids drift between the test and the handler.
**Question**: What exact sentinel string should the handler emit when no version source is resolvable?
**Options**:
- A: `"unknown"` (the FR-005 example — shortest, human-obvious)
- B: `"unknown-version"` (more grep-safe / less collision-prone)
- C: `"0.0.0-unknown"` (semver-parseable but flagged)
- D: `"dev"` (matches common conventions for un-tagged local builds)

**Answer**: *Pending*

### Q3: Canonical env var name
**Context**: FR-004 uses `ORCHESTRATOR_VERSION` as an *example* env var name. Whatever name we pick has to be wired into the image publish workflows (`.github/workflows/publish-cluster-*.yml`) and possibly `poll-cluster-images.yml`, and any container entrypoint scripts that forward it. Locking this in now avoids rework during `/plan` and keeps the cross-repo Docker build change coherent.
**Question**: What is the canonical env var name the `/health` handler should read for the build-time version identifier?
**Options**:
- A: `ORCHESTRATOR_VERSION` (as in the FR-004 example — orchestrator-scoped)
- B: `GENERACY_VERSION` (shared across all in-cluster components; other components can adopt it later)
- C: `ORCHESTRATOR_BUILD_SHA` (git SHA specifically, matching the `sha-<short>` immutable image tag from `publish-cluster-*.yml`)
- D: Two env vars — `ORCHESTRATOR_VERSION` (semver-ish) with `ORCHESTRATOR_BUILD_SHA` (git SHA), reported together (e.g. `"1.2.3+sha.01a2545"`)

**Answer**: *Pending*

### Q4: Version string format contract
**Context**: SC-002 requires `version` be a non-empty string but does not constrain its shape. The cloud dashboard displays it, and version-based rollout monitoring (SC-001 — "preview vs. stable") may need to *parse* it to detect drift. If some clusters report semver and others report `sha-<short>`, the dashboard rendering and any tooling that compares versions across clusters becomes lossy.
**Question**: What format constraint (if any) should the `version` string satisfy?
**Options**:
- A: Semver only (e.g. `1.2.3` or `1.2.3-preview`) — reject/skip non-semver sources
- B: Git SHA short form (e.g. `sha-01a2545`, matching the `sha-<short>` image tag scheme)
- C: Any non-empty string — dashboard renders as-is, no format contract
- D: A composite like `<channel>-<sha>` (e.g. `preview-01a2545`) or `<version>+sha.<short>` — carries both build identity and rollout channel

**Answer**: *Pending*

### Q5: Scope — is `version` the only stripped field to fix?
**Context**: `packages/cluster-relay/src/metadata.ts` also reads `channel` and `uptime` from `/health` and falls back to defaults (`'stable'`, `0`) — the *current* `/health` schema (lines 68-99) declares neither, and the *current* handler (lines 131-137) populates neither. So the `?? '0.0.0'` fallback on `version` is only the most visible instance of a broader schema-strip / handler-omission bug: `channel` and `uptime` are silently defaulted on every cluster today. If we only patch `version`, the dashboard's `channel` badge and `uptime` remain wrong indefinitely.
**Question**: Is this feature strictly limited to `version`, or should the same schema-declare + handler-populate pattern also be applied to `channel` and `uptime` in the same PR?
**Options**:
- A: `version` only — `channel`/`uptime` are explicitly out of scope; log a follow-up issue
- B: `version` + `channel` (channel matters for rollout monitoring / preview vs. stable)
- C: All three (`version`, `channel`, `uptime`) — fix the schema-strip class-of-bug fully in one shot
- D: `version` only, but expand the FR-007 test to *also* assert `channel` and `uptime` are present so the follow-up can't regress silently

**Answer**: *Pending*
