# Implementation Plan: 5.4 — Publish Dev Container Feature to GHCR

**Branch**: `252-5-4-publish-dev`
**Date**: 2026-02-27
**Status**: Ready for Review

---

## Summary

The dev container feature infrastructure (`install.sh`, `devcontainer-feature.json`, test scenarios, and publish workflows) already exists and is well-structured. This PR focuses on **validation, refinement, and testing** of that infrastructure to achieve the acceptance criteria: `ghcr.io/generacy-ai/generacy/generacy:1` is publicly pullable and installs correctly.

The work breaks down into four phases:
1. Add the missing TypeScript-Node test scenario and preview default-baking logic
2. Fix the multi-repo template GHCR path (and its tests/snapshots)
3. Validate the publish workflows end-to-end
4. Manual post-publish verification and GHCR visibility configuration

---

## Technical Context

| Aspect | Detail |
|--------|--------|
| **Language** | Shell (install.sh), YAML (GitHub Actions), JSON (feature metadata, test scenarios), TypeScript (template tests) |
| **OCI Registry** | GitHub Container Registry (GHCR) — `ghcr.io/generacy-ai/generacy/generacy` |
| **Publish Tools** | `devcontainers/action@v1` (stable), `oras` CLI 1.2.0 (preview) |
| **Testing** | `devcontainer features test` CLI (local), GitHub Actions CI (remote) |
| **Package Manager** | pnpm 9.15.9, changesets for versioning |
| **Feature Version** | `0.1.0` (stays at 0.1.0 per Q5 clarification; bump to 1.0.0 in follow-up) |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    GitHub Actions                        │
│                                                         │
│  push to develop ──► publish-preview.yml                │
│                       ├─ snapshot version npm packages   │
│                       ├─ publish npm --tag preview       │
│                       └─ publish-devcontainer-feature    │
│                          (mode: preview)                 │
│                          ├─ modify defaults → "preview"  │  ◄── NEW
│                          ├─ tar + oras push              │
│                          └─ :preview tag                 │
│                                                         │
│  push to main ────► release.yml                         │
│                       ├─ changesets/action (version/PR)  │
│                       ├─ publish npm (stable)            │
│                       └─ publish-devcontainer-feature    │
│                          (mode: stable)                  │
│                          ├─ devcontainers/action@v1      │
│                          └─ :0, :0.1, :0.1.0 tags       │
│                                                         │
│  tag feature/v* ──► publish-devcontainer-feature        │
│                       (mode: stable, direct trigger)     │
└─────────────────────────────────────────────────────────┘

OCI Artifact Structure (ghcr.io/generacy-ai/generacy/generacy):
  :preview  ← develop branch, defaults baked to "preview"
  :0        ← stable, from devcontainer-feature.json version
  :0.1      ← stable, minor
  :0.1.0    ← stable, patch
  :1        ← (after version bump to 1.0.0 in follow-up PR)
```

---

## Implementation Phases

### Phase 1: Test Scenario Addition & Preview Default Baking
**Files changed**: 4 new, 2 modified

#### 1.1 Add TypeScript-Node test scenario (Q3)

Add `defaults_typescript_node` scenario to validate the "Node.js already installed" skip path.

**File: `packages/devcontainer-feature/test/generacy/scenarios.json`**

Add entry:
```json
"defaults_typescript_node": {
  "image": "mcr.microsoft.com/devcontainers/typescript-node:22",
  "features": {
    "generacy": {}
  }
}
```

**File (new): `packages/devcontainer-feature/test/generacy/defaults_typescript_node.sh`**

```sh
#!/bin/sh
set -e

# Test: defaults on TypeScript-Node base image.
# Node.js is already present in this image — install.sh should skip Node install.

node --version
gh --version
claude --version
generacy --version
agency --version

echo "defaults_typescript_node test passed."
```

This is important because the TypeScript-Node image ships with Node.js pre-installed, so it exercises the `if ! command -v node` skip branch in `install.sh` — a path that the Python and Ubuntu images do not cover.

#### 1.2 Bake preview npm tags into the OCI artifact (Q2)

Modify the preview publish step to rewrite `devcontainer-feature.json` defaults before packaging.

**File: `.github/workflows/publish-devcontainer-feature.yml`**

Add a step before the "Publish Feature (preview)" step:

```yaml
- name: Set preview defaults
  if: inputs.mode == 'preview'
  run: |
    cd packages/devcontainer-feature/src/generacy
    # Rewrite option defaults from "latest" to "preview" for preview artifacts
    jq '.options.version.default = "preview" | .options.agencyVersion.default = "preview"' \
      devcontainer-feature.json > tmp.json && mv tmp.json devcontainer-feature.json
