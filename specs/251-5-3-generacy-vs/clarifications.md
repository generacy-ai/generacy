# Clarification Questions

## Status: Resolved

## Questions

### Q1: Template Source Strategy
**Context**: The env template at `packages/templates/src/shared/generacy.env.template.hbs` is a Handlebars file with conditional sections (e.g., multi-repo `POLL_INTERVAL_MS`) and interpolated values (e.g., `PROJECT_ID={{project.id}}`). The spec mentions two options — embedding a pre-rendered version or importing the templates package — but doesn't decide. The choice affects bundling complexity, maintenance burden, and whether the generated env file includes project-specific values like `PROJECT_ID`.
**Question**: How should the extension source the env template content when creating a new `.generacy/generacy.env`?
**Options**:
- A) Embed a static template: Hard-code a minimal env file skeleton in the extension source with placeholder lines for `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `PROJECT_ID`, etc. Simpler but diverges from the canonical template over time.
- B) Read from workspace: Look for `generacy.env.template` (or `.hbs`) in the workspace (placed by `generacy init`) and copy it directly. Relies on the template file existing in the workspace.
- C) Import `@generacy/templates` package: Bundle the templates package into the extension, render the Handlebars template using `ProjectConfigService` data (project ID, base branch, etc.). Most accurate but adds a Handlebars dependency and build complexity.
- D) Embed a pre-rendered default and fall back to workspace file: Ship a default static template but prefer a workspace-local `generacy.env.template` if present. Balances portability with accuracy.
**Answer**: **D** — Embed a pre-rendered default and fall back to workspace file. The onboarding PR (4.1) and `generacy init` (4.5) both place the template in the workspace, so in the happy path the workspace file exists. Shipping an embedded default handles edge cases (manual setup, template deleted, etc.). The workspace file takes precedence so project-specific values from the Handlebars rendering are used when available. No Handlebars dependency needed in the extension.

---

### Q2: Env File Parsing and Comment Preservation
**Context**: FR-004 and FR-011 require preserving comments, blank lines, and ordering when updating an existing env file. The CLI's `dotenv` parser (`parseDotenv`) discards comments and structure — it only returns key-value pairs. A structure-preserving parser needs to operate on raw lines, updating only the lines whose keys changed. This is a non-trivial implementation detail that affects correctness of US2.
**Question**: Should the extension implement a custom line-by-line parser that preserves the full file structure, or is it acceptable to use `dotenv` parsing and rewrite the file (potentially losing comments and ordering)?
**Options**:
- A) Custom line-by-line parser: Parse the file line-by-line, identify `KEY=VALUE` lines by regex, update matched keys in-place, and preserve all other lines verbatim. More work but preserves user customizations.
- B) Use `dotenv` and rewrite: Parse with `dotenv`, merge updated values, and write a clean file from a template structure. Simpler but loses user comments and custom ordering.
- C) Hybrid approach: Use `dotenv` for reading values (validation) but read raw file content for writing — do a regex-based find-and-replace on specific `KEY=...` lines in the raw text. Moderate complexity with good preservation.
**Answer**: **C** — Hybrid approach. Use `dotenv` for reading/validating values, but operate on raw file content for writes — regex-based find-and-replace on `KEY=...` lines. This preserves comments and ordering with moderate complexity. The existing CLI already uses `dotenv.parse()` for reading, so this stays consistent. The write side is just a simple line-by-line regex — not a full parser.

---

### Q3: `gh auth token` Execution Method
**Context**: FR-010 specifies running `gh auth token` but doesn't decide between `child_process.execSync` (blocks the extension host) and the VS Code Terminal API (runs in a visible terminal but is harder to capture output from). The extension host is single-threaded, so blocking it during a slow `gh` invocation could freeze the UI. However, `child_process.exec` (async) or `child_process.execFile` could avoid blocking while still capturing stdout.
**Question**: Which method should the extension use to execute `gh auth token`?
**Options**:
- A) `child_process.execFile` (async, non-blocking): Run `gh auth token` asynchronously, capture stdout, apply a 5-second timeout. Does not block the extension host. Preferred for responsiveness.
- B) `child_process.execSync` (blocking): Simpler code but blocks the extension host thread until `gh` completes. Acceptable if `gh auth token` is fast (typically <1s).
- C) VS Code Terminal API: Create a terminal, run the command, and parse output. Most visible to the user but significantly harder to capture output programmatically — better suited for interactive flows like `gh auth login`.
**Answer**: **A** — `child_process.execFile` (async, non-blocking). The existing codebase already uses `spawn` with async patterns in `cli-utils.ts`. Blocking the extension host is bad practice regardless of how fast `gh` typically is. Use `execFile` with a 5-second timeout (matching the CLI doctor pattern) and `AbortSignal` for cancellation.

---

### Q4: Validation Failure Recovery Flow
**Context**: The spec's command flow shows "On failure → show error, offer to retry or skip validation" but doesn't detail the UX. When a token fails validation (e.g., expired GitHub token, wrong Anthropic key), the user needs a clear path forward. Should they re-enter the value immediately, continue configuring other values and fix later, or abort entirely? This affects whether partially-valid configurations get written to disk.
**Question**: What should happen when a token fails validation during the interactive configuration flow?
**Options**:
- A) Retry inline: Show the error and immediately re-prompt for the same value. Loop until valid or user cancels. Only write the file after all values pass validation.
- B) Continue and warn: Show the error, let the user continue configuring other values, and write all values (including invalid ones) to the env file with a summary of validation failures at the end. User can re-run later.
- C) Ask per failure: On each validation failure, show a quick-pick with options: "Re-enter value", "Skip validation and keep value", "Cancel setup". Gives the user control at each step.
**Answer**: **C** — Ask per failure. Show a quick-pick per validation failure with "Re-enter value", "Skip validation and keep value", "Cancel setup". This matches VS Code UX conventions (quick-picks for decisions), gives users control at each step, and avoids both the frustration of mandatory retry loops and the confusion of silently writing invalid values. Write the file with whatever values the user confirms.

---

### Q5: Validation Code Sharing Strategy
**Context**: FR-008 and FR-009 reference reusing validation logic from the CLI doctor checks (`github-token.ts`, `anthropic-key.ts`). The extension bundles separately from the CLI (different build targets, possibly different module systems). The spec suggests either extracting to a shared package or duplicating with attribution. This is an architectural decision that affects long-term maintenance — shared code stays in sync, duplicated code can drift.
**Question**: How should the validation logic be shared between the CLI and the VS Code extension?
**Options**:
- A) Extract to shared package: Create a new `@generacy/validation` (or similar) package in the monorepo that both the CLI and extension depend on. Best for long-term maintenance but requires package setup and may have bundling implications.
- B) Duplicate with attribution: Copy the validation functions into the extension source with a comment referencing the CLI source. Accept the drift risk for faster implementation.
- C) Import from CLI package: Depend on `@generacy/generacy` (the CLI package) from the extension and import just the validation functions. Risks pulling in unwanted CLI dependencies into the extension bundle.
**Answer**: **B** — Duplicate with attribution. The validation logic is small and self-contained (format check + single API call each). Extracting to a shared package adds meaningful scope (new package setup, build config, dependency management) for ~50 lines of code. Duplicate now with a `// Adapted from packages/generacy/src/cli/commands/doctor/checks/github-token.ts` comment. If the validation logic grows or diverges, extract later — that's a cleaner refactor boundary.

