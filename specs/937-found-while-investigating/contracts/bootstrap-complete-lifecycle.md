# Contract: `POST /lifecycle/bootstrap-complete` (control-plane)

## Endpoint
`POST /lifecycle/bootstrap-complete` — served by `packages/control-plane/src/routes/lifecycle.ts`.

## Request

No body required. `Content-Type: application/json` if body is sent (existing behavior; body is ignored).

Headers (existing):
- `x-generacy-actor-user-id` — required (per `requireActor` middleware).
- `x-generacy-actor-session-id` — required.

## Behavior after this change

1. Unseal wizard credentials via `writeWizardEnvFile({ agencyDir, envFilePath })`. Receive `{ written, failed, hasGitHubToken }`.
2. If `envResult.failed.length > 0` — emit `cluster.bootstrap` warning event (existing behavior, unchanged).
3. **NEW**: branch on `hasGitHubToken`:
   - `true` (existing path, unchanged): write the sentinel at `POST_ACTIVATION_TRIGGER`, start code-server fire-and-forget, start VS Code tunnel best-effort. Response `sentinel` field = string path.
   - `false` (new path): skip sentinel + code-server + tunnel. Emit `cluster.bootstrap` `{ status: 'awaiting-credentials', reason: 'github-token-not-sealed' }`. Response `sentinel` field = `null`.
4. `res.writeHead(200)`; end with the response body.

## Response

Always `200 OK`, `Content-Type: application/json`.

**Body (token present, unchanged)**:
```json
{
  "accepted": true,
  "action": "bootstrap-complete",
  "sentinel": "/tmp/generacy-bootstrap-complete"
}
```

**Body (token absent, new)**:
```json
{
  "accepted": true,
  "action": "bootstrap-complete",
  "sentinel": null
}
```

## Idempotency

- Multiple `bootstrap-complete` calls with token present → sentinel overwritten (existing `flag: 'w'` semantics). Idempotent.
- `bootstrap-complete` (token absent) followed by `bootstrap-complete` (token present) → second call writes the sentinel. Fully compatible with the wizard's two-phase call pattern (`prepare-workspace` early → `bootstrap-complete` at end of wizard).
- `bootstrap-complete` (token present) followed by `bootstrap-complete` (token absent) — should be impossible in practice (creds don't un-seal); if it happens, the token-absent branch DOES emit `awaiting-credentials` but does NOT remove the previously-written sentinel. Defensible because clearing the sentinel could re-arm a clone that already succeeded.

## Failure modes

- `writeWizardEnvFile` throws — caught, non-fatal (existing behavior). Falls through to the sentinel branch with `hasGitHubToken = false` (default value at the top of the handler). New behavior: `hasGitHubToken === false` → defer branch → no sentinel + `awaiting-credentials` event. Improves on existing behavior which would have written the sentinel with no creds.
- `writeFile(sentinel, …)` throws — propagates as a 5xx (existing behavior on the token-present branch).
- Code-server / tunnel start errors — swallowed on the token-present branch (existing behavior). Not attempted on the token-absent branch.

## Regression test (RT-004)

Mirrors `prepare-workspace` defer test at `packages/control-plane/__tests__/routes/lifecycle.test.ts:472-482`.

**Scenario**: `writeWizardEnvFile` mocked to return `{ written: [], failed: [], hasGitHubToken: false }`; `POST_ACTIVATION_TRIGGER` pointed at a temp path.

**Assertions**:
- Response body: `{ accepted: true, action: 'bootstrap-complete', sentinel: null }`.
- Sentinel file at `POST_ACTIVATION_TRIGGER` MUST NOT exist after the call.
- `getRelayPushEvent()`-registered callback called with `('cluster.bootstrap', { status: 'awaiting-credentials', reason: 'github-token-not-sealed' })`.
- `codeServerManager.start` NOT called.
- `vscodeTunnelManager.start` NOT called.

## Existing test scope adjustments

Several existing `bootstrap-complete` tests set `hasGitHubToken: false` in the `writeWizardEnvFile` mock (e.g. `lifecycle.test.ts:240, 357, 409`) but assert the sentinel IS written. Under the new contract, those tests must switch their mock to `hasGitHubToken: true` for the happy-path assertions, or migrate to assert the new defer-branch shape. Documented explicitly in the tasks phase.
