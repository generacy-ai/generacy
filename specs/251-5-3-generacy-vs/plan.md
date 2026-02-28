# Implementation Plan: 5.3 — Generacy VS Code Extension — generacy.env Configuration Helper

**Branch**: `251-5-3-generacy-vs` | **Date**: 2026-02-28

## Summary

Add a `Generacy: Configure Environment` command to the VS Code extension that guides users through setting up `.generacy/generacy.env`. The command checks for an existing env file, copies from a workspace template (or embedded default) if absent, prompts for `GITHUB_TOKEN` (with `gh auth token` integration), `ANTHROPIC_API_KEY`, and optionally `GENERACY_API_KEY`, validates tokens via API calls, and writes the file. A status bar indicator shows env file status (missing/incomplete/OK) using format-only checks (no API calls) with a `FileSystemWatcher`.

## Technical Context

- **Language**: TypeScript
- **Framework**: VS Code Extension API
- **Build**: esbuild (CJS bundle, `vscode` external)
- **Test**: Vitest with `vi.mock('vscode', ...)`
- **Key patterns**: Singleton services, `withErrorHandling` wrapping, `FileSystemWatcher` for hot-reload, `EventEmitter` for reactive updates, `vscode.workspace.fs` for file I/O
- **Existing precedents**: `ProjectConfigService` (config watch + parse), `ProjectStatusBarProvider` (status bar), `EnvConfigManager` (interactive env UI), CLI doctor checks (token validation)

## Architecture Overview

```
src/
├── commands/
│   └── env.ts                          # NEW — command handler for generacy.configureEnvironment
├── services/
│   ├── env-config-service.ts           # NEW — env file watch, parse, status tracking
│   └── project-config-service.ts       # EXISTING — no changes
├── providers/
│   ├── status-bar.ts                   # MODIFY — add EnvStatusBarProvider export
│   └── index.ts                        # MODIFY — re-export new provider
├── constants.ts                        # MODIFY — add command ID, context key, env file constants
├── extension.ts                        # MODIFY — register command, initialize env service + status bar
└── __tests__/                          # Tests alongside source (existing pattern is src/**/__tests__)
```

### Component Interaction

```
extension.ts activate()
  ├── registerCommands() → adds generacy.configureEnvironment
  ├── initializeEnvConfig(context)
  │     ├── EnvConfigService.initialize()  →  FileSystemWatcher on .generacy/generacy.env
  │     ├── EnvStatusBarProvider(envService)  →  status bar item (priority 97)
  │     └── context key: generacy.hasEnvConfig
  └── ...existing initialization...

User invokes "Generacy: Configure Environment"
  └── handleConfigureEnvironment() [commands/env.ts]
        ├── resolveWorkspaceRoot() → multi-root quick-pick if needed
        ├── checkGeneracyProject() → verify .generacy/ exists, offer "Run generacy init" if not
        ├── ensureEnvFile() → copy from workspace template or embedded default
        ├── promptGitHubToken() → input box + gh auth token integration
        ├── validateGitHubToken() → API call to github.com/user
        ├── promptAnthropicKey() → input box
        ├── validateAnthropicKey() → API call to api.anthropic.com/v1/models
        ├── promptGeneracyApiKey() → optional, quick-pick opt-in
        ├── writeEnvFile() → hybrid write (regex replace on raw content)
        └── show summary
```

---

## Implementation Phases

### Phase 1: Constants, Types, and Service Skeleton

**Files**: `src/constants.ts`, `src/services/env-config-service.ts`

#### 1.1 Add constants (`constants.ts`)

Add to `COMMANDS`:
```typescript
configureEnvironment: 'generacy.configureEnvironment',
```

Add to `CONTEXT_KEYS`:
```typescript
hasEnvConfig: 'generacy.hasEnvConfig',
```

Add new constants:
```typescript
export const ENV_FILE_NAME = 'generacy.env';
export const ENV_TEMPLATE_NAME = 'generacy.env.template';
export const ENV_FILE_PATH = '.generacy/generacy.env';
export const ENV_FILE_GLOB = '**/.generacy/generacy.env';

export const ENV_REQUIRED_KEYS = ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY'] as const;
```

#### 1.2 Create `EnvConfigService` (`src/services/env-config-service.ts`)

Singleton service following `ProjectConfigService` pattern:

```typescript
export type EnvStatus = 'missing' | 'incomplete' | 'ok';

export class EnvConfigService implements vscode.Disposable {
  // Singleton pattern (same as ProjectConfigService)
  // FileSystemWatcher on ENV_FILE_GLOB
  // Parses env file for required keys (format check only, no API calls)
  // Exposes: status: EnvStatus, onDidChange event
  // Does NOT use dotenv — just regex KEY=VALUE line scanning for status check
}
```

