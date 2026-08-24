# Data Model: activation options purity

Issue: [generacy-ai/generacy#1190](https://github.com/generacy-ai/generacy/issues/1190)

This bugfix has no persisted entities. The only "data model" change is the shape of the
internal options object passed to `runActivation`.

## `ActivateOptions` (modified)

File: `packages/generacy/src/cli/commands/deploy/activation.ts`

| Field | Type | Required | Change | Notes |
|-------|------|----------|--------|-------|
| `cloudUrl` | `string` | yes | unchanged | Cloud API base URL |
| `logger` | `ActivationLogger` | yes | unchanged | From `@generacy-ai/activation-client` |
| `projectId` | `string` | no | **NEW** | Threaded in by caller; replaces the internal `process.env['GENERACY_PROJECT_ID']` read. When `undefined`/empty, no `&projectId=` suffix is appended (unchanged URL semantics). |
| `maxCycles` | `number` | no | unchanged | Default `3` |
| `maxRetries` | `number` | no | unchanged | Passed to `initDeviceFlow` |

### Validation rules

- `projectId` is optional and free-form; `buildActivationUrl` only appends the query
  parameter when the value is **truthy** (existing `if (projectId)` guard). Empty string
  and `undefined` both produce the projectId-free URL.
- No new schema/Zod validation — this is an internal function options object, not a
  parsed config surface.

## `buildActivationUrl` (unchanged)

`(verificationUri: string, userCode: string, projectId?: string) => string`

Behavior byte-identical (NFR-001): sets `code=<userCode>`, and `projectId=<id>` iff
`projectId` is truthy.

## Ownership of the ambient read

| Location | Before | After |
|----------|--------|-------|
| `runActivation` (`activation.ts:52`) | reads `process.env['GENERACY_PROJECT_ID']` | reads `options.projectId` |
| `handleDeploy` (`index.ts:40`) | passes `{ cloudUrl, logger }` | passes `{ cloudUrl, logger, projectId: process.env['GENERACY_PROJECT_ID'] }` |

The composition root (`index.ts`) becomes the single owner of the ambient-environment
coupling.
