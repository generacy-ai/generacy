# Research: 5.3 — Environment Configuration Helper — Technical Decisions

## 1. Template Source Strategy (Q1)

### Decision: Embedded default + workspace file fallback (Option D)

**Context**: The canonical template at `packages/templates/src/shared/generacy.env.template.hbs` is a Handlebars file with conditional sections (`{{#if repos.isMultiRepo}}`) and interpolated values (`{{project.id}}`). The extension cannot render Handlebars without adding a dependency.

**Approach**:
1. **Workspace file preferred**: Look for `.generacy/generacy.env.template` (placed by `generacy init` from task 4.5). This file is a pre-rendered version with project-specific values already filled in.
2. **Embedded fallback**: Ship a static default template in the extension source code. This is a stripped-down version without Handlebars syntax — just the key structure with empty values and helpful comments.

**Why not import `@generacy/templates`**: Adding Handlebars as a runtime dependency increases bundle size (~50KB) and build complexity for a single file generation use case. The workspace file handles the happy path, and the embedded default handles edge cases.

**File lookup order**:
```
.generacy/generacy.env                    → exists? update flow
.generacy/generacy.env.template           → exists? copy and configure
.generacy/generacy.env.template.hbs       → skip (can't render)
<embedded default>                         → create and configure
```

---

## 2. Env File Parsing Strategy (Q2)

### Decision: Hybrid approach — dotenv for reading, regex for writing (Option C)

**Context**: The CLI uses `dotenv.parse()` for reading env files. However, `dotenv.parse()` discards comments, blank lines, and structural formatting. For updates, we need to preserve the file's human-readable structure.

**Read path** (for validation checks):
- For the `EnvConfigService` status check: simple regex scan for `^KEY=.+$` lines — no dotenv needed
- For the command handler: read raw content, use regex to extract current values for display

**Write path**:
- Read raw file content as a string
- For each key being updated, regex find `^KEY\s*=.*$` and replace with `KEY=value`
- If key line not found, append to the relevant section (or end of file)
- Write the modified string back

**Regex pattern**: `/^(GITHUB_TOKEN)\s*=.*$/m` (with `m` flag for multiline)

**Why not `dotenv` for the extension**:
- Avoids adding a dependency (the extension currently has zero npm runtime deps beyond vscode types)
- The read-side regex is trivial for status checking
- The write-side regex preserves comments/ordering (the actual requirement)

---

## 3. `gh auth token` Execution (Q3)

### Decision: `child_process.execFile` async with 5s timeout (Option A)

**Context**: The extension host is single-threaded. Blocking it with `execSync` would freeze the entire VS Code UI.

**Implementation**:
```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function getGhAuthToken(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      timeout: 5000,
      env: process.env,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
```

**Precedent**: `extension.ts:499` already uses this exact pattern for `gh issue view`.

**Error handling**: Any failure (gh not installed, not authenticated, timeout) silently returns `undefined`, and the flow falls back to manual token entry with a warning message.

---

## 4. Validation Recovery Flow (Q4)

### Decision: Per-failure QuickPick (Option C)

**UX flow on validation failure**:
```
[Error] GitHub token is invalid (HTTP 401)
┌─────────────────────────────┐
│ Re-enter value              │  ← loops back to input
│ Skip validation, keep value │  ← writes as-is
│ Cancel setup                │  ← aborts entire flow
└─────────────────────────────┘
```

This matches VS Code conventions (QuickPick for decisions) and avoids both:
- Mandatory retry loops (frustrating for users who know their token is temporarily invalid)
- Silently writing invalid values (confusing when Docker Compose fails later)

---

## 5. Validation Code Sharing (Q5)

### Decision: Duplicate with attribution (Option B)

**Validation logic to duplicate**:

| Source file | Lines | What it does |
|-------------|-------|-------------|
| `github-token.ts` | ~50 LOC | `fetch('api.github.com/user')`, check 401, check scopes |
| `anthropic-key.ts` | ~40 LOC | `fetch('api.anthropic.com/v1/models')`, check 401 |

