# Contract: Lifecycle handler skip responses

Two lifecycle-handler behavior deltas when `postActivationReady === false`.

## `POST /lifecycle/vscode-tunnel-start`

### Existing behavior (unchanged when settled)

```
201  200 OK
     { "status": "starting", "tunnelName": "g-<id>" }
     (or whatever `tunnelManager.start()` returns today — response body unchanged from current implementation)
```

### New behavior (when `postActivationReady === false`)

```
     200 OK
     {
       "accepted": false,
       "action": "vscode-tunnel-start",
       "deferred": false,
       "reason": "post-activation-not-settled",
       "message": "Cluster is still starting up; retry once postActivationReady is true"
     }
```

### Contract rules

- HTTP status: **200 OK**. Not 409. Not 503. (See Q4/A rationale — `ControlPlaneError` has no CONFLICT variant.)
- **No** `tunnelManager.start()` call. **No** device-code auth is initiated. **No** watcher is installed.
- **No** `cluster.vscode-tunnel` relay event is emitted (the request never reached the tunnel manager; no tunnel state changed).
- Log line at info level: `Skipped vscode-tunnel-start: cluster pre-restart (postActivationReady=false)` with structured fields for `{ actor, markerPath, activated }`.
- Idempotent — repeated calls all return the same shape; no accumulated state.

### Consumer expectations

- Cloud/UI (companion `generacy-cloud` PR) is the primary user of this endpoint and gates the button on the metadata bit (FR-006), so this response should be rare in normal use.
- When the response IS received (e.g. UI race, direct API call), the caller MUST NOT retry until `postActivationReady === true` on cluster metadata. There is no server-side queue.

---

## `POST /lifecycle/bootstrap-complete`

### Existing behavior (unchanged when settled OR when `!hasGitHubToken`)

Response body shape is unchanged in all cases:

```
     200 OK
     {
       "accepted": true,
       "action": "bootstrap-complete",
       "sentinel": "/tmp/generacy-bootstrap-complete" | null
     }
```

### New behavior delta (when `postActivationReady === false && hasGitHubToken === true`)

Sub-actions executed:

| Step | Description | Pre-fix | Post-fix (not settled) |
|---|---|:---:|:---:|
| (a) | `writeWizardEnvFile()` | ✓ | ✓ |
| (b) | Write `POST_ACTIVATION_TRIGGER` sentinel | ✓ | ✓ |
| (c) | `codeServerManager.start()` (fire-and-forget) | ✓ | ✓ |
| (d) | `tunnelManager.start()` (await) | ✓ | **skipped** — log line only |

### Contract rules

- HTTP status: **200 OK**. Response body: **unchanged** from today (`{ accepted: true, action: 'bootstrap-complete', sentinel }`).
- Step (d) skip is a server-internal decision. Observability is via:
  1. Info-level log line: `Skipped tunnelManager.start() in bootstrap-complete: cluster pre-restart (postActivationReady=false)`.
  2. The `postActivationReady === false` bit on next metadata report (cloud can correlate).
  3. Post-restart `BootResumeService` dispatches `vscode-tunnel-start` unconditionally, giving the tunnel a clean start in the fresh orchestrator process.
- Steps (a), (b), (c) MUST fire regardless of the gate — deferring (a) or (b) would deadlock the cluster because they are what causes the post-activation restart (and therefore the marker) to eventually happen. (See spec Q6/D rationale.)
- No new `cluster.bootstrap` relay event is required for this skip — the existing `awaiting-credentials` event (emitted when `!hasGitHubToken`) is the only handler-emitted relay signal today; the settled skip follows the same log-only convention as the existing "step d best-effort try/catch swallows error" behavior at L199-204.

### Consumer expectations

- Caller (cloud) does not need to change — the response is unchanged.
- The tunnel start is not lost — `BootResumeService` will dispatch it after the self-restart completes (confirmed working today per snappoll orchestrator logs at 15:53:30, ~4s post-restart).

---

## Error paths (both handlers)

Unchanged. Errors from `tunnelManager.start()` (when it does run) continue to surface as `ControlPlaneError('SERVICE_UNAVAILABLE', ...)` per today's code path.

The `isPostActivationSettledSync()` call itself is infallible (returns `boolean`, catches nothing internally — `existsSync` does not throw for permission errors; it returns `false`). No new error variants.

## Backwards compatibility

- No new error codes.
- `vscode-tunnel-start` skip response is a **new** JSON shape on this endpoint. Existing callers that treat any 200 as success will interpret `accepted: false` as success (undesirable but not catastrophic — the failure surfaces as a subsequent metadata push showing `postActivationReady: false`, and the user retries). New callers key off `accepted: boolean` per convention.
- `bootstrap-complete` response is unchanged — full backwards compatibility.