---

### Q6: Atomic Write Implementation
**Context**: FR-011 specifies "atomic write (write to temp, then rename)" for writing the env file. However, the VS Code `workspace.fs` API doesn't support atomic write operations (no temp file + rename). Using Node.js `fs` directly bypasses VS Code's file system abstraction (which matters for remote workspaces, virtual file systems). The existing `ProjectConfigService` uses `vscode.workspace.fs.writeFile` without atomic semantics.
**Question**: Should the env file write use atomic semantics (temp + rename via Node.js `fs`) or follow the existing pattern of direct `vscode.workspace.fs.writeFile`?
**Options**:
- A) Use `vscode.workspace.fs.writeFile` (non-atomic): Follow the existing `ProjectConfigService` pattern. Simpler, works with remote/virtual file systems, but risks partial writes on crash.
- B) Use Node.js `fs` with temp + rename: True atomic write but breaks compatibility with remote workspaces and virtual file systems. The env file is local-only (Docker Compose reads it), so remote FS support may not matter.
- C) Try atomic, fall back to direct: Attempt Node.js `fs` atomic write, catch errors (e.g., remote FS), and fall back to `vscode.workspace.fs.writeFile`.
**Answer**: **A** — Use `vscode.workspace.fs.writeFile` (non-atomic). Follow the existing `ProjectConfigService` pattern. The env file is small, so partial-write risk from crashes is negligible. Consistency with the existing codebase outweighs theoretical safety gains. Using `workspace.fs` avoids introducing a second file I/O pattern in the extension.

---