**Key design decisions**:
- Status is computed by scanning raw file content for `KEY=<non-empty-value>` lines matching `ENV_REQUIRED_KEYS`
- No `dotenv` dependency needed — simple regex: `/^(GITHUB_TOKEN|ANTHROPIC_API_KEY)\s*=\s*(.+)$/m`
- `onDidChange` fires when status transitions (missing ↔ incomplete ↔ ok)
- Watches `.generacy/generacy.env` using `vscode.workspace.createFileSystemWatcher` with `RelativePattern`

### Phase 2: Status Bar Provider

**Files**: `src/providers/status-bar.ts`, `src/providers/index.ts`

#### 2.1 Add `EnvStatusBarProvider` (append to `status-bar.ts`)

Follow `ProjectStatusBarProvider` pattern:

```typescript
export class EnvStatusBarProvider implements vscode.Disposable {
  // StatusBarAlignment.Left, priority 97 (after project bar at 98)
  // Command: generacy.configureEnvironment (clicking opens the configure flow)
  // States:
  //   missing  → "$(warning) Env: Missing"  (warning color)
  //   incomplete → "$(warning) Env: Incomplete"  (warning color)
  //   ok → hidden (don't clutter status bar when everything is fine)
  // Subscribes to EnvConfigService.onDidChange
}
```

#### 2.2 Update `providers/index.ts`

Re-export `EnvStatusBarProvider`.

### Phase 3: Command Handler — Core Flow

**Files**: `src/commands/env.ts`

#### 3.1 Workspace resolution (Q12: multi-root)

```typescript
async function resolveWorkspaceRoot(): Promise<vscode.WorkspaceFolder | undefined>
```

- If `workspaceFolders.length === 1`, return it
- If `workspaceFolders.length > 1`, show `QuickPick` to select
- If `workspaceFolders` is empty, show error and return undefined

#### 3.2 Project detection (Q10: missing .generacy/)

```typescript
async function checkGeneracyProject(root: vscode.Uri): Promise<boolean>
```

- Check if `.generacy/` directory exists using `vscode.workspace.fs.stat()`
- If not found, show error message with "Run generacy init" action button
- Action button: check if CLI is installed (`which generacy`), then open terminal with `generacy init`

#### 3.3 Env file creation (Q1: template source strategy — Option D)

```typescript
async function ensureEnvFile(root: vscode.Uri): Promise<vscode.Uri>
```

Priority order:
1. If `.generacy/generacy.env` exists → return its URI (proceed to update flow)
2. If `.generacy/generacy.env.template` exists in workspace → copy to `.generacy/generacy.env`
3. Fall back to embedded default template (static string in source)

The embedded default template is a stripped-down version of the Handlebars template with placeholders removed:
```
# .generacy/generacy.env
# ...header comments...
GITHUB_TOKEN=
ANTHROPIC_API_KEY=
PROJECT_ID=
REDIS_URL=redis://redis:6379
LOG_LEVEL=info
# ...optional section (commented out)...
```

#### 3.4 Token prompting and validation

**GITHUB_TOKEN prompt** (FR-005, FR-008, FR-010):

```typescript
async function promptGitHubToken(currentValue?: string): Promise<string | undefined>
```

1. Show QuickPick: "Enter token manually" | "Use `gh auth token`"
2. If `gh auth token`:
   - Run `child_process.execFile('gh', ['auth', 'token'])` async with 5s timeout (Q3: Option A)
   - On success: use captured stdout as token
   - On failure: show warning, fall back to manual entry
3. If manual entry:
   - Show InputBox with `password: true`
   - Prompt shows masked current value if exists (Q13: "Current: ghp_****abcd" prefix + last 4)
4. Validate token:
   - Call `https://api.github.com/user` with Bearer auth (adapted from CLI `github-token.ts`)
   - On 401/403: definitive auth failure → per-failure recovery (Q4/Q9: QuickPick with "Re-enter", "Skip", "Cancel")
   - On network/timeout error: skip validation with warning (Q9: Option C)
   - On success: check scopes (`repo`, `workflow`), warn if missing (non-blocking)

**ANTHROPIC_API_KEY prompt** (FR-006, FR-009):

```typescript
async function promptAnthropicKey(currentValue?: string): Promise<string | undefined>
```