```

This ensures consumers of `:preview` get preview-tagged npm packages automatically without manual option configuration. The `jq` tool is available on `ubuntu-latest` runners.

### Phase 2: Multi-Repo Template GHCR Path Fix (Q10)
**Files changed**: 1 modified, 3 updated (tests/snapshots)

#### 2.1 Fix the template path

**File: `packages/templates/src/multi-repo/devcontainer.json.hbs`** (line 25)

Change:
```
"ghcr.io/generacy-ai/features/generacy{{devcontainer.featureTag}}": {}
```
To:
```
"ghcr.io/generacy-ai/generacy/generacy{{devcontainer.featureTag}}": {}
```

#### 2.2 Update test assertions

**File: `packages/templates/tests/integration/render-project.test.ts`** (line 254)

Change:
```typescript
expect(devcontainer.features['ghcr.io/generacy-ai/features/generacy:1']).toBeDefined();
```
To:
```typescript
expect(devcontainer.features['ghcr.io/generacy-ai/generacy/generacy:1']).toBeDefined();
```

**File: `packages/templates/tests/unit/validators.test.ts`**

Replace all occurrences of `ghcr.io/generacy-ai/features/generacy` with `ghcr.io/generacy-ai/generacy/generacy` (13 occurrences). Note: the validator regex `/generacy-ai\/.*\/generacy/` already matches both patterns, so the validator source code needs no change — only the test fixtures that use the wrong path.

#### 2.3 Regenerate snapshots

**File: `packages/templates/tests/integration/__snapshots__/snapshots.test.ts.snap`**

Run the snapshot tests to regenerate (3 occurrences will update automatically):
```bash
pnpm -r --filter @generacy-ai/templates test -- --update
```

### Phase 3: Workflow Validation & Documentation
**Files changed**: 1 modified (README update for test table)

#### 3.1 Validate stable publish workflow locally

Verify the `devcontainers/action@v1` step configuration is correct:
- `publish-features: true`
- `base-path-to-features: packages/devcontainer-feature/src`
- This reads `src/generacy/devcontainer-feature.json` to derive the feature ID and version

The `devcontainers/action@v1` automatically:
1. Finds feature directories under `base-path-to-features`
2. Reads `devcontainer-feature.json` for id and version
3. Creates a tgz archive
4. Pushes to `ghcr.io/{owner}/{repo}/{feature-id}:{major}`, `:{major}.{minor}`, `:{major}.{minor}.{patch}`

With version `0.1.0`, this produces tags: `:0`, `:0.1`, `:0.1.0`.

#### 3.2 Validate preview publish workflow

Verify the oras-based preview flow:
1. `oras login` authenticates to GHCR using `GITHUB_TOKEN`
2. Feature directory is archived into a tgz
3. Pushed with OCI media types matching the dev container spec:
   - Config: `application/vnd.devcontainers`
   - Layer: `application/vnd.devcontainers.layer.v1+tar`
4. Tagged as `:preview`

#### 3.3 Update README test scenario table

**File: `packages/devcontainer-feature/README.md`**

Add the new TypeScript-Node scenario to the test table:

```markdown
| `defaults_typescript_node` | TypeScript-Node 22 | All defaults | All tools installed, Node skip path |
```

### Phase 4: Post-Merge Manual Steps
**No code changes — operational checklist**

#### 4.1 First preview publish (after merge to develop)

1. Verify the `publish-preview.yml` workflow runs
2. Check GitHub Actions logs for successful oras push
3. Validate the preview artifact:
   ```bash
   oras manifest fetch ghcr.io/generacy-ai/generacy/generacy:preview
   ```

#### 4.2 Set GHCR package visibility to public (one-time, Q6)

1. Navigate to: `https://github.com/orgs/generacy-ai/packages/container/generacy%2Fgeneracy/settings`
2. Under "Danger Zone", change visibility from "Private" to "Public"
3. Confirm the change

This is a manual step because automating it requires `packages: admin` permissions (Q6 answer).

#### 4.3 Verify public pull

```bash
docker pull ghcr.io/generacy-ai/generacy/generacy:preview
```

Or test in a devcontainer.json:
```json
{
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/generacy-ai/generacy/generacy:preview": {}
  }
}
```

#### 4.4 Version bump to 1.0.0 (follow-up PR, per Q5)

After preview validation succeeds, a separate PR will:
1. Bump `devcontainer-feature.json` version from `0.1.0` to `1.0.0`
2. Merge to `main` to produce the `:1` stable tag
3. Verify `ghcr.io/generacy-ai/generacy/generacy:1` is pullable

---

## Key Technical Decisions

