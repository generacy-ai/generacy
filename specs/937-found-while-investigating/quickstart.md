# Quickstart

## What this fix does

Stops fresh wizard-provisioned clusters from firing the one-shot post-activation clone before the user has entered their GitHub credentials. Two changes ship together:

1. Orchestrator `PostActivationRetryService` gates `needsRetry` on a sealed `GH_TOKEN` in `/var/lib/generacy/wizard-credentials.env`.
2. Control-plane `bootstrap-complete` handler mirrors `prepare-workspace`: skip the sentinel write when `hasGitHubToken === false`, emit an `awaiting-credentials` event.

## Files changed

- `packages/orchestrator/src/services/post-activation-retry.ts`
- `packages/orchestrator/src/__tests__/post-activation-retry.test.ts`
- `packages/orchestrator/src/__tests__/post-activation-dispatch.test.ts`
- `packages/control-plane/src/routes/lifecycle.ts`
- `packages/control-plane/__tests__/routes/lifecycle.test.ts`

No new files, no new deps.

## Running tests

```bash
# From repo root
pnpm --filter @generacy-ai/orchestrator test post-activation
pnpm --filter @generacy-ai/control-plane test lifecycle
```

Or run everything for affected packages:

```bash
pnpm --filter @generacy-ai/orchestrator test
pnpm --filter @generacy-ai/control-plane test
```

## Manual smoke (SC-001, SC-005)

1. Provision a fresh cluster via the wizard end-to-end (`generacy launch --claim=<code>` or the cloud UI equivalent). Use a real GitHub repo (`snappoll-3`-style layout).
2. Observe orchestrator logs during activation:
   - Should see `Post-activation retry deferred — GH_TOKEN not sealed in wizard-credentials.env` **exactly once**.
   - Should NOT see `replaying bootstrap-complete lifecycle action` before wizard-complete.
3. Complete the wizard's credential step.
4. Within 30 s of wizard finish:
   - `/workspaces/<repo>/.git` MUST exist.
   - `/var/lib/generacy/post-activation-complete` MUST exist.
5. Grep control-plane logs — `entrypoint-post-activation.sh` should have been invoked exactly once (SC-005).

## Manual smoke (SC-004 — restart-recovery preserved)

1. Provision a fresh cluster and complete the wizard normally (creds sealed).
2. Before `/var/lib/generacy/post-activation-complete` is written, stop the container.
3. `rm /var/lib/generacy/post-activation-complete` if it was already written (simulate a failed post-activation).
4. Start the container.
5. Orchestrator log MUST show `Post-activation incomplete on restart — triggering retry` and the retry MUST fire (creds are already sealed).
6. `/var/lib/generacy/post-activation-complete` gets written by the retry.

## Cloud-side verification (SC-002, SC-003)

Between activation and wizard-complete, the cloud's `cluster.bootstrap` channel MUST show exactly one message with `{ status: 'deferred', reason: 'github-token-not-sealed' }` from the orchestrator retry service. If FR-006 also fires (either from a premature caller or a stale replay), one additional message with `{ status: 'awaiting-credentials', reason: 'github-token-not-sealed' }` appears.

## Troubleshooting

**Symptom: still seeing empty `/workspaces/<repo>` on wizard clusters after this fix.**
- Check `WIZARD_CREDS_PATH` env var — if it points somewhere other than the default, ensure both the control-plane and orchestrator processes see the same value. `PostActivationRetryService` (via FR-003) reads the same env var, but the path must match at both ends.
- Check `wizard-credentials.env` content: `sudo cat $WIZARD_CREDS_PATH` — must contain a line `GH_TOKEN=<non-empty>`. If the file exists but has no `GH_TOKEN`, the credhelper unseal failed; check `writeWizardEnvFile` logs for `credential-unseal-partial` warnings.
- Check `post-activation-watcher.sh` logs (`cluster-base` side): should show `refusing token-less clone` on the deferred boot and successful clone after the sealed `bootstrap-complete`.

**Symptom: cluster still shows `replaying bootstrap-complete` before wizard-complete.**
- Verify the running image includes commit for this PR. `PostActivationRetryService.checkPostActivationState()` should read `wizard-credentials.env`.
- Check for a *third-party* caller of `POST /lifecycle/bootstrap-complete` — FR-006 covers that case too, so the sentinel still won't write, but the log line would still appear on the orchestrator side (from a different code path).

**Symptom: restart-recovery no longer fires the retry.**
- Regression suspected. Verify `wizard-credentials.env` at boot: `readFileSync('/var/lib/generacy/wizard-credentials.env')`. If the file has a valid `GH_TOKEN`, `needsRetry` should be `true` and the retry should fire.
- Check the orchestrator log for `Post-activation retry deferred — GH_TOKEN not sealed` — that would mean the file's `GH_TOKEN` line is malformed. FR-004 requires plain `KEY=VALUE` with no quoting/comments/escapes.

## Post-merge checklist

- [ ] Smoke on local `snappoll-3`-style deploy (SC-001).
- [ ] Smoke on cloud staging cluster (SC-001).
- [ ] Grep-verify SC-002 negative log absence + FR-002 positive log presence.
- [ ] Cloud UI shows the `deferred` event on the fresh-cluster path (SC-003).
- [ ] Manual restart-recovery smoke (SC-004).
- [ ] E2E: `entrypoint-post-activation.sh` invocation count = 1 across the full lifecycle (SC-005).
