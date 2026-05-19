# Quickstart: Verifying #531 Fix

## Run Tests

```bash
cd packages/generacy
pnpm test
```

Or run just the scaffolder tests:

```bash
cd packages/generacy
pnpm vitest run src/cli/commands/cluster/__tests__/scaffolder.test.ts
pnpm vitest run src/cli/commands/launch/__tests__/scaffolder.test.ts
pnpm vitest run tests/unit/deploy/scaffolder.test.ts
```

## Manual Verification

After building, run `generacy launch --claim=<code>` and inspect the generated `.generacy/docker-compose.yml`:

```bash
cat <project-dir>/.generacy/docker-compose.yml | grep -E 'DEPLOYMENT_MODE|CLUSTER_VARIANT'
```

Expected output:
```
- DEPLOYMENT_MODE=local
- CLUSTER_VARIANT=cluster-base
```

(or `CLUSTER_VARIANT=cluster-microservices` depending on the claim code's variant)

## Troubleshooting

| Issue | Fix |
|-------|-----|
| TypeScript compile error on `scaffoldDockerCompose` | Ensure `variant` is passed at all call sites |
| Test fails on deploy env var assertions | Deploy tests should expect `DEPLOYMENT_MODE=cloud` |
| `variant` type mismatch | Cast with `as 'cluster-base' \| 'cluster-microservices'` |
