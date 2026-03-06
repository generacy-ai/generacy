# Quickstart: Pre-Validate Dependency Installation

## What Changed

The orchestrator now runs `pnpm install` before executing the validate command (`pnpm test && pnpm build`). This ensures dependencies exist in fresh clones.

## Default Behavior

No configuration needed. The default `preValidateCommand` is `pnpm install`, which runs automatically before the validate phase.

## Custom Configuration

Override the install command in your orchestrator config:

```yaml
worker:
  preValidateCommand: "npm ci"           # Use npm instead
  # preValidateCommand: ""               # Disable pre-validate install
  validateCommand: "pnpm test && pnpm build"
```

## Verifying the Fix

1. Start the orchestrator with a workflow that reaches the validate phase
2. Check worker logs for the pre-validate install step:
   ```
   Spawning pre-validate install command
   Pre-validate install completed successfully
   Spawning validation command
   ```
3. The validate phase should now succeed instead of failing with "vitest not found"

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Install times out (>5 min) | Slow network or large dependency tree | Check network; consider using `--prefer-offline` |
| Install fails with permissions | Checkout directory permissions | Check workspace directory permissions |
| Install succeeds but validate still fails | Wrong install command for the project | Set `preValidateCommand` to match your project's package manager |
