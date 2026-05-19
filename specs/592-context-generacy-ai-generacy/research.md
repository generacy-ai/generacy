# Research: wizard-env-writer github-app token extraction

**Feature**: #592 | **Date**: 2026-05-12

## Problem Analysis

The `wizard-env-writer.ts` function `mapCredentialToEnvEntries` handles `github-app` and `github-pat` credential types identically — both write the raw `value` as `GH_TOKEN`. This worked when `value` was a plain token string, but cloud-side (generacy-cloud#547) is changing the `github-app` payload to a JSON object:

```json
{
  "installationId": 12345,
  "accountLogin": "my-org",
  "repositorySelection": "all",
  "token": "ghs_abc123...",
  "expiresAt": "2026-05-12T11:00:00Z"
}
```

Writing the raw JSON string as `GH_TOKEN` breaks `gh auth login` and `~/.git-credentials`.

## Payload Formats

### github-app (new format from generacy-cloud#547)
```typescript
// Stored via PUT /control-plane/credentials/:id
{ type: 'github-app', value: JSON.stringify({ installationId, token, ... }) }
```
The `token` field is a GitHub installation access token (`ghs_*`), minted by the cloud from the GitHub App's private key. It expires (typically 1 hour) but that's handled separately.

### github-app (old format, pre-cloud#547)
```typescript
// Stored via PUT /control-plane/credentials/:id
{ type: 'github-app', value: JSON.stringify({ installationId, accountLogin, ... }) }
```
No `token` field. The metadata was stored but no usable token was available at bootstrap time.

### github-pat
```typescript
// Stored via PUT /control-plane/credentials/:id
{ type: 'github-pat', value: 'ghp_...' }
```
Always a raw personal access token string. Never JSON.

## Solution Pattern

Standard defensive JSON extraction pattern:
1. `try { JSON.parse(value) }` — catches non-JSON values
2. Type-check extracted field (`typeof parsed.token === 'string'`)
3. Non-empty check (`parsed.token.length > 0`)
4. Return `[]` on any failure — fail-safe matches pre-#589 behavior

No new dependencies needed. No Zod validation warranted for a single field extraction in a write-once code path.

## Alternatives Considered

| Alternative | Rejected Because |
|------------|-----------------|
| Zod schema validation | Over-engineering for single field extraction; adds import for no safety gain |
| Falling back to raw value on parse failure | Could write garbage JSON as GH_TOKEN — worse than skipping |
| Unified parser for all credential types | Premature abstraction; only github-app has structured values today |
| Storing extracted token separately in credentials.yaml | Scope creep; the env-writer is the right extraction point |
