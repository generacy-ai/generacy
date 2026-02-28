# Feature Specification: 5.3 — Generacy VS Code Extension — generacy.env Configuration Helper

**Branch**: `251-5-3-generacy-vs` | **Date**: 2026-02-28 | **Status**: Draft

## Summary

Add a "Generacy: Configure Environment" command to the Generacy VS Code extension that guides users through setting up their `.generacy/generacy.env` file. The command detects whether the env file exists, copies from the template if missing, prompts for required values (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`), offers optional configuration (`GENERACY_API_KEY`), and validates all entries. This ensures Docker Compose can start with a fully configured environment without users manually editing env files.

### Dependencies

- **5.2** — Generacy VS Code extension MVP (`generacy-ai/generacy#250`)

### Plan Reference

[onboarding-buildout-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/onboarding-buildout-plan.md) — Issue 5.3

---
### Execution
**Phase:** 5
**Blocked by:**
- [ ] generacy-ai/generacy#250 — Generacy VS Code extension MVP

## User Stories

### US1: First-Time Environment Setup

**As a** developer onboarding to a Generacy project,
**I want** the extension to guide me through configuring my environment file,
**So that** I can start the Docker Compose stack without manually editing env files or hunting for template variables.

**Acceptance Criteria**:
- [ ] Running "Generacy: Configure Environment" from the command palette creates `.generacy/generacy.env` from `generacy.env.template` when the file does not exist
- [ ] The command prompts for `GITHUB_TOKEN` with an option to use `gh auth login` instead
- [ ] The command prompts for `ANTHROPIC_API_KEY` with format validation
- [ ] The command offers optional `GENERACY_API_KEY` configuration
- [ ] After completion, `docker compose up` succeeds with the configured env file

### US2: Existing Environment Update

**As a** developer whose API keys have rotated or expired,
**I want** to re-run the environment configuration to update specific values,
**So that** I can fix broken credentials without recreating the entire file.

**Acceptance Criteria**:
- [ ] Running the command when `.generacy/generacy.env` already exists shows current values (masked) and allows selective updates
- [ ] Unchanged values are preserved exactly as-is (including comments and ordering)
- [ ] Updated values are validated before being written

### US3: Environment Validation

**As a** developer debugging a failing Docker Compose stack,
**I want** the extension to validate my environment configuration,
**So that** I can identify misconfigured or missing values before investigating deeper issues.

**Acceptance Criteria**:
- [ ] The command validates `GITHUB_TOKEN` format, API connectivity, and required scopes (`repo`, `workflow`)
- [ ] The command validates `ANTHROPIC_API_KEY` format and API connectivity
- [ ] Validation failures show actionable error messages with fix suggestions
- [ ] Fine-grained GitHub tokens are handled correctly (scope detection via `x-oauth-scopes` header)

### US4: GitHub Token via CLI Auth

**As a** developer who prefers using `gh auth login`,
**I want** the extension to guide me through the GitHub CLI auth flow as an alternative to pasting a token,
**So that** I can use my existing GitHub CLI session without generating a separate PAT.

**Acceptance Criteria**:
- [ ] When prompted for `GITHUB_TOKEN`, the user can choose "Use gh CLI" instead of pasting a token
- [ ] The extension runs `gh auth token` to retrieve the token from the CLI session
- [ ] If `gh` is not installed or not authenticated, the extension provides guidance to install/authenticate first
- [ ] The retrieved token is validated for required scopes before being written

---

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Register `generacy.configureEnvironment` command in the extension's `package.json` contributes section | P1 | Display name: "Generacy: Configure Environment" |
| FR-002 | Check for `.generacy/generacy.env` existence relative to the workspace root | P1 | Use `vscode.workspace.workspaceFolders` for root detection |
| FR-003 | Copy `generacy.env.template` to `.generacy/generacy.env` when the env file does not exist | P1 | Template source: embedded in extension or read from `generacy.env.template` in workspace |
| FR-004 | Parse existing `.generacy/generacy.env` to detect current values and preserve structure | P1 | Handle comments, blank lines, and ordering |
| FR-005 | Prompt for `GITHUB_TOKEN` via VS Code input box with "Use gh CLI" quick-pick alternative | P1 | Show masked current value if updating |
| FR-006 | Prompt for `ANTHROPIC_API_KEY` via VS Code input box | P1 | Validate `sk-ant-` prefix format |
| FR-007 | Prompt for `GENERACY_API_KEY` via VS Code input box (optional, skippable) | P2 | Label as "for cloud features" |
| FR-008 | Validate `GITHUB_TOKEN` — format check, API call to `https://api.github.com/user`, scope verification (`repo`, `workflow`) | P1 | Reuse validation logic from CLI doctor checks (`packages/generacy/src/cli/commands/doctor/checks/github-token.ts`) |
| FR-009 | Validate `ANTHROPIC_API_KEY` — format check, API call to `https://api.anthropic.com/v1/models` | P1 | Reuse validation logic from CLI doctor checks (`packages/generacy/src/cli/commands/doctor/checks/anthropic-key.ts`) |
| FR-010 | Run `gh auth token` to retrieve GitHub token when user selects the CLI option | P1 | Use `child_process.execSync` or VS Code terminal API |
| FR-011 | Write validated values back to `.generacy/generacy.env`, preserving non-modified lines | P1 | Atomic write (write to temp, then rename) |
| FR-012 | Show progress notification during API validation calls | P2 | Use `vscode.window.withProgress` |
| FR-013 | Show summary notification on successful configuration with count of configured values | P2 | Include "Ready to start Docker Compose" message |
| FR-014 | Implement as a service following `ProjectConfigService` singleton pattern | P2 | `EnvConfigService` — Disposable, event emitter for `onDidChange` |
| FR-015 | Add `FileSystemWatcher` on `.generacy/generacy.env` to detect external changes | P3 | Emit events so other extension components can react |
| FR-016 | Show status bar indicator when `.generacy/generacy.env` is missing or has validation errors | P3 | Click opens the configure command |

---

## Technical Design

### Service: `EnvConfigService`

Follow the established `ProjectConfigService` pattern (`packages/generacy-extension/src/services/project-config-service.ts`):

- **Singleton** with static `getInstance()` method
- **Implements** `vscode.Disposable`
- **FileSystemWatcher** on `.generacy/generacy.env`
- **Event emitter** `onDidChange` for env file modifications
- **Methods**: `exists()`, `read()`, `validate()`, `write()`, `configureInteractive()`

### Validation Reuse

The CLI doctor checks provide proven validation logic:
- `packages/generacy/src/cli/commands/doctor/checks/env-file.ts` — file existence, required keys
- `packages/generacy/src/cli/commands/doctor/checks/github-token.ts` — token format, API call, scope check
- `packages/generacy/src/cli/commands/doctor/checks/anthropic-key.ts` — key format, API call

Extract shared validation functions into a common package or duplicate with attribution for the extension context (since the extension bundles separately from the CLI).

### Template Source

The env template lives at `packages/templates/src/shared/generacy.env.template.hbs`. Since this is a Handlebars template with variable interpolation, the extension should either:
- Embed a pre-rendered version of the template (preferred for simplicity)
- Import the templates package and render with default context

### Command Flow

```
User runs "Generacy: Configure Environment"
  │
  ├─ Check workspace root for .generacy/ directory
  │   └─ If no .generacy/ → show error: "No Generacy project detected. Run generacy init first."
  │
  ├─ Check .generacy/generacy.env exists
  │   ├─ No  → Copy from template, inform user
  │   └─ Yes → Parse existing values
  │
  ├─ Quick-pick: Configure GITHUB_TOKEN
  │   ├─ "Enter token manually" → input box with validation
  │   ├─ "Use gh CLI (gh auth token)" → exec gh, validate result
  │   └─ "Skip (keep current)" → preserve existing value (only if file existed)
  │
  ├─ Input box: ANTHROPIC_API_KEY
  │   └─ Validate format + API connectivity
  │
  ├─ Input box: GENERACY_API_KEY (optional)
  │   └─ "Skip" or enter value
  │
  ├─ Validate all values with progress indicator
  │   └─ On failure → show error, offer to retry or skip validation
  │
  └─ Write .generacy/generacy.env
      └─ Show success notification
```

---

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Command completes full setup flow | 100% of required fields configured | Manual QA: run command in fresh workspace, verify env file has GITHUB_TOKEN and ANTHROPIC_API_KEY |
| SC-002 | Docker Compose starts with configured env | `docker compose up` succeeds | Run `docker compose config` after configuration to verify env file is resolved |
| SC-003 | Token validation catches invalid credentials | Rejects expired/malformed tokens | Test with invalid token, verify error message shown |
| SC-004 | Scope validation catches insufficient permissions | Rejects tokens missing `repo` or `workflow` scopes | Test with read-only token, verify scope error |
| SC-005 | Existing env file values are preserved on re-run | Non-modified values unchanged | Configure, modify one value, diff env file |
| SC-006 | `gh auth token` integration works | Token retrieved and validated | Test with authenticated `gh` CLI session |

---

## Assumptions

- The workspace has been initialized with `generacy init` (`.generacy/` directory exists with `config.yaml`)
- The `generacy.env.template` structure is stable and follows the current format in `packages/templates/src/shared/generacy.env.template.hbs`
- GitHub API rate limits will not interfere with token validation during normal usage
- The Anthropic API `/v1/models` endpoint remains available for key validation
- Users have network access to validate tokens (no air-gapped environments)
- The extension is activated (workspace contains `.generacy/**/*.yaml` files)
- The 5.2 MVP extension (`generacy-ai/generacy#250`) provides the base extension infrastructure (activation, command registration patterns, service architecture)

## Out of Scope

- Automatic token rotation or refresh
- Storing secrets in VS Code's `SecretStorage` API (values live in the env file on disk, as Docker Compose reads from there)
- GitHub OAuth flow within the extension (that is part of the 5.2 MVP's cloud auth, not local env setup)
- Configuring non-secret env values (`REDIS_URL`, `LOG_LEVEL`, `POLL_INTERVAL_MS`, etc.) — these have sensible defaults
- Multi-workspace/multi-root workspace support (single workspace root assumed)
- Syncing env values across team members
- Integration with `.env` files outside the `.generacy/` directory
- GitHub Enterprise Server URL configuration (covered by `GITHUB_API_URL` in the template but not prompted during setup)
- Automatic `gh` CLI installation

---

*Generated by speckit*
