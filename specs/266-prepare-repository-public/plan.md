# Implementation Plan: Prepare Repository for Public Visibility

## Summary

This plan covers the four deliverables required before making the Generacy repository public:

1. **LICENSE** — MIT license file at repo root
2. **SECURITY.md** — Security policy with vulnerability reporting process
3. **.github/CODEOWNERS** — Code ownership mapping for all directories and packages
4. **Secrets audit** — Full git history scan using gitleaks with persisted configuration

Additionally, per clarification Q12, we audit tool-config directories (`.agency/`, `.claude/`, `.generacy/`, `.specify/`) for sensitive content and update `.gitignore` if needed.

No new APIs, data models, or runtime dependencies are introduced. All changes are static files and configuration.

## Technical Context

- **Repository**: `generacy` — TypeScript monorepo (pnpm workspaces)
- **Runtime**: Node.js >= 20.0.0, pnpm
- **Packages**: 14 packages under `packages/`
- **License**: MIT (already declared in `package.json` line 26, but no LICENSE file exists)
- **Branch**: `266-prepare-repository-public` (based off `develop`)
- **External tooling**: gitleaks (pre-built Linux binary from GitHub releases)

## Architecture Overview

No architectural changes. All deliverables are static configuration files:

```
generacy/
├── LICENSE                          # NEW — MIT license
├── SECURITY.md                      # NEW — Security policy
├── .gitleaks.toml                   # NEW — Gitleaks configuration
├── .gitleaksignore                  # NEW — False positive allowlist
├── .github/
│   ├── CODEOWNERS                   # NEW — Code ownership
│   └── workflows/
│       └── publish-devcontainer-feature.yml  # existing
└── .gitignore                       # MODIFIED — add gitleaks report to ignores
```

---

## Implementation Phases

### Phase 1: Add LICENSE File

**Files**: `LICENSE` (new)

Create the MIT license file at repository root with the exact copyright line from Q1:

```
MIT License

Copyright (c) 2026 The Generacy AI Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
...
```

Key decisions (from clarifications):
- **License type**: MIT — already declared in `package.json`, consistent with README
- **Copyright year**: 2026 only (year of public release, no ranges)
- **Copyright holder**: "The Generacy AI Authors" (future-proof, covers all contributors)

### Phase 2: Add SECURITY.md

**Files**: `SECURITY.md` (new)

Create a security policy document with these sections:

1. **Reporting a Vulnerability** — Prefer GitHub Security Advisories; fallback to `security@generacy.ai` (Q5)
2. **Scope** — What constitutes a security issue vs. a bug
3. **Supported Versions** — Deferred table per Q6: "This project is in early development. All security reports will be evaluated against the latest code on the default branch."
4. **Response Timeline** — Acknowledgment within 48 hours, target fix within 90 days
5. **Disclosure Policy** — Coordinated disclosure after patch is available

Key decisions:
- No specific version table (pre-1.0 project, Q6 answer C)
- Dedicated email `security@generacy.ai` even if it forwards today (Q5 answer A)
- GitHub Security Advisories as preferred channel

### Phase 3: Add .github/CODEOWNERS

**Files**: `.github/CODEOWNERS` (new)

Create CODEOWNERS with comprehensive directory mapping. Per clarifications:
- Use team handles `@generacy-ai/core` and `@generacy-ai/plugins` (Q3 answer B)
- All plugins share one owner group `@generacy-ai/plugins` (Q4 answer A)
- Root files via wildcard `*` default owner (Q10 answer A)
- Map all directories including `docker/`, `scripts/`, `tests/`, `specs/` (Q11 answer A)

**CODEOWNERS structure**:

```
# Default owner for everything
* @generacy-ai/core

# Core packages
/packages/generacy/                    @generacy-ai/core
/packages/orchestrator/                @generacy-ai/core
/packages/workflow-engine/             @generacy-ai/core
/packages/knowledge-store/             @generacy-ai/core
/packages/generacy-extension/          @generacy-ai/core
/packages/devcontainer-feature/        @generacy-ai/core

# Plugin packages
/packages/generacy-plugin-claude-code/ @generacy-ai/plugins
/packages/generacy-plugin-cloud-build/ @generacy-ai/plugins
/packages/generacy-plugin-copilot/     @generacy-ai/plugins
/packages/github-actions/              @generacy-ai/plugins
/packages/github-issues/              @generacy-ai/plugins
/packages/jira/                        @generacy-ai/plugins
/packages/templates/                   @generacy-ai/plugins

# Core source and infrastructure
/src/                                  @generacy-ai/core
/docs/                                 @generacy-ai/core
/docker/                               @generacy-ai/core
/scripts/                              @generacy-ai/core
/tests/                                @generacy-ai/core
/specs/                                @generacy-ai/core
/.github/                              @generacy-ai/core
```

**Pre-requisite**: Confirm that the GitHub teams `@generacy-ai/core` and `@generacy-ai/plugins` exist in the `generacy-ai` org. If they don't exist, they must be created before merging this PR.

### Phase 4: Audit Tool-Config Directories

**Files**: `.gitignore` (modified, if needed)

Per Q12, audit `.agency/`, `.claude/`, `.generacy/`, `.specify/` for sensitive content before going public.