1. Show InputBox with `password: true`
2. Prompt shows masked current value (Q13: "Current: sk-ant-****abcd")
3. Validate key:
   - Call `https://api.anthropic.com/v1/models` with `x-api-key` header (adapted from CLI `anthropic-key.ts`)
   - Same network vs. auth error distinction as GitHub token (Q9)
   - Same per-failure recovery flow (Q4)

**GENERACY_API_KEY prompt** (FR-007, Q8, Q14):

```typescript
async function promptGeneracyApiKey(): Promise<string | undefined>
```

1. After required keys are configured, show QuickPick: "Would you like to configure optional cloud features (GENERACY_API_KEY)?"
2. If yes: show InputBox (no validation — Q14: Option A)
3. If no: skip

#### 3.5 File writing (Q2: hybrid approach, Q6: workspace.fs)

```typescript
async function writeEnvFile(
  envUri: vscode.Uri,
  updates: Record<string, string>
): Promise<void>
```

1. Read raw file content via `vscode.workspace.fs.readFile()`
2. For each key in updates:
   - Regex find: `/^(<KEY>)\s*=.*$/m`
   - If found: replace entire line with `KEY=<value>`
   - If not found: append `KEY=<value>` at end of file
3. Write back via `vscode.workspace.fs.writeFile()` (Q6: Option A, non-atomic)
4. Comments, blank lines, and ordering are preserved (Q2: Option C)

#### 3.6 Summary display

After all tokens are configured:
- Show information message: "Environment configured successfully. X of Y required keys set."
- If any validations were skipped (network errors): append "Run again to validate skipped tokens."

### Phase 4: Extension Integration

**Files**: `src/extension.ts`, `package.json`

#### 4.1 Register command in `extension.ts`

Add to the `commands` array in `registerCommands()`:
```typescript
{
  id: COMMANDS.configureEnvironment,
  handler: withErrorHandling(handleConfigureEnvironment, { showOutput: true }),
}
```

Add `initializeEnvConfig()` function (similar to `initializeProjectConfig()`):
- Initialize `EnvConfigService`
- Set context key `generacy.hasEnvConfig`
- Create `EnvStatusBarProvider`
- Wire up `onDidChange` to update context key

#### 4.2 Update `package.json`

Add command contribution:
```json
{
  "command": "generacy.configureEnvironment",
  "title": "Configure Environment",
  "category": "Generacy",
  "icon": "$(gear)"
}
```

No additional activation events needed — the extension already activates on `.generacy/*.yaml` presence.

### Phase 5: Tests

**Files**: `src/commands/__tests__/env.test.ts`, `src/services/__tests__/env-config-service.test.ts`, `src/providers/__tests__/env-status-bar.test.ts`

#### 5.1 `EnvConfigService` tests

- Initialization with missing file → status `missing`
- Initialization with file missing required keys → status `incomplete`
- Initialization with all required keys → status `ok`
- File watcher: create triggers reload, change triggers reload, delete sets `missing`
- `onDidChange` fires on status transitions
- Dispose cleans up watcher and emitter

#### 5.2 `EnvStatusBarProvider` tests

- Shows warning when status is `missing`
- Shows warning when status is `incomplete`
- Hides when status is `ok`
- Updates on `onDidChange` events
- Dispose cleans up

#### 5.3 Command handler tests

- Multi-root workspace shows quick-pick
- Missing `.generacy/` shows error with "Run generacy init" button
- Missing env file copies from workspace template
- Missing env file falls back to embedded default
- GitHub token: `gh auth token` success path
- GitHub token: `gh auth token` failure falls back to manual
- GitHub token validation: 401 triggers re-entry flow
- GitHub token validation: network error skips with warning
- Anthropic key validation: same patterns
- GENERACY_API_KEY: skip flow
- File write preserves comments
- File write updates existing keys in place

---