### Q7: Status Bar Indicator Behavior
**Context**: FR-016 (P3) mentions a status bar indicator when `.generacy/generacy.env` is missing or has validation errors, but doesn't specify the validation trigger. Validation requires API calls (GitHub, Anthropic) which are slow and rate-limited. Running validation on every file change or workspace open could be expensive and slow. The indicator needs a clear lifecycle for when it shows/hides and what states it represents.
**Question**: When should the status bar indicator validate the env file, and what states should it display?
**Options**:
- A) Existence-only check: Only check whether `.generacy/generacy.env` exists (fast, no API calls). Show "Env: Missing" or "Env: OK". Validation only runs when the user explicitly runs the configure command.
- B) Format validation on change: Check file existence and parse for required keys on file change (no API calls). Show "Env: Missing", "Env: Incomplete" (missing keys), or "Env: OK". API validation only on explicit command run.
- C) Full validation on activation: Run full validation (including API calls) once on extension activation, then only re-validate on file change or explicit command. Show "Env: Missing", "Env: Invalid" (API failures), or "Env: OK". Risk of slow startup.
**Answer**: **B** — Format validation on change. Check file existence and parse for required keys on file change — no API calls. Show "Env: Missing", "Env: Incomplete" (missing keys), or "Env: OK". Full API validation only runs when the user explicitly invokes the configure command. Use a `FileSystemWatcher` (same pattern as `ProjectConfigService`).

---

### Q8: GENERACY_API_KEY Prompt Behavior
**Context**: FR-007 marks `GENERACY_API_KEY` as P2 and "optional, skippable," labeled "for cloud features." The spec doesn't clarify whether the user should be prompted for it by default or only if they opt in. For onboarding users who don't use cloud features, an extra prompt adds friction. For users who need it, skipping by default means they might miss it.
**Question**: How should the `GENERACY_API_KEY` prompt be presented in the configuration flow?
**Options**:
- A) Always prompt with skip default: Show the input box but pre-select "Skip" or show a quick-pick asking "Configure cloud features? (Optional)" before the input box. Low friction but visible.
- B) Only prompt if previously configured: On first setup, skip entirely. On re-run (env file exists), show it only if a value already exists. Minimizes onboarding friction.
- C) Prompt at the end with explanation: After configuring required keys, show a final quick-pick: "Would you like to configure optional cloud features (GENERACY_API_KEY)?" with a brief description. Clear opt-in.
**Answer**: **C** — Prompt at the end with explanation. After configuring required keys, show a quick-pick: "Would you like to configure optional cloud features (GENERACY_API_KEY)?" with a brief description. Clear opt-in, minimal onboarding friction, and the user knows it exists without being forced through it.

---

### Q9: Network Timeout and Offline Behavior
**Context**: The CLI doctor checks use a 5-second timeout (`AbortSignal.timeout(5_000)`) for API validation calls. The spec doesn't address what happens if the user is offline, behind a corporate proxy, or on a slow network. Token validation (FR-008, FR-009) requires network access, and failures could block the entire configuration flow. The "Assumptions" section states "Users have network access" but doesn't define the fallback.
**Question**: How should the extension handle network failures during token validation?
**Options**:
- A) Skip validation with warning: If API calls fail due to network errors (timeout, DNS, connection refused), write the token as-is and show a warning: "Could not validate token — network unavailable. Run the command again later to validate."
- B) Retry with longer timeout: On network failure, offer to retry with a longer timeout (15s). If still failing, allow the user to skip validation or cancel.
- C) Distinguish network vs. auth errors: On connection/timeout errors, skip validation with a warning. On HTTP 401/403, treat as a definitive auth failure and require re-entry. This avoids blocking offline users while still catching bad credentials when online.
**Answer**: **C** — Distinguish network vs. auth errors. On connection/timeout/DNS errors: skip validation, write the token as-is, show a warning ("Could not validate — network unavailable. Run again later to validate."). On HTTP 401/403: treat as a definitive auth failure, trigger the per-failure recovery flow from Q4. This matches the CLI doctor check pattern which already uses `AbortSignal.timeout(5_000)` and distinguishes response status codes.

---

### Q10: Error Handling for Missing `.generacy/` Directory
**Context**: The command flow shows that if no `.generacy/` directory exists, the extension should show "No Generacy project detected. Run generacy init first." However, the spec doesn't address whether the extension should offer to run `generacy init` or provide more guidance. The current CLI init summary tells users to run `generacy init` manually, but a VS Code extension could potentially guide the user more interactively.
**Question**: When the workspace has no `.generacy/` directory, should the extension offer to help initialize the project?
**Options**:
- A) Show error message only: Display "No Generacy project detected. Run `generacy init` in the terminal first." Keep it simple and within spec scope.
- B) Show error with action button: Display the error with a button that opens a terminal and runs `generacy init`. More helpful but assumes the CLI is installed.
- C) Defer to existing extension behavior: If the 5.2 MVP extension already handles project detection and initialization prompts, rely on that flow and just show a brief message. Avoids duplicating logic.
**Answer**: **B** — Show error with action button. Display the error message with a "Run generacy init" button that opens a terminal and executes the command. Check if the CLI is installed first — if not, show a message guiding to `npm install -g @generacy-ai/generacy`. This is more helpful than a bare error message without adding significant complexity.

---

