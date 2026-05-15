# Research: Wizard-env-writer GH_USERNAME / GH_EMAIL

## GitHub Noreply Email Format

GitHub provides two noreply email forms:

1. **Legacy**: `<username>@users.noreply.github.com`
2. **ID-prefixed**: `<numeric-id>+<username>@users.noreply.github.com`

The legacy form works for commit attribution as long as the user hasn't enabled "Keep my email address private" with the ID-prefixed requirement. For initial release, the legacy form is sufficient — the spec explicitly defers the ID-prefixed form.

**Decision**: Use legacy form. Follow-up issue for ID-prefixed if attribution issues reported.

## Credential Payload Shape

The `github-app` credential value stored by the cloud wizard is a JSON object:

```json
{
  "installationId": 12345,
  "token": "ghs_xxxx",
  "accountLogin": "my-org",
  "expiresAt": "2026-05-15T12:00:00Z"
}
```

The `accountLogin` field corresponds to the GitHub App installation's account — the org or user the user selected during the wizard. This is the most semantically correct source for git identity in the cluster context.

**Decision**: Extract `accountLogin` from the same parsed JSON object already used for `token` extraction.

## Alternatives Considered

### Alternative 1: Separate API call to resolve username
Rejected — adds latency, network dependency, and a new failure mode to the bootstrap path. The data is already in the credential payload.

### Alternative 2: Use `gh api /user` inside the cluster
Rejected — requires `GH_TOKEN` to be available first, adds runtime dependency on `gh` CLI, and races with credential availability.

### Alternative 3: Store username in a separate credential entry
Rejected — over-engineering for a single field. The `accountLogin` is metadata about the GitHub App installation, logically part of the same credential.

## Implementation Pattern

The existing `mapCredentialToEnvEntries` function uses a simple if/else chain with early returns. The change fits naturally into the existing `github-app` branch by adding two more entries to the returned array when `accountLogin` is available.

Pattern: conditional array spread or post-push after the `token` extraction succeeds.

```typescript
// Pseudocode
const entries: EnvEntry[] = [{ key: 'GH_TOKEN', value: parsed.token }];
if (typeof parsed.accountLogin === 'string' && parsed.accountLogin.length > 0) {
  entries.push(
    { key: 'GH_USERNAME', value: parsed.accountLogin },
    { key: 'GH_EMAIL', value: `${parsed.accountLogin}@users.noreply.github.com` },
  );
}
return entries;
```

This preserves the existing fail-safe behavior: if JSON parsing fails entirely, no entries are emitted. If `token` is missing, no entries are emitted (including no username/email). If only `accountLogin` is missing, `GH_TOKEN` is still emitted.

## Key References

- Source: `packages/control-plane/src/services/wizard-env-writer.ts:37-47`
- Tests: `packages/control-plane/__tests__/services/wizard-env-writer.test.ts`
- Consumer: `setup-credentials.sh` in cluster-base image (reads `GH_USERNAME`, `GH_EMAIL`)
- Cloud credential writer: sends `accountLogin` in github-app credential payload
- PR #592: Last modification to `mapCredentialToEnvEntries` (github-app JSON parsing)
