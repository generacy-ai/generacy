# Contract: `GhCliGitHubClient.resolveTokenEnv` env-override invariant

**File**: `packages/workflow-engine/src/actions/github/client/gh-cli.ts`
**Change kind**: tighten an existing invariant; backwards-compatible for the no-provider case.

## Before

```ts
private async resolveTokenEnv(): Promise<Record<string, string> | undefined> {
  if (!this.tokenProvider) return undefined;
  const token = await this.tokenProvider();
  return token ? { GH_TOKEN: token } : undefined;
}
```

Failure mode: if `this.tokenProvider` is set but returns `''`, the method returns `undefined`, `executeCommand('gh', …)` is spawned with no env override, and the subprocess inherits the orchestrator's ambient `GH_TOKEN` (the static expired wizard token). Silent fallback.

## After

```ts
private async resolveTokenEnv(): Promise<Record<string, string> | undefined> {
  if (!this.tokenProvider) return undefined;
  // Invariant: when a tokenProvider is configured, the env override ALWAYS
  // carries a GH_TOKEN key — never undefined. This prevents the gh subprocess
  // from inheriting the orchestrator's ambient GH_TOKEN (which, on wizard
  // clusters, is the expired static token from wizard-credentials.env).
  // If the provider throws JitTokenError, the throw propagates and the caller's
  // loop-boundary catch records the failure and skips the gh call (see
  // LabelMonitorService/PrFeedbackMonitorService catch branches).
  const token = await this.tokenProvider();
  return { GH_TOKEN: token ?? '' };
}
```

## Invariants

1. **Provider present ⇒ `GH_TOKEN` always set in env override**. The env-override object is returned with a `GH_TOKEN` key whenever `this.tokenProvider` is configured. Ambient inheritance from `process.env.GH_TOKEN` is structurally impossible on this code path.
2. **Provider throws ⇒ env-override never constructed**. The throw propagates to `executeGh`, which propagates to the caller. No `executeCommand('gh', …)` call occurs on the failure path.
3. **No provider ⇒ behavior unchanged**. Returns `undefined`; the gh subprocess inherits ambient env (legacy behavior for truly-unconfigured clusters).
4. **Empty token ⇒ `GH_TOKEN: ''`** rather than falling through. `gh` will fail loudly with a "no auth" error rather than silently using ambient. Defense-in-depth — the provider should never return an empty string in practice (it either returns a non-empty token or throws), but if it ever does the failure is loud, not silent.

## Caller obligations (loop-boundary catch)

Callers that already catch `GhAuthError` at their poll loop boundary (per #762) MUST also catch `JitTokenError` at the same boundary, log, and skip the cycle. The affected callers:

- `packages/orchestrator/src/services/label-monitor-service.ts` — `pollRepo` catch chain.
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` — `pollRepo` catch chain.
- `packages/orchestrator/src/services/webhook-setup-service.ts` — wraps `gh` calls; catch on a per-call basis (best-effort registration).
- `packages/orchestrator/src/worker/claude-cli-worker.ts` — sibling fan-out call site; the existing error handler around the `gh pr ready` loop captures any throw and continues with the next sibling.

The `LabelSyncService.syncAll()` already runs inside a try/catch in `server.ts:237–241` so a thrown `JitTokenError` there logs and continues.

(The catch additions in the caller files are tracked under task generation, not under this contract.)

## Tests (added)

In `packages/workflow-engine/__tests__/actions/github/client/gh-cli.test.ts`:

- `resolveTokenEnv returns { GH_TOKEN } when provider returns a token` — value matches provider output.
- `resolveTokenEnv returns { GH_TOKEN: '' } when provider returns falsy` — explicit empty string; no `undefined`.
- `resolveTokenEnv returns undefined when no provider configured` — legacy behavior preserved.
- `executeGh propagates JitTokenError when provider throws` — no `gh` spawn observed (mock `executeCommand` not called); error rethrown unchanged.