**Findings from exploration**:
- `.agency/agency.config.json` — Empty plugin/mode config. **SAFE**.
- `.claude/autodev.json` — State provider config. **SAFE**.
- `.generacy/speckit-feature.yaml`, `speckit-bugfix.yaml` — Workflow templates. **SAFE**.
- `.specify/templates/*.md` — Markdown templates. **SAFE**.

**Result**: No sensitive content found in any tool-config directory. No `.gitignore` changes needed for these directories.

### Phase 5: Secrets Audit with Gitleaks

**Files**: `.gitleaks.toml` (new), `.gitleaksignore` (new), `.gitignore` (modified)

#### Step 5a: Install gitleaks

Download the pre-built Linux amd64 binary from the gitleaks GitHub releases page. Install to a local path (e.g., `/tmp/gitleaks` or project-local `.bin/`).

```bash
# Download latest gitleaks release (example for v8.x)
wget -qO- https://github.com/gitleaks/gitleaks/releases/download/v8.22.1/gitleaks_8.22.1_linux_amd64.tar.gz | tar xz -C /tmp/ gitleaks
```

#### Step 5b: Create `.gitleaks.toml`

Persist gitleaks configuration in the repo root for future CI integration:

```toml
[extend]
# Use the default gitleaks rules
# https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml

title = "Generacy Gitleaks Configuration"

# Additional paths to ignore (beyond .gitleaksignore)
[allowlist]
  paths = [
    '''node_modules''',
    '''pnpm-lock\.yaml''',
    '''package-lock\.json''',
    '''\.env\.example''',
  ]
```

#### Step 5c: Run full history scan

```bash
/tmp/gitleaks detect --source /workspaces/generacy --verbose --report-format json --report-path /tmp/gitleaks-report.json
```

- Review all findings
- True positives: remediate with `git filter-repo` or BFG Repo Cleaner
- False positives: add fingerprints to `.gitleaksignore`

#### Step 5d: Create `.gitleaksignore`

After running the scan, populate with fingerprints of confirmed false positives. Expected false positives include placeholder values in `.env.example` (`your-api-key-here`, `your-github-token`).

```
# .gitleaksignore
# False positives from placeholder values in .env.example
# Format: finding fingerprint (hash from gitleaks report)
<fingerprint-hash-1>
<fingerprint-hash-2>
```

The exact fingerprints will be determined after running the scan.

#### Step 5e: Update `.gitignore`

Add gitleaks report files to `.gitignore` to prevent accidental commit of scan output:

```gitignore
# Gitleaks
gitleaks-report.json
```

#### Step 5f: Document findings

Per Q9 (answer C), add a brief summary of scan findings to the PR description. Do not commit the raw JSON report.

---

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| License type | MIT | Already declared in `package.json`; simple, permissive |
| Copyright holder | "The Generacy AI Authors" | Future-proof, covers all contributors |
| Copyright year | 2026 only | Year of public release, no maintenance burden |
| CODEOWNERS team handles | `@generacy-ai/core`, `@generacy-ai/plugins` | Scalable; team membership managed centrally |
| CODEOWNERS granularity | Single owner per group (core vs. plugins) | Team is small; avoid noise from over-specific rules |
| Security email | `security@generacy.ai` | Professional, separable from individuals |
| Supported versions policy | Deferred (early development statement) | Honest about pre-1.0 maturity |
| Secrets scanner | gitleaks binary | Simple, no dependencies, configurable |
| Scan report | PR description summary only | Avoid committing potentially sensitive path info |
| Tool-config directories | Keep tracked (all safe) | Audited; no sensitive content found |

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Secrets found in git history | High — credentials exposed on public repo | Run gitleaks scan before any visibility change; remediate with `git filter-repo` |
| GitHub teams don't exist | Medium — CODEOWNERS validation fails | Verify team existence before merging; create teams if needed |
| `security@generacy.ai` not configured | Low — dead security contact | Verify email alias exists and forwards correctly before going public |
| False positives overwhelm scan results | Low — delays audit | Pre-configure `.gitleaks.toml` allowlist paths; use `.gitleaksignore` for remaining FPs |
| `.env.example` placeholder values flagged | Low — expected false positives | Document in `.gitleaksignore` with clear comments |

## Verification Checklist

After implementation, verify:

- [ ] `LICENSE` file exists at repo root with correct MIT text, year (2026), and holder ("The Generacy AI Authors")
- [ ] `SECURITY.md` exists at repo root with GitHub Security Advisories link, `security@generacy.ai`, and early-development version policy
- [ ] `.github/CODEOWNERS` exists with mappings for all 14 packages, `src/`, `docs/`, `docker/`, `scripts/`, `tests/`, `specs/`, `.github/`, and a default owner
- [ ] `.gitleaks.toml` exists at repo root with project-specific configuration
- [ ] `.gitleaksignore` exists (populated after scan)
- [ ] `.gitignore` updated with `gitleaks-report.json`
- [ ] Gitleaks scan completed against full git history with zero unresolved true positives
- [ ] PR description includes scan results summary
- [ ] GitHub teams `@generacy-ai/core` and `@generacy-ai/plugins` exist in the org

## Estimated Scope

- **New files**: 5 (LICENSE, SECURITY.md, .github/CODEOWNERS, .gitleaks.toml, .gitleaksignore)
- **Modified files**: 1 (.gitignore)
- **No runtime code changes** — all configuration and documentation
