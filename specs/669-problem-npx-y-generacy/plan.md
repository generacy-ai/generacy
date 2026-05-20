# Implementation Plan: Fix `workspace:^` leak in published orchestrator package

**Feature**: Fix `workspace:^` dependency leak in `@generacy-ai/orchestrator` and prevent future occurrences
**Branch**: `669-problem-npx-y-generacy`
**Status**: Complete

## Summary

`npx -y @generacy-ai/generacy@stable launch --claim=...` fails because `@generacy-ai/orchestrator@0.1.1` was published with literal `workspace:^` dependency specifiers. The fix is threefold: (1) investigate and fix the Changesets pipeline root cause, (2) add `prepublishOnly` guardrails to all publishable packages, and (3) republish corrected packages through the fixed pipeline.

## Technical Context

- **Language**: TypeScript / Node.js >=22
- **Package manager**: pnpm 9.x with `workspace:^` / `workspace:*` protocol
- **Release tooling**: `@changesets/cli` with `changesets/action@v1` GitHub Action
- **Publish command**: `pnpm changeset publish --tag stable --provenance`
- **Monorepo**: 18 packages under `packages/`, root `package.json` is `private: true`
- **CI**: GitHub Actions (`.github/workflows/release.yml`)

## Root Cause Analysis

The `@changesets/cli` `version` command bumps version fields for transitively affected packages (via `updateInternalDependencies: "patch"`). However, `pnpm changeset publish` delegates to `pnpm publish` for each package. The `workspace:^` → semver rewrite is a **pnpm** feature, not a Changesets feature. This rewrite happens correctly when `pnpm publish` runs from the workspace root.

The most likely failure mode: the `version` command updated orchestrator's `version` field but the subsequent `publish` step either:
- Published from a non-workspace context (e.g., `changesets/action` runs in a way that bypasses pnpm's workspace-aware publish), or
- A race condition or ordering issue caused orchestrator to be published before its workspace deps were resolved.

Since all 12 other packages published correctly, the issue is likely an edge case in how Changesets interacts with pnpm's workspace protocol rewrite for packages that were auto-bumped (no direct changeset) but have many workspace deps.

## Project Structure

```
.changeset/
  config.json                    # Changesets config (modify)
.github/
  workflows/
    release.yml                  # Release workflow (modify)
packages/
  orchestrator/
    package.json                 # Add prepublishOnly script
  generacy/
    package.json                 # Add prepublishOnly script
  activation-client/
    package.json                 # Add prepublishOnly script
  cluster-relay/
    package.json                 # Add prepublishOnly script
  config/
    package.json                 # Add prepublishOnly script
  control-plane/
    package.json                 # Add prepublishOnly script
  credhelper/
    package.json                 # Add prepublishOnly script
  credhelper-daemon/
    package.json                 # Add prepublishOnly script
  workflow-engine/
    package.json                 # Add prepublishOnly script
  generacy-plugin-claude-code/
    package.json                 # Add prepublishOnly script
  generacy-plugin-cloud-build/
    package.json                 # Add prepublishOnly script
  generacy-plugin-copilot/
    package.json                 # Add prepublishOnly script
  github-issues/
    package.json                 # Add prepublishOnly script
  github-actions/
    package.json                 # Add prepublishOnly script
  jira/
    package.json                 # Add prepublishOnly script
  knowledge-store/
    package.json                 # Add prepublishOnly script
  devcontainer-feature/
    package.json                 # Add prepublishOnly script (if publishable)
scripts/
  check-workspace-deps.js        # New: shared validation script
```

## Implementation Phases

### Phase 1: Root Cause Investigation & Pipeline Fix (FR-003)

**Goal**: Understand exactly why orchestrator's deps weren't rewritten and fix the pipeline.

#### Task 1.1: Verify current pipeline behavior
- Run `pnpm changeset publish --dry-run` (if supported) or inspect Changesets source to understand the publish flow
- Check if `changesets/action@v1` does anything that could bypass pnpm's workspace protocol rewrite
- Verify that `pnpm publish` from workspace root correctly rewrites `workspace:^` → semver

#### Task 1.2: Fix release workflow if needed
- If the issue is in how `changesets/action` invokes publish, add an explicit pre-publish validation step
- Ensure `pnpm changeset publish` runs from the workspace root with full workspace context

### Phase 2: Add `prepublishOnly` Guardrail (FR-004)

**Goal**: Prevent any future publish with unresolved `workspace:` literals.

#### Task 2.1: Create shared validation script
- Create `scripts/check-workspace-deps.js` — a Node.js script that:
  - Reads `./package.json` (cwd-relative, which is the package dir at publish time)
  - Checks `dependencies`, `peerDependencies`, `optionalDependencies` for any value starting with `workspace:`
  - Exits non-zero with clear error message if any are found
  - Exits 0 if clean

#### Task 2.2: Add `prepublishOnly` to all publishable packages
- Add `"prepublishOnly": "node ../../scripts/check-workspace-deps.js"` to every non-private package's `scripts`
- Skip packages with `"private": true` (e.g., `generacy-extension`)
- The relative path `../../scripts/` works because packages are at `packages/<name>/`

### Phase 3: Create Changeset & Republish (FR-001, FR-002)

**Goal**: Publish corrected packages through the fixed pipeline.

#### Task 3.1: Create a changeset for orchestrator
- Create a changeset file that bumps `@generacy-ai/orchestrator` (patch)
- This will trigger Changesets to also bump `@generacy-ai/generacy` (which depends on it) via `updateInternalDependencies: "patch"`

#### Task 3.2: Merge to main and publish
- The release workflow on `main` will:
  1. Run `pnpm changeset version` (bumps orchestrator → 0.1.2, generacy → 0.1.2+)
  2. Run `pnpm changeset publish --tag stable --provenance`
  3. The `prepublishOnly` script runs for each package, catching any `workspace:` leak before it hits npm

### Phase 4: Verification (SC-001, SC-002)

#### Task 4.1: Post-publish verification
- `npm pack @generacy-ai/orchestrator@<new-version>` and verify no `workspace:` literals
- `npx -y @generacy-ai/generacy@stable launch --claim=<test-code>` on a clean machine
- Verify all `@generacy-ai/*@stable` packages have correct deps

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Fix approach | Pipeline first, then publish (Q1-A) | Only one user blocked; avoids version-coordination risk of manual publish |
| Guardrail location | `prepublishOnly` script (Q4-C) | Catches at the actual moment of publish; works locally and in CI |
| Script location | Shared `scripts/check-workspace-deps.js` | Single source of truth; all packages reference same script |
| Script language | Plain Node.js (no deps) | Runs in any Node.js env; no build step needed |

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| `prepublishOnly` breaks CI publish | High — blocks all releases | Test locally with `pnpm publish --dry-run` first |
| Changesets version drift from manual edits | Medium | Only use Changesets to bump versions; no manual `package.json` edits |
| Relative path `../../scripts/` breaks for nested packages | Low | All publishable packages are at `packages/<name>/`; verified by structure |
| Other packages have latent `workspace:` issues | Low | `prepublishOnly` will catch on next publish; triage confirmed only orchestrator affected |

## Constitution Check

No `.specify/memory/constitution.md` found. No governance constraints to check.

## Dependencies

- No new runtime dependencies
- No new dev dependencies
- Uses only Node.js built-in `fs` and `path` modules in the validation script
