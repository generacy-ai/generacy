# Data Model: Thread projectId into activation URL

**Feature**: #616 | **Date**: 2026-05-14

## Entities

This feature introduces no new entities or types. It threads an existing value (`GENERACY_PROJECT_ID` env var) into an existing URL (`verification_uri`).

## Activation URL Shape

### Before
```
https://app.generacy.ai/cluster-activate
```
User must manually enter code AND select project.

### After (with projectId)
```
https://app.generacy.ai/cluster-activate?code=ABCD-1234&projectId=<uuid>
```
Page pre-selects project, code auto-filled.

### After (without projectId — graceful fallback)
```
https://app.generacy.ai/cluster-activate?code=ABCD-1234
```
Same as before but with code pre-filled.

## Environment Variables

| Variable | Source | Consumer | Status |
|----------|--------|----------|--------|
| `GENERACY_PROJECT_ID` | CLI scaffolder → `.generacy/.env` | Orchestrator `activate()` | Already written, newly read |

## Existing Types (unchanged)

### DeviceCodeResponse (activation-client)
```typescript
// packages/activation-client/src/types.ts
export const DeviceCodeResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  interval: z.number().int().positive(),
  expires_in: z.number().int().positive(),
});
```

No schema changes needed — `verification_uri` is consumed as input, and query params are appended locally.

## New Function Signature

```typescript
// packages/orchestrator/src/activation/index.ts
function buildActivationUrl(verificationUri: string, userCode: string): string
```

Pure function. Reads `process.env['GENERACY_PROJECT_ID']` internally. Returns a fully-formed URL string with `code` and optional `projectId` query params.
