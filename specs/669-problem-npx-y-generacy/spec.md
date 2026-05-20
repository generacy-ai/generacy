# Bug: publish pipeline leaks `workspace:^` into published tarballs

**Branch**: `669-problem-npx-y-generacy` | **Date**: 2026-05-20 | **Status**: Draft | **Issue**: [#669](https://github.com/generacy-ai/generacy/issues/669)

## Summary

`npx -y @generacy-ai/generacy@stable launch --claim=...` fails on fresh user machines because the published `@generacy-ai/orchestrator@0.1.1` tarball contains literal `workspace:^` dependency placeholders instead of resolved semver ranges. This is a pnpm-only protocol that npm/yarn cannot resolve, causing a hard install failure that blocks the entire onboarding flow.

## Problem

The release pipeline (`.github/workflows/release.yml`) uses `pnpm changeset publish --tag stable --provenance`. During the publish of `@generacy-ai/orchestrator@0.1.1`, the `workspace:^` protocol references for 7 internal dependencies were not rewritten to semver ranges:

- `@generacy-ai/activation-client`
- `@generacy-ai/cluster-relay`
- `@generacy-ai/config`
- `@generacy-ai/control-plane`
- `@generacy-ai/credhelper`
- `@generacy-ai/generacy-plugin-claude-code`
- `@generacy-ai/workflow-engine`

The sibling package `@generacy-ai/generacy@0.1.3` had its deps correctly rewritten (e.g., `@generacy-ai/orchestrator: 0.1.1`), indicating the bug is specific to how `pnpm changeset publish` handles auto-bumped transitive packages.

### Root Cause Analysis

Two plausible failure modes in the `changesets/action@v1` integration:

1. **Version step gap**: With `updateInternalDependencies: "patch"` in `.changeset/config.json`, orchestrator was auto-bumped (0.1.0 -> 0.1.1) as a dependent of a changed package. In some Changesets versions, auto-bumped packages get their `version` field rewritten but `workspace:` deps do not get resolved.

2. **Publish delegation**: `pnpm changeset publish` may invoke `npm publish` internally instead of `pnpm publish`, skipping the workspace-protocol rewrite entirely. `npm publish` has no concept of `workspace:` and publishes the literal string.

### Compounding Issue: Unpublished Stable Tags

Even after fixing the `workspace:^` rewrite, orchestrator's deps point at packages that have ONLY been published as preview snapshots (never tagged stable): `cluster-relay`, `control-plane`, `credhelper`, `generacy-plugin-claude-code`. These must be brought into the stable release cycle or decoupled from orchestrator's runtime dep tree.

### Architectural Concern: Orchestrator as CLI Runtime Dep

`@generacy-ai/generacy` (the CLI) depends on `@generacy-ai/orchestrator` at runtime (`"workspace:*"`). Orchestrator pulls in `@fastify/*`, `fastify`, `ioredis`, `prom-client` — a ~50-100MB server bundle installed on every `npx generacy launch`. Since the CLI talks to orchestrator running inside the cluster container, it likely only needs type definitions or an API client, not the full server code. This is a separate follow-up issue.

## Reproduction

```bash
# Tarball inspection
npm pack @generacy-ai/orchestrator@0.1.1
tar -xzf generacy-ai-orchestrator-0.1.1.tgz
jq .dependencies package/package.json
# -> shows workspace:^ literals

# End-user failure
npx -y @generacy-ai/generacy@stable launch --claim=<any-valid-claim>
# -> npm error, exit 1 (hits workspace:^ entries)
```

## User Stories

### US1: First-time user onboarding

**As a** new Generacy user following the onboarding flow,
**I want** `npx -y @generacy-ai/generacy@stable launch --claim=<code>` to install and run successfully,
**So that** I can bootstrap my first cluster without manual workarounds.

**Acceptance Criteria**:
- [ ] `npx -y @generacy-ai/generacy@stable launch` installs without dependency resolution errors on a machine with only npm (no pnpm)
- [ ] All `@generacy-ai/*` dependencies in published tarballs contain valid semver ranges, not `workspace:` protocols
- [ ] The `@stable` dist-tag points to a working version of every published package

### US2: Release pipeline reliability

**As a** Generacy maintainer running the release workflow,
**I want** the CI pipeline to guarantee `workspace:` protocols are rewritten before publish,
**So that** broken packages can never reach the npm registry.

**Acceptance Criteria**:
- [ ] A CI validation step fails the release if any `package.json` in the publish set still contains `workspace:` references
- [ ] All workspace packages with inter-package dependencies are correctly included in the Changesets versioning loop

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Republish `@generacy-ai/orchestrator` with `workspace:^` replaced by resolved semver ranges | P0 | Immediate unblock |
| FR-002 | Bump `@generacy-ai/generacy` to depend on the fixed orchestrator version and republish stable | P0 | Immediate unblock |
| FR-003 | Add a CI validation step that scans all `package.json` files in publish candidates for `workspace:` literals and fails the build if found | P1 | Pipeline fix |
| FR-004 | Ensure `pnpm changeset publish` reliably rewrites `workspace:` in all auto-bumped packages, or add an explicit rewrite step (e.g., `prepublishOnly` script or `pnpm -r publish` after version step) | P1 | Pipeline fix |
| FR-005 | Bring `cluster-relay`, `control-plane`, `credhelper`, and `generacy-plugin-claude-code` into the Changesets stable versioning loop (or mark them as `private: true` if they shouldn't be published to npm) | P1 | Compounding fix |
| FR-006 | Evaluate removing `@generacy-ai/orchestrator` from `@generacy-ai/generacy` runtime dependencies (separate follow-up issue) | P2 | Architectural |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Zero `workspace:` literals in any published tarball | 0 occurrences | `npm pack` + `jq .dependencies` on every `@generacy-ai/*` package after publish |
| SC-002 | `npx -y @generacy-ai/generacy@stable launch` succeeds on clean npm-only machine | Install exits 0 | Test on fresh Node 22 environment with no pnpm |
| SC-003 | All `@generacy-ai/*` packages referenced by orchestrator have a `stable` or `latest` dist-tag on npm | 100% coverage | `npm view <pkg> dist-tags` for each |
| SC-004 | CI release workflow includes workspace protocol validation gate | Gate present and active | Workflow YAML inspection |

## Assumptions

- The `changesets/action@v1` GitHub Action delegates to pnpm for the actual publish step (needs verification)
- All workspace packages listed in orchestrator's dependencies are intended to be published publicly (not private/internal-only)
- The current `@stable` dist-tag on `@generacy-ai/generacy` is non-functional and needs replacement
- Users install via `npx` with npm (not pnpm), so `workspace:` protocol is always fatal

## Out of Scope

- Removing `@generacy-ai/orchestrator` from CLI runtime deps (separate issue per issue #669 suggestion)
- Migrating away from Changesets to a different versioning tool
- Changes to the preview/snapshot publishing pipeline (only stable is affected)
- Cloud-side changes (generacy-cloud repo)

## Related Issues

- [#656](https://github.com/generacy-ai/generacy/issues/656) — wired up `@stable` dist-tag publishing (exposed this latent bug)
- generacy-cloud#518 — original v1.5 onboarding flow

---

*Generated by speckit*
