# Feature Specification: Fix `workspace:^` leak in published orchestrator package

**Branch**: `669-problem-npx-y-generacy` | **Date**: 2026-05-20 | **Status**: Draft

## Summary

`npx -y @generacy-ai/generacy@stable launch --claim=...` fails because `@generacy-ai/orchestrator@0.1.1` was published with literal `workspace:^` dependency specifiers instead of rewritten semver ranges. This is an isolated defect in one package — all other 12 `@generacy-ai/*` stable packages were published correctly.

## Problem

`npx -y @generacy-ai/generacy@stable launch --claim=...` fails on a fresh user machine because npm cannot resolve the dep tree of `@generacy-ai/orchestrator@0.1.1` (a transitive dep of `@generacy-ai/generacy@0.1.3`).

The published tarball — verified by `npm pack @generacy-ai/orchestrator@0.1.1` and inspecting `package/package.json` — contains literal `workspace:^` placeholders that should have been rewritten to semver ranges at publish time:

```json
"dependencies": {
  "@fastify/cors": "^10.0.0",
  ...
  "@generacy-ai/activation-client": "workspace:^",
  "@generacy-ai/cluster-relay": "workspace:^",
  "@generacy-ai/config": "workspace:^",
  "@generacy-ai/control-plane": "workspace:^",
  "@generacy-ai/credhelper": "workspace:^",
  "@generacy-ai/generacy-plugin-claude-code": "workspace:^",
  "@generacy-ai/workflow-engine": "workspace:^",
  ...
}
```

`workspace:` is a pnpm-only protocol. `pnpm publish` and `pnpm changeset publish` are supposed to rewrite these to `^X.Y.Z` (the actual published version of the workspace package) before the tarball goes to the registry. That did not happen for orchestrator.

For comparison, the sibling published package `@generacy-ai/generacy@0.1.3` had its internal deps correctly rewritten to pinned versions (e.g. `@generacy-ai/orchestrator: 0.1.1`). Only orchestrator's deps leaked.

**Clarification (from triage)**: All other `@generacy-ai/*` packages already have correct `@stable` dist-tags with properly rewritten deps. The `workspace:^` leak is isolated to `@generacy-ai/orchestrator@0.1.1` only.

## Reproduction

```
$ npm pack @generacy-ai/orchestrator@0.1.1
$ tar -xzf generacy-ai-orchestrator-0.1.1.tgz
$ jq .dependencies package/package.json
# → shows workspace:^ literals
```

End-user-facing reproduction:

```
PS> npx -y @generacy-ai/generacy@stable launch --claim=<any-valid-claim>
npm error
npm error A complete log of this run can be found in: ...debug-0.log
```

Verbose log shows manifest fetches for `@fastify/*` deps of orchestrator, then a silent `exit 1` once npm hits the `workspace:^` entries.

## Root Cause

The release workflow at [.github/workflows/release.yml:46-47](https://github.com/generacy-ai/generacy/blob/develop/.github/workflows/release.yml#L46-L47) uses `pnpm changeset publish --tag stable --provenance`.

**Most likely cause**: Orchestrator was version-bumped from 0.1.0 → 0.1.1 via Changesets' `updateInternalDependencies: "patch"` ([.changeset/config.json:10](https://github.com/generacy-ai/generacy/blob/develop/.changeset/config.json#L10)) without a direct changeset of its own. The `version` step bumped its version field but missed rewriting its `dependencies` entries. The other 12 packages either had direct changesets or no internal workspace deps to rewrite.

## Suggested Fix Path

**Decision (Q1)**: Fix the pipeline first, then publish through it (option A). No manual one-off republish.

1. **Root cause fix**: Investigate why Changesets missed the `workspace:^` rewrite for auto-bumped orchestrator. Fix the pipeline to ensure all packages get deps rewritten.
2. **Prevention**: Add a `prepublishOnly` script (Q4, option C) to each publishable package that fails non-zero if any `dependencies`/`peerDependencies`/`optionalDependencies` value starts with `workspace:`. This catches the problem at the actual moment of publish, works locally and in CI.
3. **Republish**: Republish a corrected `@generacy-ai/orchestrator` (and bump `@generacy-ai/generacy` to depend on it) through the fixed pipeline.

## Related

- generacy-ai/generacy#656 — wired up `@stable` dist-tag publishing (landed). That exposed this latent bug.
- generacy-ai/generacy-cloud#518 — the original v1.5 onboarding copy-paste issue.
- generacy-ai/generacy#671 — `@latest` dist-tag is stale on most `@generacy-ai/*` packages (separate issue).
- generacy-ai/generacy#672 — investigate whether orchestrator should be split into server vs client packages (separate issue).

## User Stories

### US1: First-Time User Onboarding

**As a** new Generacy user,
**I want** `npx -y @generacy-ai/generacy@stable launch --claim=...` to install and run successfully,
**So that** I can onboard to Generacy without hitting npm resolution errors.

**Acceptance Criteria**:
- [ ] `npm pack @generacy-ai/orchestrator@<new-version>` contains no `workspace:` literals in dependencies
- [ ] `npx -y @generacy-ai/generacy@stable launch --claim=<code>` completes the install phase on a fresh machine
- [ ] A `prepublishOnly` script prevents future publishes with `workspace:` literals

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Republish `@generacy-ai/orchestrator` with `workspace:^` deps rewritten to semver ranges | P0 | Isolated to orchestrator only |
| FR-002 | Bump `@generacy-ai/generacy` to depend on fixed orchestrator and republish stable | P0 | |
| FR-003 | Investigate and fix the Changesets auto-bump dep rewrite failure | P1 | Root cause: auto-bumped packages may skip dep rewrite |
| FR-004 | Add `prepublishOnly` script to each publishable package that rejects `workspace:` literals | P1 | Works locally + CI |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `workspace:` literals in published tarballs | 0 | `npm pack` + grep on all `@generacy-ai/*@stable` packages |
| SC-002 | `npx -y @generacy-ai/generacy@stable launch` install success | 100% | Test on fresh machine / clean npm cache |

## Assumptions

- Only `@generacy-ai/orchestrator@0.1.1` is affected (confirmed via triage of all 13 stable packages)
- All other `@generacy-ai/*` packages already have correct `@stable` dist-tags
- `pnpm changeset publish` generally works correctly; the failure is specific to auto-bumped packages without direct changesets

## Out of Scope

- Whether orchestrator should be a runtime dep of the CLI (tracked in #672)
- `@latest` dist-tag staleness (tracked in #671)
- Making `credhelper-daemon` or other packages `private: true` (separate concern)

---

*Generated by speckit*
