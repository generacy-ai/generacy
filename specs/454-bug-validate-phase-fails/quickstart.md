# Quickstart: Validate phase fix

## What changed

The default `preValidateCommand` now builds workspace packages before validation:

```
pnpm install && pnpm -r --filter ./packages/* build
```

## Verify the fix

```bash
# Run unit tests
cd packages/orchestrator && pnpm test

# Check the default value programmatically
node -e "
  import('./dist/worker/config.js').then(m => {
    const c = m.WorkerConfigSchema.parse({});
    console.log('preValidateCommand:', c.preValidateCommand);
  });
"
```

## Manual end-to-end test

```bash
# 1. Restart a worker to clear dist/ directories
docker restart tetrad-development-worker-3

# 2. Trigger validation on any issue with the right labels
# 3. Observe exit code 0 instead of exit code 2
```

## Override behavior

To use a custom pre-validate command, set `preValidateCommand` in worker config:

```yaml
# worker config
preValidateCommand: "npm ci"          # custom — won't use the new default
preValidateCommand: ""                # empty string — skips pre-validate entirely
```
