# Contract: `classifyLabelProvisioningError`

**Location**: `packages/workflow-engine/src/actions/github/classify-label-provisioning-error.ts`
**Exported from**: `@generacy-ai/workflow-engine` (public API)

## Signature

```ts
export type ProvisioningErrorClassification =
  | { readonly kind: 'already-exists' }
  | {
      readonly kind: 'error';
      readonly cause: string;
      readonly statusCode?: number;
    };

export function classifyLabelProvisioningError(err: unknown): ProvisioningErrorClassification;
```

## Behavior

1. **Message extraction**: `const message = err instanceof Error ? err.message : String(err)`.
2. **Race detection**: if `/already[ _]exists/i.test(message)` → return `{ kind: 'already-exists' }`. Canonical race signal for both the `gh label create` CLI (stderr contains `already exists`) and the GitHub REST API (`errors[0].code === 'already_exists'`, surfaced in the 422 body message).
3. **HTTP status extraction**: if `message.match(/HTTP\s+(\d{3})/)` matches → capture the status as `statusCode: number`. Otherwise leave undefined.
4. **Cause extraction**: strip the leading `"Failed to create label <name>: "` prefix if present (added by both `gh-cli.ts:941` and `gh-cli.ts:1357` `createLabel` code paths). The remainder is the `cause` string. If the prefix is absent, the whole `message` is the `cause`.
5. **Return** `{ kind: 'error', cause, statusCode? }` for anything not matching the race pattern.

## Invariants

- **Deterministic**: given identical `err` input, returns identical output. No side effects, no I/O, no state.
- **Total function**: defined for every input (including `null`, `undefined`, non-`Error` primitives, and `Error` subclasses).
- **Race regex canonical**: matches both underscore (`already_exists`, REST API `errors[0].code`) and space (`already exists`, `gh` CLI stderr) forms, case-insensitively.
- **`statusCode` is best-effort**: absent when the error message did not contain `HTTP <NNN>`. Consumers must handle `undefined`.

## Non-goals

- Not a general HTTP-error parser. Only classifies label-provisioning failures for the two `createLabel` paths.
- Does not re-throw. Does not log. Consumers own logging and control flow.
- Does not distinguish between 401 vs 403 vs 5xx beyond exposing `statusCode`. All non-race outcomes collapse to `kind: 'error'`.

## Consumers

- `LabelManager.ensureRepoLabelsExist` (`packages/orchestrator/src/worker/label-manager.ts:333-345`) — race → `logger.debug` + continue; error → `logger.error` + lineage-map write + `hadNonRaceFailure = true`.
- `LabelSyncService.syncRepo` (`packages/orchestrator/src/services/label-sync-service.ts:69-107`) — race → `logger.info` + `unchanged++` + continue; error → `logger.error` + `hadError = true` + capture `firstError` + continue.

## Test surface

`packages/workflow-engine/src/actions/github/__tests__/classify-label-provisioning-error.test.ts`:

- `Error("label already exists")` → `{ kind: 'already-exists' }`.
- `Error("Failed to create label foo: label already_exists")` → `{ kind: 'already-exists' }`.
- `Error("HTTP 422: Validation Failed\ndescription is too long (maximum is 100 characters)")` → `{ kind: 'error', statusCode: 422, cause: matches /description is too long/ }`.
- `Error("HTTP 401: Bad credentials")` → `{ kind: 'error', statusCode: 401 }`.
- `Error("HTTP 403: Resource not accessible by integration")` → `{ kind: 'error', statusCode: 403 }`.
- `Error("HTTP 500: Internal Server Error")` → `{ kind: 'error', statusCode: 500 }`.
- `Error("Failed to create label foo: HTTP 422: ...")` → `{ kind: 'error', cause: matches ^HTTP 422 }` (prefix stripped).
- `String("gone")` → `{ kind: 'error', cause: 'gone' }` (non-Error input).
- `null` → `{ kind: 'error', cause: 'null' }`.