## Key Technical Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| Q1 | Embedded default + workspace fallback | No Handlebars dep; workspace file preferred when available |
| Q2 | Hybrid parse (dotenv read, regex write) | Preserves comments/ordering with moderate complexity |
| Q3 | `execFile` async, 5s timeout | Non-blocking; matches CLI pattern |
| Q4 | Per-failure QuickPick (re-enter/skip/cancel) | Standard VS Code UX; user control at each step |
| Q5 | Duplicate validation with attribution | ~50 LOC; shared package adds scope |
| Q6 | `workspace.fs.writeFile` (non-atomic) | Consistent with `ProjectConfigService`; env file is small |
| Q7 | Format validation on change (no API calls) | FileSystemWatcher + key presence check; fast |
| Q8 | Prompt at end with opt-in | Minimal onboarding friction |
| Q9 | Distinguish network vs. auth errors | Network → skip with warning; 401/403 → auth failure |
| Q10 | Error with "Run generacy init" action button | Helpful UX without significant complexity |
| Q11 | Standard command tracking only | Follow existing `withErrorHandling` + `trackCommand` pattern |
| Q12 | QuickPick for workspace selection | Single call; much better UX than silent first-folder |
| Q13 | Prefix + last 4 chars masked display | Standard token display; identifiable |
| Q14 | No validation for GENERACY_API_KEY | No known format/endpoint; runtime validation sufficient |

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| `gh` CLI not installed | Token acquisition falls back to manual entry | Check `execFile` failure; clear error message |
| Network offline during validation | User blocked from configuring env | Skip validation with warning (Q9); file still written |
| Workspace template diverges from embedded default | Inconsistent env file content | Workspace template takes precedence; embedded default is minimal |
| Token accidentally logged | Security breach | Use `password: true` on InputBox; never log token values; mask in display |
| Race condition: file changed during write | Stale data written | Read-modify-write is fast on small files; acceptable risk |
| Extension host blocked | UI freeze | All I/O is async (`workspace.fs`, `execFile`); no blocking calls |

---

## File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `src/constants.ts` | Modify | Add command ID, context key, env file constants |
| `src/services/env-config-service.ts` | Create | Env file watcher + status service |
| `src/providers/status-bar.ts` | Modify | Add `EnvStatusBarProvider` class |
| `src/providers/index.ts` | Modify | Re-export `EnvStatusBarProvider` |
| `src/commands/env.ts` | Create | Configure environment command handler |
| `src/extension.ts` | Modify | Register command, initialize env service + status bar |
| `package.json` | Modify | Add command contribution |
| `src/services/__tests__/env-config-service.test.ts` | Create | Service tests |
| `src/providers/__tests__/env-status-bar.test.ts` | Create | Status bar tests |
| `src/commands/__tests__/env.test.ts` | Create | Command handler tests |

---

## Embedded Default Template

```env
# .generacy/generacy.env
#
# Environment configuration for Generacy.
# This file contains secrets — DO NOT commit to version control.
#
# Required keys: GITHUB_TOKEN, ANTHROPIC_API_KEY
# Run "Generacy: Configure Environment" in VS Code to set values interactively.

# ============================================================================
# GitHub Integration
# ============================================================================

# GitHub Personal Access Token (PAT) with repo permissions
# Required for: Creating PRs, reading repositories, managing issues
# Get one at: https://github.com/settings/tokens/new
# Minimum scopes: repo, workflow
GITHUB_TOKEN=

# ============================================================================
# AI Agent Configuration
# ============================================================================

# Anthropic API key for Claude Code agent
# Required for: Running AI-powered development tasks
# Get one at: https://console.anthropic.com/settings/keys
ANTHROPIC_API_KEY=

# ============================================================================
# Project Configuration
# ============================================================================

# Your Generacy project ID (auto-populated from config.yaml)
PROJECT_ID=

# ============================================================================
# Local Development Configuration
# ============================================================================

# Redis URL for task queue
REDIS_URL=redis://redis:6379

# Logging level (debug, info, warn, error)
LOG_LEVEL=info

# ============================================================================
# Optional: Advanced Configuration
# ============================================================================

# Uncomment and configure these if you need custom behavior:

# Base branch for pull requests
# BASE_BRANCH=develop

# API endpoint for Generacy cloud service
# GENERACY_API_URL=https://api.generacy.ai

# Cloud features API key (optional)
# GENERACY_API_KEY=
```

---

## Validation Logic (Duplicated from CLI with Attribution)

### GitHub Token Validation
```typescript
// Adapted from packages/generacy/src/cli/commands/doctor/checks/github-token.ts
async function validateGitHubToken(token: string): Promise<ValidationResult> {
  // fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) })
  // Check response.status: 401/403 → auth failure, network error → skip
  // Check X-OAuth-Scopes for repo, workflow (warn if missing, accept fine-grained tokens)
}
```

### Anthropic Key Validation
```typescript
// Adapted from packages/generacy/src/cli/commands/doctor/checks/anthropic-key.ts
async function validateAnthropicKey(key: string): Promise<ValidationResult> {
  // fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(5_000) })
  // Check response.status: 401/403 → auth failure, network error → skip
}
```

### ValidationResult Type
```typescript
type ValidationResult =
  | { status: 'valid'; message: string; detail?: string }
  | { status: 'invalid'; message: string; suggestion: string }
  | { status: 'network_error'; message: string }
  | { status: 'warning'; message: string; detail: string };  // e.g., missing scopes
```
