# Tasks: 5.3 — Generacy VS Code Extension — generacy.env Configuration Helper

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (ENV = env configuration)

---

## Phase 1: Constants and Types

### T001 [DONE] Add env-related constants to `constants.ts`
**File**: `packages/generacy-extension/src/constants.ts`
- Add `configureEnvironment: 'generacy.configureEnvironment'` to `COMMANDS` object
- Add `hasEnvConfig: 'generacy.hasEnvConfig'` to `CONTEXT_KEYS` object
- Add standalone constants:
  - `ENV_FILE_NAME = 'generacy.env'`
  - `ENV_TEMPLATE_NAME = 'generacy.env.template'`
  - `ENV_FILE_PATH = '.generacy/generacy.env'`
  - `ENV_FILE_GLOB = '**/.generacy/generacy.env'`
  - `ENV_REQUIRED_KEYS = ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY'] as const`

---

## Phase 2: Core Service

### T002 [DONE] [ENV] Create `EnvConfigService` singleton
**File**: `packages/generacy-extension/src/services/env-config-service.ts` (new)
- Follow `ProjectConfigService` singleton pattern (`getInstance()`, `resetInstance()`, private constructor)
- Implement `vscode.Disposable`
- Define `EnvStatus` type: `'missing' | 'incomplete' | 'ok'`
- Properties:
  - `status: EnvStatus` — computed from file content
  - `onDidChange: Event<EnvStatus>` — fires on status transitions
- `initialize()` method:
  - Read `.generacy/generacy.env` via `vscode.workspace.fs.readFile()`
  - Compute initial status by scanning for `ENV_REQUIRED_KEYS` with non-empty values
  - Set up `FileSystemWatcher` on `ENV_FILE_GLOB` using `RelativePattern`
  - Register `onDidCreate`, `onDidChange`, `onDidDelete` handlers
- Status computation:
  - Use regex `/^(GITHUB_TOKEN|ANTHROPIC_API_KEY)\s*=\s*(.+)$/m` per key
  - `missing` = file doesn't exist
  - `incomplete` = file exists but not all required keys have non-empty values
  - `ok` = all required keys present with non-empty values
- `dispose()`: clean up watcher, emitter, disposables
- Export `getEnvConfigService()` helper function

---

## Phase 3: Status Bar Provider

### T003 [DONE] [P] [ENV] Add `EnvStatusBarProvider` to status bar module
**File**: `packages/generacy-extension/src/providers/status-bar.ts`
- Append `EnvStatusBarProvider` class after existing `ProjectStatusBarProvider`
- Follow `ProjectStatusBarProvider` pattern (constructor takes service, subscribes to events)
- Constructor accepts `EnvConfigService` instance
- Status bar item configuration:
  - `StatusBarAlignment.Left`, priority `97` (after project bar at 98)
  - `name`: `'Generacy Environment'`
  - `command`: `'generacy.configureEnvironment'` (click opens configure flow)
