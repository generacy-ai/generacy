# Implementation Plan: Add Lint Rule Forbidding Direct child_process

**Feature**: Add ESLint rule forbidding direct `child_process` usage outside sanctioned files
**Branch**: `437-goal-add-lint-rule`
**Status**: Complete

## Summary

Add a root-level ESLint `no-restricted-imports` rule that forbids importing `child_process` / `node:child_process` across the entire monorepo. Sanctioned files and grandfathered files are exempted via ESLint `overrides` using file-path matching. No custom ESLint plugin required — this uses built-in ESLint functionality only.

## Technical Context

- **Language**: TypeScript
- **Linter**: ESLint 8.x (legacy `.eslintrc.json` config format)
- **Config location**: `/workspaces/generacy/.eslintrc.json`
- **Plugins**: `@typescript-eslint` (parser + recommended rules)
- **Monorepo**: pnpm workspaces, per-package `pnpm lint` scripts
- **No existing custom rules** — this is the first restricted-import rule

## Approach: Built-in `no-restricted-imports`

Use ESLint's built-in `no-restricted-imports` rule rather than a custom plugin:

1. **Root rule** — forbid `child_process` and `node:child_process` at error level
2. **Overrides** — disable the rule for sanctioned, grandfathered, and test files
3. **Error message** — points developers to `ProcessFactory` / `AgentLauncher`

This approach is zero-dependency, zero-custom-code, and aligns with the spec's requirement for file-path-based allow-listing (not inline `eslint-disable` comments).

## Project Structure

```
.eslintrc.json                          # MODIFY — add rule + overrides
specs/437-goal-add-lint-rule/
  spec.md                               # READ ONLY
  clarifications.md                     # READ ONLY
  plan.md                               # THIS FILE
  research.md                           # NEW — approach rationale
  quickstart.md                         # NEW — testing guide
```

Only **one file** is modified: `.eslintrc.json`.

## Allow-List

### Sanctioned (permanent — these ARE the ProcessFactory implementations)

| File | Reason |
|------|--------|
| `packages/orchestrator/src/worker/claude-cli-worker.ts` | `defaultProcessFactory` |
| `packages/orchestrator/src/conversation/process-factory.ts` | `conversationProcessFactory` |
| `packages/workflow-engine/src/actions/cli-utils.ts` | Fallback path for external consumers (per #430 Q3) |

### Grandfathered (not migrated by this refactor — TODO: migrate later)

| File | Import Used |
|------|-------------|
| `packages/orchestrator/src/services/relay-bridge.ts` | `execSync` |
| `packages/orchestrator/src/worker/repo-checkout.ts` | `execFile` |
| `packages/orchestrator/src/services/identity.ts` | `execFile` |
| `packages/cluster-relay/src/metadata.ts` | `execSync` |
| `packages/workflow-engine/src/actions/epic/create-pr.ts` | `execSync` |
| `packages/generacy/src/cli/commands/setup/services.ts` | `ChildProcess` |
| `packages/generacy/src/cli/utils/exec.ts` | `execSync`, `spawn` |
| `packages/generacy/src/agency/subprocess.ts` | `spawn` |
| `packages/generacy-extension/src/views/local/runner/actions/cli-utils.ts` | `execFile`, `spawn` |
| `packages/generacy-extension/src/commands/env.ts` | `execFile` |
| `packages/generacy-extension/src/commands/runner.ts` | `execFile` |

### Test files (allowed by glob)

- `**/__tests__/**`
- `**/tests/**`
- `**/*.test.ts`
- `**/*.spec.ts`

## Implementation Steps

### Step 1: Modify `.eslintrc.json`

Add `no-restricted-imports` to the `rules` section:

```json
"no-restricted-imports": ["error", {
  "paths": [
    {
      "name": "child_process",
      "message": "Direct child_process usage is forbidden. Use ProcessFactory or AgentLauncher instead. See #437."
    },
    {
      "name": "node:child_process",
      "message": "Direct child_process usage is forbidden. Use ProcessFactory or AgentLauncher instead. See #437."
    }
  ]
}]
```

### Step 2: Add overrides for allowed files

Add an `overrides` array with two entries:

1. **Sanctioned + grandfathered files** — explicitly listed paths, rule set to `"off"`
2. **Test files** — glob patterns, rule set to `"off"`

```json
"overrides": [
  {
    "files": [
      "packages/orchestrator/src/worker/claude-cli-worker.ts",
      "packages/orchestrator/src/conversation/process-factory.ts",
      "packages/workflow-engine/src/actions/cli-utils.ts",
      "packages/orchestrator/src/services/relay-bridge.ts",
      "packages/orchestrator/src/worker/repo-checkout.ts",
      "packages/orchestrator/src/services/identity.ts",
      "packages/cluster-relay/src/metadata.ts",
      "packages/workflow-engine/src/actions/epic/create-pr.ts",
      "packages/generacy/src/cli/commands/setup/services.ts",
      "packages/generacy/src/cli/utils/exec.ts",
      "packages/generacy/src/agency/subprocess.ts",
      "packages/generacy-extension/src/views/local/runner/actions/cli-utils.ts",
      "packages/generacy-extension/src/commands/env.ts",
      "packages/generacy-extension/src/commands/runner.ts"
    ],
    "rules": {
      "no-restricted-imports": "off"
    }
  },
  {
    "files": [
      "**/__tests__/**",
      "**/tests/**",
      "**/*.test.ts",
      "**/*.spec.ts"
    ],
    "rules": {
      "no-restricted-imports": "off"
    }
  }
]
```

### Step 3: Validate

1. Run `pnpm lint` across affected packages — must pass
2. Add a test file with `import { spawn } from 'child_process'` in an unlisted path — must fail
3. Remove test file

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Missed files — a non-listed file imports child_process | Discovery search found 3 extra files beyond clarifications list; all included |
| `require('child_process')` not caught | `no-restricted-imports` handles `import` only; codebase uses ESM imports exclusively |
| Future `no-restricted-imports` additions conflict with overrides | Overrides turn off the entire rule; acceptable since only child_process is restricted now. Refactor to selective override if more restrictions are added later |

## Constitution Check

No `.specify/memory/constitution.md` found — no governance constraints to verify against.
