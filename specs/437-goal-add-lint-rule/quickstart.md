# Quickstart: child_process Lint Rule (#437)

## What Changed

A single file is modified: `.eslintrc.json`. It adds a `no-restricted-imports` rule that forbids importing `child_process` / `node:child_process` outside explicitly allowed files.

## Verify the Rule Works

### 1. Lint passes on the current codebase

```bash
# Run lint across all packages (from repo root)
pnpm -r lint
```

All packages should pass. Every file that currently imports `child_process` is in the allow-list.

### 2. Verify the rule catches violations

Create a temporary test file:

```bash
cat > /tmp/test-lint-rule.ts << 'EOF'
import { spawn } from 'node:child_process';
spawn('echo', ['hello']);
EOF

cp /tmp/test-lint-rule.ts packages/orchestrator/src/test-lint-violation.ts
```

Run lint:

```bash
cd packages/orchestrator && pnpm lint
```

Expected output:
```
error  'node:child_process' import is restricted from being used.
       Direct child_process usage is forbidden. Use ProcessFactory or AgentLauncher instead. See #437.
       no-restricted-imports
```

Clean up:
```bash
rm packages/orchestrator/src/test-lint-violation.ts
```

### 3. Verify allow-listed files are exempt

```bash
# This should pass — file is in the allow-list
npx eslint packages/orchestrator/src/worker/claude-cli-worker.ts
```

## Adding a New File to the Allow-List

If a file legitimately needs `child_process` access:

1. Open `.eslintrc.json`
2. Find the first `overrides` entry (sanctioned + grandfathered files)
3. Add the file path to the `files` array
4. Include a clear justification in the PR description

## Removing a Grandfathered File

When migrating a grandfathered file to use `ProcessFactory`/`AgentLauncher`:

1. Remove the `child_process` import from the file
2. Remove the file path from the `overrides` array in `.eslintrc.json`
3. Run `pnpm lint` to confirm the file no longer needs the exemption

## Troubleshooting

**Lint fails on a file I didn't change**: The file imports `child_process` but isn't in the allow-list. Either migrate it to use `ProcessFactory`/`AgentLauncher`, or add it to the grandfathered list if migration is out of scope.

**IDE not showing the error**: Restart the ESLint server in your editor. In VS Code: Cmd/Ctrl+Shift+P → "ESLint: Restart ESLint Server".
