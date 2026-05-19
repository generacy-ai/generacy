# Quickstart: Verify #592 fix

## Run Unit Tests

```bash
cd /workspaces/generacy
pnpm --filter @generacy-ai/control-plane exec vitest run __tests__/services/wizard-env-writer.test.ts
```

## Expected Test Results

All tests in `wizard-env-writer.test.ts` should pass, including:

- `mapCredentialToEnvEntries` with `github-app` JSON value extracts `token` field
- `mapCredentialToEnvEntries` with `github-app` missing `token` returns `[]`
- `mapCredentialToEnvEntries` with `github-app` unparseable value returns `[]`
- `mapCredentialToEnvEntries` with `github-pat` raw value returns `GH_TOKEN` directly
- Integration: `writeWizardEnvFile` happy path writes extracted token to env file

## Manual Verification

After deploying with cloud companion (generacy-cloud#547):

1. Start a cluster with GitHub App integration
2. Complete the bootstrap wizard (cloud stores `github-app` credential with `token` field)
3. Verify `bootstrap-complete` lifecycle action writes correct env file:
   ```bash
   docker exec <orchestrator> cat /var/lib/generacy/wizard-credentials.env
   # Should contain: GH_TOKEN=ghs_<actual-token>
   # Should NOT contain JSON
   ```
4. Verify post-activation git clone succeeds against a private repo
