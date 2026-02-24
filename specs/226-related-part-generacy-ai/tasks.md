# Tasks: Dev Container Feature for Generacy

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required), clarifications.md (resolved), research.md (completed)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story / acceptance criterion this task serves

---

## Phase 1: Feature Metadata

### T001 Create `devcontainer-feature.json`
**File**: `packages/devcontainer-feature/src/generacy/devcontainer-feature.json`
- Create directory structure `packages/devcontainer-feature/src/generacy/`
- Define feature metadata: `id`, `version` (0.1.0), `name`, `description`, `documentationURL`
- Define all options with types, defaults, and descriptions:
  - `version` (string, default `"latest"`) — `@generacy-ai/generacy` version
  - `agencyVersion` (string, default `"latest"`) — `@generacy-ai/agency` version (per Q1: independent release cycles)
  - `installAgency` (boolean, default `true`) — toggle Agency install
  - `installClaudeCode` (boolean, default `true`) — toggle Claude Code install
  - `nodeVersion` (string, default `"22"`) — Node.js major version
- Set `installsAfter`: `["ghcr.io/devcontainers/features/common-utils", "ghcr.io/devcontainers/features/node"]`

---

## Phase 2: Install Script

### T002 Write install script — non-root user resolution
**File**: `packages/devcontainer-feature/src/generacy/install.sh`
- Add shebang `#!/bin/sh` and `set -e`
- Implement non-root user detection:
  - Primary: `$_REMOTE_USER` (set by devcontainer spec)
  - Fallback: first user with UID >= 1000 and < 65534 in `/etc/passwd`
  - Last resort: `root`

### T003 Write install script — Node.js conditional install
**File**: `packages/devcontainer-feature/src/generacy/install.sh`
- Check `command -v node` — skip if present (any version, per Q3)
- If not found, install via NodeSource: `curl -fsSL "https://deb.nodesource.com/setup_${NODEVERSION}.x" | bash -` then `apt-get install -y nodejs`

### T004 Write install script — GitHub CLI conditional install
**File**: `packages/devcontainer-feature/src/generacy/install.sh`
- Check `command -v gh` — skip if present (any version, per Q4)
- If not found, install from GitHub's apt repository:
  - Download and install keyring
  - Add apt source for GitHub CLI
  - `apt-get update && apt-get install -y gh`

### T005 Write install script — Claude Code conditional install
**File**: `packages/devcontainer-feature/src/generacy/install.sh`
- Guard with `if [ "$INSTALLCLAUDECODE" = "true" ]`
- Install via `npm install -g @anthropic-ai/claude-code` (per Q2: npm, not curl script)

### T006 Write install script — Generacy + Agency npm installs
**File**: `packages/devcontainer-feature/src/generacy/install.sh`
- Always install: `npm install -g "@generacy-ai/generacy@${VERSION}"`
- Conditionally install Agency: `npm install -g "@generacy-ai/agency@${AGENCYVERSION}"` (guarded by `$INSTALLAGENCY`)

### T007 Write install script — verification step
**File**: `packages/devcontainer-feature/src/generacy/install.sh`
- Verify all expected binaries with `--version` checks
- Conditional checks for Claude Code (if `$INSTALLCLAUDECODE` true) and Agency (if `$INSTALLAGENCY` true)
- Print success message
- Ensure script is executable (`chmod +x`)

**Note**: T002–T007 are sequential within a single file — they must be written in order as sections of `install.sh`. However, T001 and T002–T007 can proceed in parallel since they are different files.

---

## Phase 3: Test Suite

### T008 [P] Write default test script
**File**: `packages/devcontainer-feature/test/generacy/test.sh`
- Create directory structure `packages/devcontainer-feature/test/generacy/`
- Add shebang `#!/bin/sh` and `set -e`
- Verify all tools with `--version`: `node`, `gh`, `claude`, `generacy`, `agency`
- Print success message
- Ensure script is executable

