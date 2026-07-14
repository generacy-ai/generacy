# Contract: `PostActivationRetryService.checkPostActivationState()`

## Signature (after this change)

```ts
class PostActivationRetryService {
  constructor(options: PostActivationRetryOptions);
  checkPostActivationState(): PostActivationState;
  triggerPostActivationRetry(): Promise<void>;
}

interface PostActivationRetryOptions {
  completionFlagPath?: string;
  keyFilePath?: string;
  wizardCredsPath?: string;               // NEW
  controlPlaneSocket?: string;
  controlPlaneWaitTimeout?: number;
  logger: FastifyBaseLogger;
  sendRelayEvent?: (channel: string, payload: unknown) => void;
}

interface PostActivationState {
  activated: boolean;
  postActivationComplete: boolean;
  needsRetry: boolean;
}
```

## Behavior — `checkPostActivationState()`

### Inputs
- `keyFilePath` — must exist for `activated: true`.
- `completionFlagPath` — must exist for `postActivationComplete: true`.
- `wizardCredsPath` — parsed line-by-line for a `GH_TOKEN=<non-empty>` entry.

### Truth table

| `activated` | `postActivationComplete` | `GH_TOKEN` sealed | `needsRetry` | Side effects |
|-------------|--------------------------|-------------------|--------------|--------------|
| false | * | * | false | none |
| true | true | * | false | none |
| true | false | true | **true** | none (retry fires in `runPostActivationBranch`) |
| true | false | false | **false** | `logger.info` + `sendRelayEvent('cluster.bootstrap', { status: 'deferred', reason: 'github-token-not-sealed' })` |

### `GH_TOKEN` sealed predicate

`sealed === true` iff `wizardCredsPath` contains at least one line matching:
```
GH_TOKEN=<value>
```
where `<value>.trim().length > 0`. Any of the following → `sealed === false`:
- File does not exist.
- File exists but no line begins with `GH_TOKEN=`.
- Line begins with `GH_TOKEN=` but the value after trim is the empty string.
- I/O error reading the file.

### Emission ordering

`checkPostActivationState()` is called once per boot inside `runPostActivationBranch`. When the defer case triggers, the side-effect emissions happen inside the same call, before the return.

Order:
1. `logger.info({ wizardCredsPath }, 'Post-activation retry deferred — GH_TOKEN not sealed in wizard-credentials.env')`
2. `sendRelayEvent('cluster.bootstrap', { status: 'deferred', reason: 'github-token-not-sealed' })`
3. `return { activated: true, postActivationComplete: false, needsRetry: false }`

### Failure modes

- No listener wired for `sendRelayEvent` (undefined callback) — silent (matches existing pattern).
- File I/O error — treat as `sealed: false`, defer path fires.
- Malformed lines (e.g. `foo` with no `=`) — skipped by the parser (matches FR-004 line-scan semantics).

## Backwards compatibility

- Constructor signature is additive (`wizardCredsPath?`). Existing callers that don't pass it get the env-var-derived default.
- `PostActivationState` shape unchanged.
- `triggerPostActivationRetry()` behavior unchanged when it is called (which is only when `needsRetry === true`, i.e. the token is sealed).

## Regression tests

| ID | Description |
|----|-------------|
| RT-001 | `keyFile` exists, `completionFlag` absent, `wizardCredsPath` absent → `needsRetry === false`; log + defer event emitted. |
| RT-002 | `keyFile` exists, `completionFlag` absent, `wizardCredsPath` contains `GH_TOKEN=ghs_valid_token` → `needsRetry === true`; no defer event. |
| RT-001b | Same as RT-001 but with `wizardCredsPath` file present containing `GH_TOKEN=` (empty value) → same as RT-001 (defer). |
| RT-001c | Same as RT-001 but with `wizardCredsPath` containing other keys but no `GH_TOKEN` → same as RT-001 (defer). |