### Q11: Telemetry and Command Tracking
**Context**: The existing extension wraps all command handlers with telemetry tracking (`telemetry.trackCommand`, `telemetry.trackError`) and error handling (`withErrorHandling`). The spec doesn't mention telemetry for the new `generacy.configureEnvironment` command, but the established pattern suggests it should be tracked. Telemetry data could include: command invoked, flow completed/abandoned, validation pass/fail rates, and `gh` CLI usage.
**Question**: What telemetry events should the configure environment command track?
**Options**:
- A) Standard command tracking only: Use the existing `withErrorHandling` wrapper and `telemetry.trackCommand` pattern — just track invocation count, duration, and errors. No custom events.
- B) Detailed flow tracking: Track additional events: `env.configure.started`, `env.configure.completed`, `env.configure.abandoned`, `env.validate.github.pass/fail`, `env.validate.anthropic.pass/fail`, `env.configure.gh_cli_used`. Useful for understanding onboarding success rates.
- C) Defer to implementation: Don't specify telemetry in the spec — let the implementer follow existing patterns and add events as appropriate.
**Answer**: **A** — Standard command tracking only. Use the existing `withErrorHandling` wrapper and `telemetry.trackCommand` pattern. The extension already has a well-established telemetry pattern. Adding detailed flow tracking adds scope without a clear use case for the granular data yet. The implementer can follow existing patterns naturally.

---

### Q12: Multi-Root Workspace Handling
**Context**: The spec explicitly lists multi-root workspace support as "Out of Scope" and assumes a single workspace root. However, VS Code users commonly open multi-root workspaces, and `vscode.workspace.workspaceFolders` can return multiple folders. The existing `ProjectConfigService` uses `workspaceFolders[0]` (the first folder). The spec should clarify what happens if the user has multiple workspace roots — silently use the first, show an error, or let the user choose.
**Question**: If a user has a multi-root workspace, what should the configure environment command do?
**Options**:
- A) Silently use first workspace folder: Follow the `ProjectConfigService` pattern — use `workspaceFolders[0]`. No user-facing indication that other roots are ignored.
- B) Show quick-pick to select workspace: If multiple workspace folders exist, show a quick-pick letting the user choose which workspace root to configure. Adds minor complexity but prevents confusion.
- C) Error if multi-root: Show a warning message that multi-root workspaces are not supported and the command will use the first workspace folder. Transparent but not blocking.
**Answer**: **B** — Show quick-pick to select workspace. If `workspaceFolders.length > 1`, show a quick-pick letting the user choose which workspace root to configure. This is a single `showQuickPick` call — minimal complexity for meaningfully better UX. Silently using the first folder will confuse users who expect the command to operate on a different root.

---

### Q13: Existing Value Display When Updating
**Context**: US2 requires showing "current values (masked)" when the env file already exists. The spec doesn't define the masking format or how values are presented. For security, tokens should not be fully visible, but showing the last few characters helps users identify which token is configured. The VS Code input box supports `password: true` but that hides all input, and `prompt` text can show context.
**Question**: How should existing token values be displayed when the user re-runs the configure command?
**Options**:
- A) Last 4 characters: Show the prompt as "Current: ****abcd" (last 4 chars of existing value). Input box uses `password: true` for new entry. Standard pattern for token display.
- B) Prefix + last 4: Show "Current: ghp_****abcd" or "Current: sk-ant-****abcd" (known prefix + last 4 chars). More identifiable for users with multiple tokens.
- C) Length indicator only: Show "Current: [configured, 40 characters]" without revealing any part of the value. Most secure but least helpful for identification.
**Answer**: **B** — Prefix + last 4 characters. Show "Current: ghp_****abcd" or "Current: sk-ant-****abcd" (known prefix + last 4 chars). The known prefix helps users identify which token is configured (especially when they have multiple GitHub tokens). This is standard practice for token display and more useful than length-only without being less secure than last-4-only.

---

### Q14: GENERACY_API_KEY Validation
**Context**: FR-007 lists `GENERACY_API_KEY` as optional but doesn't specify any validation logic (unlike `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` which have detailed format checks and API calls). If the user enters a value, should it be validated? There's no corresponding CLI doctor check for this key, and the validation endpoint is not specified.
**Question**: Should the extension validate `GENERACY_API_KEY` if the user provides one, and if so, how?
**Options**:
- A) No validation: Accept any non-empty string. The key is optional and cloud features will validate it at runtime.
- B) Format validation only: Check for expected prefix/format if there is a known pattern (e.g., `gcy_` prefix). No API call.
- C) API validation: Call the Generacy cloud API (from `generacy.cloudEndpoint` setting) to validate the key. Requires specifying which endpoint to call.
**Answer**: **A** — No validation. Accept any non-empty string. There's no corresponding CLI doctor check, no known key format, and no specified validation endpoint. Runtime validation by the cloud API is sufficient. Adding format or API validation would require defining contracts that don't exist yet.
