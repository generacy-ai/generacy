# Quickstart: Launch scaffolder writes `GENERACY_BOOTSTRAP_MODE=wizard`

## What Changed

After this feature, every `.env` file scaffolded by `npx generacy launch` or `generacy deploy` includes:

```env
GENERACY_BOOTSTRAP_MODE=wizard
```

This tells the cluster-base entrypoint scripts to defer repo cloning until the bootstrap wizard provides credentials.

## Verification

After running `npx generacy launch --claim=<code>`:

```bash
grep GENERACY_BOOTSTRAP_MODE ~/Generacy/<project>/.generacy/.env
# Expected: GENERACY_BOOTSTRAP_MODE=wizard
```

## Running Tests

```bash
cd packages/generacy
pnpm test -- src/cli/commands/cluster/__tests__/scaffolder.test.ts
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Env var missing from `.env` | Old CLI version | Update `@generacy-ai/generacy` package |
| Cluster still clones on boot | cluster-base image doesn't read the var yet | Ensure cluster-base#20 is deployed |
| Env var has wrong name | cluster-base#20 chose a different name | Check cluster-base#20 for canonical name |