### T009 [P] Write test scenarios configuration
**File**: `packages/devcontainer-feature/test/generacy/scenarios.json`
- Define 6 scenarios per Q11 resolution:
  1. `defaults_python` — Python 3.12 base, all defaults
  2. `defaults_ubuntu` — Ubuntu base, all defaults
  3. `all_disabled` — `installAgency: false`, `installClaudeCode: false`
  4. `no_claude_code` — `installClaudeCode: false`
  5. `no_agency` — `installAgency: false`
  6. `node_20` — `nodeVersion: "20"`
- Create per-scenario test scripts in `test/generacy/` for scenarios that need custom assertions:
  - `all_disabled.sh` — verify `generacy` and `gh` present, `claude` and `agency` absent
  - `no_claude_code.sh` — verify `claude` absent
  - `no_agency.sh` — verify `agency` absent
  - `node_20.sh` — verify Node.js present (check major version = 20)

**Note**: T008 and T009 can run in parallel with each other and with T010.

---

## Phase 4: GitHub Actions Workflow

### T010 [P] Create publish workflow
**File**: `.github/workflows/publish-devcontainer-feature.yml`
- Create `.github/workflows/` directory
- Trigger on `push.tags: ['feature/v*']`
- Single job `publish` on `ubuntu-latest`
- Permissions: `contents: read`, `packages: write`
- Steps: checkout + `devcontainers/action@v1` with `publish-features: true` and `base-path-to-features: packages/devcontainer-feature/src`
- Pass `GITHUB_TOKEN` as env var

**Note**: T010 can run in parallel with T008 and T009.

---

## Phase 5: Documentation

### T011 Write README
**File**: `packages/devcontainer-feature/README.md`
- Quick Start section with minimal `devcontainer.json` example
- Options table (all 5 options with types, defaults, descriptions)
- What Gets Installed section (tools list with conditions)
- Examples section:
  - Minimal (all defaults)
  - Custom versions
  - Disabled components (no Claude Code, no Agency)
- Interaction with Other Features (note about `installsAfter` and official Node feature, per Q12)
- Publishing section (tag format `feature/v*`, one-time GHCR public visibility step, per Q6)
- Testing section (how to run `devcontainer features test` locally)
- Document Debian/Ubuntu-only limitation

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (T001) and Phase 2 (T002–T007) can proceed in parallel (different files)
- Phase 3 (T008–T009) depends on Phase 2 being complete (need to understand install.sh behavior for test assertions)
- Phase 4 (T010) has no dependencies — can proceed in parallel with any phase
- Phase 5 (T011) depends on Phases 1–4 (needs final option list, install behavior, workflow details, and test scenarios for documentation)

**Parallel opportunities within phases**:
- T001 can run in parallel with T002–T007
- T008, T009, and T010 can all run in parallel
- T011 runs last (references all other outputs)

**Critical path**:
```
T001 ──────────────────────────────────────┐
T002 → T003 → T004 → T005 → T006 → T007 ─┤
T010 ──────────────────────────────────────┤
                                           ├→ T008 ─┐
                                           ├→ T009 ─┤
                                           │        └→ T011
                                           └─────────→ T011
```

**Shortest critical path**: T002–T007 → T008/T009 → T011

---

## Files Summary

| Task | File(s) | Action |
|------|---------|--------|
| T001 | `packages/devcontainer-feature/src/generacy/devcontainer-feature.json` | Create |
| T002–T007 | `packages/devcontainer-feature/src/generacy/install.sh` | Create |
| T008 | `packages/devcontainer-feature/test/generacy/test.sh` | Create |
| T009 | `packages/devcontainer-feature/test/generacy/scenarios.json` + scenario test scripts | Create |
| T010 | `.github/workflows/publish-devcontainer-feature.yml` | Create |
| T011 | `packages/devcontainer-feature/README.md` | Create |

No existing files are modified.
