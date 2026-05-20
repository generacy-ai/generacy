# Clarifications for #669

## Batch 1 — 2026-05-20

### Q1: Immediate Unblock Mechanism
**Context**: FR-001/FR-002 require republishing fixed packages as P0 "immediate unblock." The approach determines whether we do a one-time manual `npm publish` of corrected tarballs, or fix the pipeline first and publish through it. Manual publish risks version conflicts with Changesets' tracked state.
**Question**: Should we fix the release pipeline (FR-003/FR-004) first and then publish through it (single coordinated release), or do a manual one-off republish of corrected packages to unblock users immediately, then fix the pipeline separately?
**Options**:
- A: Fix pipeline first, then publish through it (cleaner, but slower to unblock users)
- B: Manual one-off republish now, then fix pipeline (faster unblock, but needs careful version coordination with Changesets)

**Answer**: *Pending*

### Q2: Unpublished Stable Packages — Bring In or Mark Private
**Context**: FR-005 says to either bring `cluster-relay`, `control-plane`, `credhelper`, and `generacy-plugin-claude-code` into the stable versioning loop OR mark them `private: true`. These are currently public on npm but only have preview snapshots. Orchestrator depends on them at runtime. The choice affects whether these packages get independent semver lifecycles or are removed from npm entirely.
**Question**: Should these four packages be brought into the Changesets stable release cycle (published with semver versions alongside orchestrator), or should they be marked `private: true` in their `package.json` (meaning orchestrator would need to bundle/inline their code instead of depending on them via npm)?
**Options**:
- A: Bring all four into the stable Changesets release cycle (they get published to npm with proper versions)
- B: Mark them `private: true` and restructure orchestrator to not depend on them via npm
- C: Mixed — some should be public, some private (please specify which)

**Answer**: *Pending*

### Q3: @stable Dist-Tag Scope
**Context**: The current release workflow (lines 55-65) only adds the `@stable` dist-tag to `@generacy-ai/generacy` (the CLI). But `npx` resolution also installs transitive deps like orchestrator, which need resolvable versions. If users or scripts reference `@generacy-ai/orchestrator@stable` directly, they'll get nothing.
**Question**: Should the `@stable` dist-tag be added to ALL published `@generacy-ai/*` packages after a release, or only to the CLI entry point (`@generacy-ai/generacy`)?
**Options**:
- A: Add `@stable` to all published `@generacy-ai/*` packages
- B: Only the CLI (`@generacy-ai/generacy`) needs `@stable`; transitive deps resolve via semver ranges

**Answer**: *Pending*

### Q4: CI Validation Gate Placement
**Context**: FR-003 requires a CI validation step that scans for `workspace:` literals. This could be placed in several locations: only in the release workflow (catches at publish time), in the PR CI (catches during development), or as a `prepublishOnly` script in each package (catches locally). The placement affects how early developers are warned.
**Question**: Where should the `workspace:` protocol validation gate run?
**Options**:
- A: Only in the release workflow (`.github/workflows/release.yml`), as a step before publish
- B: In the PR CI as well (every PR validates no `workspace:` in built outputs)
- C: As a `prepublishOnly` script in each package.json (local + CI coverage)

**Answer**: *Pending*

### Q5: credhelper-daemon Package Status
**Context**: The spec mentions `credhelper` as one of orchestrator's deps needing stable publication, but the monorepo also has a separate `credhelper-daemon` package. Orchestrator's `package.json` depends on `@generacy-ai/credhelper` (the types/schemas package), not `credhelper-daemon`. However, `credhelper-daemon` is also public and unpublished to stable. It may need the same treatment.
**Question**: Does `credhelper-daemon` also need to be brought into the stable release cycle, or is it only used inside the cluster container (never installed from npm by end users) and can be marked `private: true`?
**Options**:
- A: Bring `credhelper-daemon` into stable alongside `credhelper`
- B: Mark `credhelper-daemon` as `private: true` (container-only, never installed from npm)

**Answer**: *Pending*