- Display states:
  - `missing` → `"$(warning) Env: Missing"` with warning background color
  - `incomplete` → `"$(warning) Env: Incomplete"` with warning background color
  - `ok` → hide status bar item (don't clutter when everything works)
- Subscribe to `EnvConfigService.onDidChange` to update display
- Implement `dispose()` to clean up status bar item and subscriptions

### T004 [DONE] [P] [ENV] Update provider exports
**File**: `packages/generacy-extension/src/providers/index.ts`
- Add `EnvStatusBarProvider` to the export list from `'./status-bar'`

---

## Phase 4: Command Handler

### T005 [DONE] [ENV] Create env configuration command handler
**File**: `packages/generacy-extension/src/commands/env.ts` (new)
- Export `handleConfigureEnvironment()` async function as main entry point
- Implement the following sub-functions:

#### T005 [DONE]a Workspace resolution
- `resolveWorkspaceRoot()`: return single workspace folder, or show QuickPick for multi-root, or show error if none

#### T005 [DONE]b Project detection
- `checkGeneracyProject(root: vscode.Uri)`: check `.generacy/` dir exists via `vscode.workspace.fs.stat()`
- If missing: show error with "Run generacy init" action button
- Action button: run `which generacy` check, then open integrated terminal with `generacy init`

#### T005 [DONE]c Env file creation
- `ensureEnvFile(root: vscode.Uri)`: ensure `.generacy/generacy.env` exists
  - Priority 1: file already exists → return URI
  - Priority 2: copy from `.generacy/generacy.env.template` if it exists in workspace
  - Priority 3: write embedded default template (static string constant in file)
- Include full embedded default template from plan (with comments, section headers, all default keys)

#### T005 [DONE]d GitHub token prompting
- `promptGitHubToken(currentValue?: string)`:
  - Show QuickPick: "Enter token manually" | "Use `gh auth token`"
  - `gh auth token` path: `child_process.execFile` async with 5s timeout
  - On `gh` failure: show warning, fall back to manual entry
  - Manual entry: `InputBox` with `password: true`, masked current value display (last 4 chars)

#### T005 [DONE]e GitHub token validation
- `validateGitHubToken(token: string)`: return `ValidationResult`
  - Adapted from `packages/generacy/src/cli/commands/doctor/checks/github-token.ts`
  - `fetch('https://api.github.com/user')` with Bearer auth, 5s `AbortSignal.timeout`
  - 401/403 → `invalid` result
  - Network/timeout error → `network_error` result
  - Success → check `X-OAuth-Scopes` header for `repo`, `workflow` scopes
  - Missing scopes → `warning` result (non-blocking, accept fine-grained tokens)

#### T005 [DONE]f Anthropic key prompting
- `promptAnthropicKey(currentValue?: string)`:
  - `InputBox` with `password: true`, masked current value display

#### T005 [DONE]g Anthropic key validation
- `validateAnthropicKey(key: string)`: return `ValidationResult`
  - Adapted from `packages/generacy/src/cli/commands/doctor/checks/anthropic-key.ts`
  - `fetch('https://api.anthropic.com/v1/models')` with `x-api-key` header, 5s timeout
  - Same error handling pattern as GitHub validation

#### T005 [DONE]h Generacy API key prompting (optional)
- `promptGeneracyApiKey()`:
  - QuickPick opt-in: "Configure optional cloud features (GENERACY_API_KEY)?"
  - If yes: `InputBox` (no validation)
  - If no: skip, return undefined

#### T005 [DONE]i Validation failure recovery
- `handleValidationFailure(keyName: string)`: per-failure QuickPick
  - Options: "Re-enter", "Skip", "Cancel setup"
  - Returns action to take

#### T005 [DONE]j Env file writing
- `writeEnvFile(envUri: vscode.Uri, updates: Record<string, string>)`:
  - Read raw content via `vscode.workspace.fs.readFile()`
  - For each key: regex replace `/^(KEY)\s*=.*$/m` → `KEY=value`
  - If key not found in file: append `KEY=value` at end
  - Write back via `vscode.workspace.fs.writeFile()`
  - Preserves comments, blank lines, and ordering

#### T005 [DONE]k Summary display
- After all tokens configured:
  - Information message: "Environment configured successfully. X of Y required keys set."
  - If validations were skipped: append "Run again to validate skipped tokens."

#### T005 [DONE]l Define `ValidationResult` type
- Define in `env.ts` (or separate types file):
  ```
  type ValidationResult =
    | { status: 'valid'; message: string; detail?: string }
    | { status: 'invalid'; message: string; suggestion: string }
    | { status: 'network_error'; message: string }
    | { status: 'warning'; message: string; detail: string }
  ```

---

## Phase 5: Extension Integration

### T006 [DONE] [ENV] Register command and initialize env service in `extension.ts`
**File**: `packages/generacy-extension/src/extension.ts`
- Import `handleConfigureEnvironment` from `'./commands/env'`
- Import `EnvStatusBarProvider` from `'./providers'`
- Import `getEnvConfigService` from `'./services/env-config-service'`
- Add command to `commands` array in `registerCommands()`:
  ```
  { id: COMMANDS.configureEnvironment, handler: withErrorHandling(handleConfigureEnvironment, { showOutput: true }) }
  ```
- Add `initializeEnvConfig(context)` function (follow `initializeProjectConfig` pattern):
  - Get/initialize `EnvConfigService`
  - Set context key `generacy.hasEnvConfig` via `setContext` command
  - Create `EnvStatusBarProvider(envService)`, push to `context.subscriptions`
  - Subscribe to `onDidChange` to update context key
  - Push service to `context.subscriptions` for disposal
- Call `void initializeEnvConfig(context)` in `activate()` after project config init

### T007 [DONE] [P] [ENV] Add command contribution to `package.json`
**File**: `packages/generacy-extension/package.json`
- Add to `contributes.commands` array:
  ```json
  {
    "command": "generacy.configureEnvironment",
    "title": "Configure Environment",
    "category": "Generacy",
    "icon": "$(gear)"
  }
  ```

---

## Phase 6: Tests

### T008 [DONE] [P] [ENV] Write `EnvConfigService` unit tests
**File**: `packages/generacy-extension/src/services/__tests__/env-config-service.test.ts` (new)
- Follow `project-config-service.test.ts` pattern for mock setup
- Mock `vscode` module (workspace.fs, FileSystemWatcher, EventEmitter, RelativePattern)
- Mock logger
- Test suites:
  - **Singleton**: same instance on repeated calls, fresh after reset, helper function works
  - **Missing file**: status = `missing`, isConfigured-equivalent behavior
  - **Incomplete file**: file exists with only `GITHUB_TOKEN=xxx` → status = `incomplete`
  - **Complete file**: both `GITHUB_TOKEN=xxx` and `ANTHROPIC_API_KEY=xxx` → status = `ok`
  - **Empty values**: `GITHUB_TOKEN=` (empty) → counts as missing, status = `incomplete`
  - **File watcher**: create triggers reload, change triggers reload, delete sets `missing`
  - **onDidChange**: fires on status transitions (missing→ok, ok→incomplete, etc.)
  - **No-op transitions**: does NOT fire when status stays the same
  - **Disposal**: cleans up watcher, emitter; no events after dispose

### T009 [DONE] [P] [ENV] Write `EnvStatusBarProvider` unit tests
**File**: `packages/generacy-extension/src/providers/__tests__/env-status-bar.test.ts` (new)
- Mock `vscode` module (window.createStatusBarItem, ThemeColor)
- Mock `EnvConfigService` with configurable status and event emitter
- Test suites:
  - Shows `"$(warning) Env: Missing"` with warning color when status = `missing`
  - Shows `"$(warning) Env: Incomplete"` with warning color when status = `incomplete`
  - Hides status bar item when status = `ok`
  - Updates display when `onDidChange` fires with new status
  - Sets `command` to `generacy.configureEnvironment`
  - Dispose cleans up status bar item and event subscriptions

### T010 [DONE] [P] [ENV] Write command handler unit tests
**File**: `packages/generacy-extension/src/commands/__tests__/env.test.ts` (new)
- Follow `workflow.test.ts` pattern for mock setup
- Mock `vscode`, `child_process`, `fetch` (global)
- Test suites:
  - **Workspace resolution**:
    - Single workspace folder → returns it directly
    - Multi-root workspace → shows QuickPick, returns selection
    - No workspace folders → shows error message, returns undefined
  - **Project detection**:
    - `.generacy/` exists → returns true
    - `.generacy/` missing → shows error with "Run generacy init" button
  - **Env file creation**:
    - `.generacy/generacy.env` exists → returns URI without writing
    - `.generacy/generacy.env.template` exists → copies to `.generacy/generacy.env`
    - No template → creates from embedded default
  - **GitHub token flow**:
    - `gh auth token` success → uses captured token
    - `gh auth token` failure → falls back to manual input
    - Manual entry → shows InputBox with `password: true`
    - Validation success → proceeds
    - Validation 401 → shows re-enter/skip/cancel QuickPick
    - Validation network error → skips with warning
    - Missing scopes → shows warning but accepts token
  - **Anthropic key flow**:
    - InputBox with `password: true`
    - Validation success → proceeds
    - Validation 401 → shows re-enter/skip/cancel QuickPick
    - Validation network error → skips with warning
  - **GENERACY_API_KEY flow**:
    - User opts in → shows InputBox
    - User skips → no prompt
  - **File writing**:
    - Updates existing key in place (preserves comments and ordering)
    - Appends key if not found in file
    - Handles multiple key updates in single write
  - **Summary display**:
    - Shows success message with count of configured keys
    - Appends validation skip notice when applicable

---

## Phase 7: Integration Verification

### T011 [DONE] [ENV] Verify build and tests pass
**Files**: n/a (build/test run)
- Run `pnpm typecheck` in `packages/generacy-extension` to verify no type errors
- Run `pnpm test` in `packages/generacy-extension` to verify all tests pass (existing + new)
- Run `pnpm build` in `packages/generacy-extension` to verify esbuild bundle succeeds

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (constants) must complete before Phase 2 (service) — service imports constants
- Phase 2 (service) must complete before Phase 3 (status bar provider) — provider takes service
- Phase 2 (service) must complete before Phase 4 (command handler) — command uses service indirectly
- Phase 3 + Phase 4 must complete before Phase 5 (extension integration) — wires everything together
- Phases 1–5 must complete before Phase 6 (tests) — tests import implementation
- Phase 6 must complete before Phase 7 (verification) — tests must exist to run

**Parallel opportunities within phases**:
- T003 + T004 can run in parallel (different files in providers/)
- T007 can run in parallel with T006 (package.json vs extension.ts)
- T008 + T009 + T010 can all run in parallel (independent test files)

**Critical path**:
```
T001 → T002 → T003/T004 → T005 → T006/T007 → T008/T009/T010 → T011
```

**File change summary**:

| File | Action | Task |
|------|--------|------|
| `src/constants.ts` | Modify | T001 |
| `src/services/env-config-service.ts` | Create | T002 |
| `src/providers/status-bar.ts` | Modify | T003 |
| `src/providers/index.ts` | Modify | T004 |
| `src/commands/env.ts` | Create | T005 |
| `src/extension.ts` | Modify | T006 |
| `package.json` | Modify | T007 |
| `src/services/__tests__/env-config-service.test.ts` | Create | T008 |
| `src/providers/__tests__/env-status-bar.test.ts` | Create | T009 |
| `src/commands/__tests__/env.test.ts` | Create | T010 |
