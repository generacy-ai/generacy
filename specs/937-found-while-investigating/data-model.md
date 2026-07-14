# Data Model

This fix is not a data-model change per se — no persistent schemas, no new stored entities. What follows documents the in-memory types and the wire shapes touched.

## PostActivationRetryOptions (modified)

`packages/orchestrator/src/services/post-activation-retry.ts`

```ts
export interface PostActivationRetryOptions {
  completionFlagPath?: string;
  keyFilePath?: string;
  // NEW in #937 — defaults to WIZARD_CREDS_PATH env var, then hard-coded path
  wizardCredsPath?: string;
  controlPlaneSocket?: string;
  controlPlaneWaitTimeout?: number;
  logger: FastifyBaseLogger;
  sendRelayEvent?: (channel: string, payload: unknown) => void;
}
```

- `wizardCredsPath` — optional. When omitted, resolved as `process.env.WIZARD_CREDS_PATH ?? '/var/lib/generacy/wizard-credentials.env'` at construction time. Mirrors the sibling `completionFlagPath` / `keyFilePath` test-seam pattern.
- Field stored in a private readonly property `wizardCredsPath: string`.

## PostActivationState (unchanged shape, changed semantics)

```ts
export interface PostActivationState {
  activated: boolean;              // apiKey file exists
  postActivationComplete: boolean; // completion flag exists
  needsRetry: boolean;             // NEW semantics: activated && !postActivationComplete && ghTokenSealed
}
```

`needsRetry`'s definition changes from `activated && !postActivationComplete` to `activated && !postActivationComplete && ghTokenSealed`. Shape unchanged so no consumer refactor needed.

## Internal predicate `ghTokenSealed(wizardCredsPath)`

Private helper on `PostActivationRetryService`:

```ts
private readGhToken(): { sealed: boolean; token?: string } {
  try {
    const raw = readFileSync(this.wizardCredsPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const idx = line.indexOf('=');
      if (idx < 0) continue;
      const key = line.slice(0, idx);
      if (key !== 'GH_TOKEN') continue;
      const value = line.slice(idx + 1).trim();
      return value.length > 0
        ? { sealed: true, token: value }
        : { sealed: false };
    }
    return { sealed: false };
  } catch {
    return { sealed: false };
  }
}
```

**Contract**:
- Missing file → `{ sealed: false }`
- Empty file → `{ sealed: false }`
- File exists but no `GH_TOKEN=` line → `{ sealed: false }`
- `GH_TOKEN=` with empty trimmed value → `{ sealed: false }`
- `GH_TOKEN=<any-non-empty-string>` → `{ sealed: true, token: <value> }`
- I/O error → `{ sealed: false }` (caught, non-throwing)

**Note**: only `sealed: boolean` is used by `checkPostActivationState()`. The `token?` field is not read by the current code but preserved for a potential future consumer without leaking the value out of the helper.

## Relay event: `cluster.bootstrap` deferred

Emitted from `PostActivationRetryService.checkPostActivationState()` when the fresh-cluster defer path triggers.

```ts
{
  status: 'deferred',
  reason: 'github-token-not-sealed',
}
```

- Channel: `cluster.bootstrap` (existing channel, routed IPC control-plane → orchestrator per #594/#598/#600).
- Cardinality: emitted at most once per activation-cycle boot (one-shot service).
- Cloud side: opaque — cloud dashboard renders the `cluster.bootstrap` channel as-is; specialized `deferred` treatment is out of scope for this PR (Out of Scope §4).

## Relay event: `cluster.bootstrap` awaiting-credentials (FR-006, new emit site)

Emitted from `packages/control-plane/src/routes/lifecycle.ts` in the `bootstrap-complete` branch when `hasGitHubToken === false`.

```ts
{
  status: 'awaiting-credentials',
  reason: 'github-token-not-sealed',
}
```

- Identical shape to the existing `prepare-workspace` defer event (`lifecycle.ts:151-154`).
- Emitted via `getRelayPushEvent()?.('cluster.bootstrap', …)`.
- **Distinct** from the FR-002 orchestrator-side defer event by `status` value (`awaiting-credentials` vs. `deferred`) — same `reason`.

## HTTP response: `POST /lifecycle/bootstrap-complete` (FR-006)

**Before**:
```ts
{ accepted: true, action: 'bootstrap-complete', sentinel: '/tmp/generacy-bootstrap-complete' }
```

**After (token present, unchanged)**:
```ts
{ accepted: true, action: 'bootstrap-complete', sentinel: '/tmp/generacy-bootstrap-complete' }
```

**After (token absent, new)**:
```ts
{ accepted: true, action: 'bootstrap-complete', sentinel: null }
```

Mirrors the `prepare-workspace` idiom exactly. No status-code change: still `200 OK`.

## Files touched (state, not schema)

| Path | Purpose | Written by | Read by |
|------|---------|-----------|---------|
| `/var/lib/generacy/wizard-credentials.env` | `KEY=VALUE\n`-format env file with rendered secret env vars | `writeWizardEnvFile` (control-plane) | `entrypoint-post-activation.sh`, **NEW**: `PostActivationRetryService` |
| `/var/lib/generacy/cluster-api-key` | Presence sentinel for `activated` | activation client | `PostActivationRetryService`, control-plane |
| `/var/lib/generacy/post-activation-complete` | Presence sentinel for `postActivationComplete` | `entrypoint-post-activation.sh` | `PostActivationRetryService` |
| `/tmp/generacy-bootstrap-complete` | Trigger sentinel for one-shot post-activation watcher | control-plane `bootstrap-complete`/`prepare-workspace` handlers | `post-activation-watcher.sh` |

None of these files are new; the fix adds one *reader* (of `wizard-credentials.env`) and adds one *conditional* (on `hasGitHubToken`) around one *writer* (of `/tmp/generacy-bootstrap-complete`).

## Env variables consulted

| Variable | Default | Used by |
|----------|---------|---------|
| `WIZARD_CREDS_PATH` | `/var/lib/generacy/wizard-credentials.env` | `PostActivationRetryService` **(NEW)** + existing control-plane handlers |
| `POST_ACTIVATION_TRIGGER` | `/tmp/generacy-bootstrap-complete` | control-plane `bootstrap-complete` + `prepare-workspace` (unchanged) |
| `AGENCY_DIR` | `/workspaces/.agency` | control-plane `writeWizardEnvFile` caller (unchanged) |

## Invariants

- **I1**: `checkPostActivationState()` never throws. All file-read errors caught and mapped to `sealed: false`.
- **I2**: `needsRetry === true` implies `activated && !postActivationComplete && ghTokenSealed`. The FR-002 log line + relay event fire only when the first two are true and `ghTokenSealed` is false.
- **I3**: Control-plane `bootstrap-complete` response `sentinel` field is `string` iff `hasGitHubToken === true`, else `null`. Consumers relying on `sentinel` as truthy already handle `null` via the `prepare-workspace` idiom.
- **I4**: The FR-002 defer event and FR-006 `awaiting-credentials` event share the same `reason` string (`github-token-not-sealed`) but differ in `status` (`deferred` vs. `awaiting-credentials`) — both are on `cluster.bootstrap`. Cloud-side consumers can dedupe or differentiate as needed; the shape is defensively distinct.