| # | Decision | Rationale | Reference |
|---|----------|-----------|-----------|
| 1 | Keep version at `0.1.0`, bump to `1.0.0` later | Avoid burning the `:1` tag on a potentially broken first publish | Q5 |
| 2 | Bake preview npm tags into OCI artifact | `:preview` tag should deliver a self-consistent experience | Q2 |
| 3 | Fail fast on install errors (`set -e`) | Partially-provisioned containers cause confusing runtime errors | Q4 |
| 4 | Pin oras CLI to 1.2.0 | Reproducibility in CI; small blast radius | Q7 |
| 5 | Use `@latest` for Claude Code | Explicit design choice; dev containers are ephemeral | Q9 |
| 6 | Manual GHCR visibility toggle | One-time op; automating requires escalated permissions | Q6 |
| 7 | Any changeset triggers preview publish | OCI artifact is idempotent; scoping adds complexity for no benefit | Q8 |
| 8 | Include multi-repo template fix in this PR | One-line fix directly related to this work; don't ship broken integration | Q10 |

---

## File Change Summary

| File | Action | Phase |
|------|--------|-------|
| `packages/devcontainer-feature/test/generacy/scenarios.json` | Modify (add TS-Node scenario) | 1.1 |
| `packages/devcontainer-feature/test/generacy/defaults_typescript_node.sh` | **Create** | 1.1 |
| `.github/workflows/publish-devcontainer-feature.yml` | Modify (add preview defaults step) | 1.2 |
| `packages/templates/src/multi-repo/devcontainer.json.hbs` | Modify (fix GHCR path) | 2.1 |
| `packages/templates/tests/integration/render-project.test.ts` | Modify (fix GHCR path in assertion) | 2.2 |
| `packages/templates/tests/unit/validators.test.ts` | Modify (fix GHCR path in fixtures) | 2.2 |
| `packages/templates/tests/integration/__snapshots__/snapshots.test.ts.snap` | Auto-regenerate | 2.3 |
| `packages/devcontainer-feature/README.md` | Modify (add TS-Node to test table) | 3.3 |

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| npm packages (`@generacy-ai/generacy`, `@generacy-ai/agency`) not yet published | Medium | High — install.sh fails | Feature is blocked by issues 1.1 and 1.4 (npm packages) and 243 (CI/CD). Workflows won't run successfully until those ship. |
| `jq` not available on runner for preview defaults | Low | Medium — preview artifact has wrong defaults | `jq` is pre-installed on all `ubuntu-latest` GitHub-hosted runners |
| First GHCR publish is private by default | Certain | Medium — users can't pull | Documented as manual step 4.2; PR checklist includes this |
| oras 1.2.0 download URL changes | Low | Low — preview publish fails | URL is from official GitHub releases; pin ensures reproducibility |
| Snapshot tests break during regeneration | Low | Low — CI catches | Run tests locally before pushing; CI validates on PR |
| TypeScript-Node image already has Node.js — verify `gh` CLI behavior | Low | Low | Test scenario validates all tools; `gh` install is conditional |

---

## Validation Plan

### Local validation (before PR)

```bash
# 1. Run template tests (after fixing multi-repo path)
pnpm -r --filter @generacy-ai/templates test

# 2. Verify devcontainer feature test scenarios parse
cat packages/devcontainer-feature/test/generacy/scenarios.json | jq .

# 3. Lint
pnpm lint && pnpm -r run --if-present lint

# 4. Build
pnpm build && pnpm -r run --if-present build

# 5. Full test suite
pnpm test && pnpm -r --filter '!generacy-extension' --filter '!@generacy-ai/orchestrator' --filter '!@generacy-ai/generacy' run --if-present test
```

### CI validation (after PR)

- CI workflow runs lint, build, typecheck, and tests on PR
- Template snapshot diffs are visible in PR review

### Post-merge validation

- Preview publish workflow triggers automatically on merge to `develop`
- Verify oras push succeeds in workflow logs
- Set GHCR visibility to public
- Test pulling the artifact from an external context

---

## Dependencies

| Dependency | Status | Blocks |
|------------|--------|--------|
| `@generacy-ai/generacy` published to npm (issue 1.1) | Pending | install.sh runtime |
| `@generacy-ai/agency` published to npm (issue 1.3/1.4) | Pending | install.sh runtime |
| CI/CD for generacy repo (issue 243) | Pending | Workflow execution |

The code changes in this PR can be merged independently. The workflows will execute successfully only after the dependent npm packages are published, but the pipeline infrastructure is correct and ready.

---

## Out of Scope

- Bumping `devcontainer-feature.json` to `1.0.0` (follow-up PR after preview validation)
- Feature option for specific Claude Code versions (Q9 — always `@latest`)
- Automating GHCR visibility (Q6 — one-time manual step)
- Scoped changeset detection (Q8 — any changeset triggers publish)
- Retry logic for transient npm failures (Q4 — fail fast for now)
- Alpine/RHEL base image support
