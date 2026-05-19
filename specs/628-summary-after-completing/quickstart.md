# Quickstart: Wizard-env-writer GH_USERNAME / GH_EMAIL

## Run Tests

```bash
# Run wizard-env-writer tests only
cd /workspaces/generacy
pnpm --filter @generacy-ai/control-plane test -- --run __tests__/services/wizard-env-writer.test.ts

# Run all control-plane tests
pnpm --filter @generacy-ai/control-plane test
```

## Verify the Change

### Unit test verification

After implementation, these test cases should pass:

1. `github-app with accountLogin` returns 3 entries: `GH_TOKEN`, `GH_USERNAME`, `GH_EMAIL`
2. `github-app without accountLogin` returns 1 entry: `GH_TOKEN` only
3. `github-app with empty accountLogin` returns 1 entry: `GH_TOKEN` only
4. All existing tests continue to pass (SC-003)

### Manual verification (in a running cluster)

```bash
# After bootstrap-complete, check the env file
cat /var/lib/generacy/wizard-credentials.env
# Expected: GH_TOKEN=..., GH_USERNAME=..., GH_EMAIL=...

# Check git identity was configured by setup-credentials.sh
git config --get user.name   # Should return the accountLogin value
git config --get user.email  # Should return <login>@users.noreply.github.com
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `GH_USERNAME` missing from env file | Cloud payload lacks `accountLogin` | Check cloud wizard sends `accountLogin` in github-app credential |
| Git identity not set despite env vars | `setup-credentials.sh` not sourcing env file | Check cluster-base entrypoint runs `source $WIZARD_CREDS` |
| Test failures on existing tests | Accidental change to return shape | Ensure `accountLogin` extraction is additive, not replacing |
