# Quickstart: Wizard Credentials Env Bridge

## What Changed

The `bootstrap-complete` lifecycle action now unseals wizard-stored credentials and writes them as environment variables to `/var/lib/generacy/wizard-credentials.env` before triggering post-activation.

## Files Modified

| File | Change |
|---|---|
| `packages/control-plane/src/services/wizard-env-writer.ts` | NEW — unseals credentials, maps to env vars, writes env file |
| `packages/control-plane/src/routes/lifecycle.ts` | MODIFIED — calls `writeWizardEnvFile()` before sentinel write |
| `packages/control-plane/__tests__/services/wizard-env-writer.test.ts` | NEW — unit tests |
| `packages/control-plane/__tests__/routes/lifecycle.test.ts` | MODIFIED — integration tests |

## Testing

```bash
# Run control-plane tests
cd packages/control-plane
pnpm test

# Run specific test file
pnpm test -- wizard-env-writer

# Run lifecycle tests
pnpm test -- lifecycle
```

## How It Works

1. Cloud wizard stores credentials via `PUT /control-plane/credentials/:id`
2. User clicks "Complete" → cloud sends `POST /control-plane/lifecycle/bootstrap-complete`
3. Handler reads `.agency/credentials.yaml` to get credential IDs and types
4. For each credential, unseals via `ClusterLocalBackend.fetchSecret()`
5. Maps `(id, type)` → env var name (e.g., `github-app` → `GH_TOKEN`)
6. Writes all entries to `/var/lib/generacy/wizard-credentials.env` (mode 0600)
7. Writes sentinel file → post-activation watcher triggers
8. `entrypoint-post-activation.sh` sources the env file → `setup-credentials.sh` finds `GH_TOKEN`

## Adding New Credential Mappings

Edit `packages/control-plane/src/services/wizard-env-writer.ts`:

```typescript
// Add type-based mapping
const TYPE_MAPPINGS: Record<string, string> = {
  'github-app': 'GH_TOKEN',
  'github-pat': 'GH_TOKEN',
  'new-type': 'NEW_ENV_VAR',  // ← add here
};

// Or add ID-pattern mapping
const ID_PATTERNS: Array<{ pattern: RegExp; envVar: string }> = [
  { pattern: /anthropic/, envVar: 'ANTHROPIC_API_KEY' },
  { pattern: /my-service/, envVar: 'MY_SERVICE_KEY' },  // ← add here
];
```

## Companion PR Required

The cluster-base repo needs a companion change to source the env file:

```bash
# In entrypoint-post-activation.sh (cluster-base repo)
WIZARD_CREDS=/var/lib/generacy/wizard-credentials.env
if [ -f "$WIZARD_CREDS" ]; then
  set -a; source "$WIZARD_CREDS"; set +a
  rm -f "$WIZARD_CREDS"  # one-shot: delete after consuming
fi
```

## Troubleshooting

**Env file not created**: Check that credentials were stored before `bootstrap-complete` fired. Verify with `docker exec <container> cat /workspaces/.agency/credentials.yaml`.

**Partial env file**: Check control-plane logs for `credential-unseal-partial` warning. A credential may have failed to unseal (corrupt data or master key issue).

**GH_TOKEN still empty**: Ensure the cluster-base companion PR is deployed. The env file exists but must be sourced by `entrypoint-post-activation.sh`.
