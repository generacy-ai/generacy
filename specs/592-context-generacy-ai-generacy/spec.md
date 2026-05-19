# Feature Specification: wizard-env-writer: extract `token` from github-app JSON value

**Branch**: `592-context-generacy-ai-generacy` | **Date**: 2026-05-12 | **Status**: Draft

## Summary

The `wizard-env-writer.ts` currently treats the `value` field for `github-app` credentials as a raw token string, but generacy-cloud#547 is changing the payload to a JSON object containing `{ token, installationId, accountLogin, ... }`. This fix parses the JSON and extracts the `token` field for `github-app` credentials, while keeping the raw-value treatment for `github-pat`. If the token field is absent or the value is unparseable, `GH_TOKEN` is skipped entirely (no regression — matches pre-#589 behavior).

## Context

Cloud-side (generacy-cloud#547) is adding a fresh installation access token to the wizard's `PUT /control-plane/credentials/:id` payload for `github-app` credentials. The new payload shape:

```typescript
{
  type: 'github-app',
  value: JSON.stringify({
    installationId, accountLogin, repositorySelection,
    token: 'ghs_<minted-by-cloud>',
    expiresAt: '<iso-timestamp>',
  }),
}
```

The current code at `packages/control-plane/src/services/wizard-env-writer.ts:37-38` writes the raw JSON string as `GH_TOKEN`, which breaks `gh auth login` and mangles `~/.git-credentials`.

## User Stories

### US1: Cluster bootstraps with working GitHub credentials

**As a** cluster operator using GitHub App integration,
**I want** the bootstrap wizard's stored credentials to be correctly extracted as a usable token,
**So that** post-activation `git clone` against private repos succeeds without manual intervention.

**Acceptance Criteria**:
- [ ] `github-app` credential values are JSON-parsed and the `token` field is extracted
- [ ] If `token` is missing or value is unparseable, `GH_TOKEN` is omitted (not set to garbage)
- [ ] `github-pat` credentials continue to use the raw value as `GH_TOKEN`

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Split `github-app` and `github-pat` into separate branches in `mapCredentialToEnvEntries` | P1 | Currently combined with `\|\|` |
| FR-002 | `github-app` branch: JSON.parse the value, extract `parsed.token` if it's a non-empty string | P1 | |
| FR-003 | `github-app` branch: return `[]` on parse failure or missing/empty token (never fall back to raw value) | P1 | Fail-safe: skip > corrupt |
| FR-004 | `github-pat` branch: keep existing raw-value behavior unchanged | P1 | PATs are directly usable tokens |

## Fix

In `packages/control-plane/src/services/wizard-env-writer.ts`:

```diff
- if (type === 'github-app' || type === 'github-pat') {
-   return [{ key: 'GH_TOKEN', value }];
- }
+ if (type === 'github-app') {
+   try {
+     const parsed = JSON.parse(value) as { token?: unknown };
+     if (typeof parsed.token === 'string' && parsed.token.length > 0) {
+       return [{ key: 'GH_TOKEN', value: parsed.token }];
+     }
+   } catch {
+     // fall through — old payload was JSON metadata, no token to extract
+   }
+   return []; // skip writing GH_TOKEN; do NOT fall back to raw value
+ }
+ if (type === 'github-pat') {
+   return [{ key: 'GH_TOKEN', value }];
+ }
```

## Deploy ordering safety

This is safe to ship before the cloud companion (generacy-cloud#547):
1. Today's cloud sends old payload (no `token` field) → JSON.parse succeeds, `parsed.token` is `undefined` → returns `[]` → env file written without `GH_TOKEN` → `setup-credentials.sh` logs existing warning
2. Net behavior matches pre-#589 (no regression)
3. When cloud#547 ships, `token` field is present → extracted correctly → `GH_TOKEN` is set

## Test Plan

- [ ] Unit: `mapCredentialToEnvEntries('github-main-org', 'github-app', '{"installationId":1,"token":"ghs_abc"}')` returns `[{ key: 'GH_TOKEN', value: 'ghs_abc' }]`
- [ ] Unit: `mapCredentialToEnvEntries('github-main-org', 'github-app', '{"installationId":1}')` (no `token` field) returns `[]`
- [ ] Unit: `mapCredentialToEnvEntries('github-main-org', 'github-app', 'not-json')` returns `[]`
- [ ] Unit: `mapCredentialToEnvEntries('some-pat', 'github-pat', 'ghp_xyz')` returns `[{ key: 'GH_TOKEN', value: 'ghp_xyz' }]`
- [ ] Integration: After full chain ships (this + generacy-cloud#547 + cluster-base#28): post-activation `git clone` against a private repo succeeds

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `github-app` token extraction | Correct `ghs_*` token written as `GH_TOKEN` | Unit tests pass |
| SC-002 | Backward compatibility | No regression when cloud sends old payload (no `token` field) | `GH_TOKEN` is omitted, not set to garbage |
| SC-003 | `github-pat` unchanged | Raw value still written as `GH_TOKEN` | Unit test passes |

## Assumptions

- Cloud-side payload for `github-app` is valid JSON (both old and new format)
- The `token` field, when present, is a GitHub installation access token (`ghs_*`) that is directly usable for git operations
- `github-pat` will never receive a JSON payload (PATs are always raw strings)

## Out of Scope

- Token refresh/rotation (installation tokens expire; handled separately)
- Adding wizard UI for `github-pat` credentials
- Cache coherence for credhelper-daemon after credential updates

## Related

- generacy-ai/generacy-cloud#547 (cloud-side mint + expanded payload)
- generacy-ai/cluster-base#28 (post-activation script sources the env file)
- generacy-ai/generacy#591 (merged #589 — the writer this updates)

---

*Generated by speckit*