**Total**: ~90 lines of straightforward HTTP validation logic.

**Why duplicate**:
- Extracting to a shared package (`@generacy/validation`) requires: new package dir, `package.json`, `tsconfig.json`, build config, dependency wiring in both CLI and extension
- The validation logic is stable (API contracts don't change)
- Attribution comment links to source for future consolidation

**When to extract**: If validation logic grows beyond 3 keys or diverges between CLI and extension.

---

## 6. Status Bar Design (Q7)

### Decision: Format validation on change, no API calls (Option B)

**States**:
| Status | Icon | Text | Color | Visibility |
|--------|------|------|-------|------------|
| `missing` | `$(warning)` | `Env: Missing` | `statusBarItem.warningBackground` | Shown |
| `incomplete` | `$(warning)` | `Env: Incomplete` | `statusBarItem.warningBackground` | Shown |
| `ok` | — | — | — | Hidden |

**Rationale for hiding on `ok`**: The `ProjectStatusBarProvider` (priority 98) already shows when a project is configured. Adding a green "Env: OK" next to it is noise. The status bar should only surface actionable information.

**Click action**: Opens `generacy.configureEnvironment` command (same as running from Command Palette).

**Validation trigger**: `FileSystemWatcher` on `.generacy/generacy.env` — same pattern as `ProjectConfigService`.

---

## 7. Network Error Handling (Q9)

### Decision: Distinguish network vs. auth errors (Option C)

**Classification**:
```typescript
function classifyError(error: unknown, response?: Response): 'auth' | 'network' {
  // HTTP 401 or 403 → 'auth' (definitive failure)
  if (response && (response.status === 401 || response.status === 403)) {
    return 'auth';
  }
  // Everything else (timeout, DNS, connection refused, 5xx) → 'network'
  return 'network';
}
```

**Behavior**:
- `auth` → trigger per-failure recovery flow (QuickPick: re-enter/skip/cancel)
- `network` → write token as-is, show warning: "Could not validate — network unavailable. Run again later."

This matches the CLI doctor check behavior where `AbortSignal.timeout(5_000)` failures are non-blocking.

---

## 8. Token Display Masking (Q13)

### Decision: Prefix + last 4 characters (Option B)

**Format examples**:
```
Current: ghp_****7f3a          (GitHub classic PAT)
Current: github_pat_****9x2b   (GitHub fine-grained PAT)
Current: sk-ant-****a4c1       (Anthropic key)
Current: ****k9f2              (unknown prefix)
```

**Implementation**:
```typescript
function maskToken(value: string): string {
  if (value.length <= 4) return '****';

  // Find known prefix
  const prefixes = ['ghp_', 'github_pat_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'sk-ant-'];
  for (const prefix of prefixes) {
    if (value.startsWith(prefix)) {
      return `${prefix}****${value.slice(-4)}`;
    }
  }

  return `****${value.slice(-4)}`;
}
```

---

## 9. Existing Codebase Patterns to Follow

### Command Registration
From `extension.ts:129-201`: Commands are defined as `{ id, handler }` pairs, wrapped with `withErrorHandling`, then registered in a loop with telemetry tracking.

### Singleton Services
From `ProjectConfigService`: Private constructor, static `instance`, `getInstance()`, `resetInstance()` for testing.

### FileSystemWatcher
From `ProjectConfigService:88-101`: Use `vscode.RelativePattern` with workspace folder, listen to `onDidCreate/Change/Delete`, push disposables.

### File I/O
From `ProjectConfigService:165-167`: Use `vscode.workspace.fs.readFile()`, decode with `Buffer.from(raw).toString('utf-8')`.

### Status Bar
From `ProjectStatusBarProvider:573-613`: `StatusBarAlignment.Left`, priority-based ordering, `show()/hide()` based on state, subscribe to service `onDidChange`.

### Error Handling
From `utils/errors.ts:277-289`: `withErrorHandling` wraps handlers, `GeneracyError.from()` converts unknown errors, `showError()` displays with action buttons.
