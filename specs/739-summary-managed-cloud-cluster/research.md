# Research: Pre-Approved Device Code Redemption

**Issue**: [#739](https://github.com/generacy-ai/generacy/issues/739)
**Branch**: `739-summary-managed-cloud-cluster`

## Problem context

The spec documents the root cause exhaustively: `packages/orchestrator/src/activation/index.ts` has no branch that reads `GENERACY_PRE_APPROVED_DEVICE_CODE` (or any sibling). Codebase-wide grep confirms:

```bash
$ grep -rn "PRE_APPROVED\|preApproved" packages --include="*.ts"
# (no matches)
```

So the consumer side is a greenfield addition; there is no legacy reader to preserve.

The producer side (generacy-cloud `preApproveActivationCode`) already mints `{userCode, deviceCode, clusterId, apiKey}` and approves the code server-side — that work is done. Cloud-deploy keeps only `userCode` and discards `deviceCode` and `apiKey`; that's a companion fix in generacy-cloud.

## Design choices

### Decision 1: Redeem the device code (Design B), not deliver the key file (Design A)

| Design | Pros | Cons |
|--------|------|------|
| **A** — bake the API key into `.env` and write the key file before orchestrator boots | Zero orchestrator code change; existing-key path handles it | Long-lived bearer secret (the API key) lives in cloud-init `user_data` — DigitalOcean persists and retrieves `user_data`. Persistent secret exposure. |
| **B** — bake the (single-use, short-TTL) device code into `.env` and redeem on first boot | Only the short-lived device code is exposed; uses existing `/device-code/poll` endpoint which already returns the API key for approved codes; reuses `pollForApproval` verbatim | Adds one branch to `activate()`; needs failure handling for terminal redemption errors |
| C — new server endpoint to exchange `user_code` → key | More server surface; no advantage over B | Two endpoints to keep consistent; doesn't reuse the existing approved-code redemption path |

**Chosen: B.** Smaller blast radius if `.env` leaks (device code is one-shot + ~10 min TTL vs. the API key's months-long lifetime). Reuses existing endpoint and client code (`pollForApproval` is already exported by `@generacy-ai/activation-client` and re-exported by orchestrator).

### Decision 2: Read env var inside `activate()`, not via config loader

`OrchestratorConfig` (loaded by `packages/orchestrator/src/config/loader.ts`) is the canonical home for env-derived configuration. However:

1. The pre-approved device code is single-use; once consumed, it should not persist in config state.
2. We `delete process.env.GENERACY_PRE_APPROVED_DEVICE_CODE` after redemption (clarification Q1) — easier to reason about when the read and delete happen at the same call site.
3. The value is never reused elsewhere — only `activate()` needs it.

So `activate()` reads `process.env['GENERACY_PRE_APPROVED_DEVICE_CODE']` directly. This mirrors how `buildActivationUrl()` already reads `process.env['GENERACY_PROJECT_ID']` in the same file (line 17).

### Decision 3: Reuse `pollForApproval` for transient retries

RFC 8628 transient response codes (`authorization_pending`, `slow_down`) are already handled inside the `pollForApproval` loop:

```typescript
// packages/activation-client/src/poller.ts
case 'slow_down':
  intervalMs = Math.min(intervalMs + SLOW_DOWN_INCREMENT_MS, MAX_INTERVAL_MS);
case 'authorization_pending':
  // continue polling
```

For a pre-approved code, the first poll should return `approved` immediately. If transient errors occur (network blip, cloud 5xx), the existing poll loop retries until `expiresIn` lapses. Clarification Q2 explicitly calls out "bounded retry of `pollForApproval`" — this is achieved by `pollForApproval`'s own structure, with `expiresIn: 60` bounding the total wait.

We do **not** wrap `pollForApproval` in an outer retry loop. Reasons:
- Avoids double-retry semantics that are hard to reason about.
- The 60 s ceiling on a pre-approved code is generous: cloud already pre-approved, so the redeem-or-fail decision happens within a single poll round-trip in the happy path.
- If 60 s genuinely isn't enough (cloud propagation delay), the right knob is to raise `expiresIn`, not add an outer retry.

### Decision 4: Terminal failure falls through to interactive flow (not throw)

The clarifications (Q2) considered four options for terminal failure:

| Option | Outcome | Verdict |
|--------|---------|---------|
| A — fallback to interactive | Managed deploys silently hang | Acceptable; preserves human recovery path |
| **B — bounded retry then fallback** | Same as A but covers transient blips first | **Chosen** |
| C — relay error event | Infeasible: relay needs the activation key | Rejected |
| D — fail-fast (`process.exit(1)`) | Container restart re-reads same expired code from `.env` → crash loop | Rejected |

Design D is the trap: a fail-fast orchestrator would crash-loop forever because the `.env` is immutable from inside the container. The cloud-visible signal already exists — generacy-cloud's Droplet poller marks `provisioningStatus: failed` with reason `activation_timeout` at the ~15 min mark. We rely on that for cloud observability and let the orchestrator keep running (interactive flow + fallback prompt + healthy `/health` endpoint).

### Decision 5: No CLI flag (Q3 = B)

Adding `--pre-approved-device-code` to `generacy launch` / `generacy deploy` would create three names to keep in sync (`LaunchConfig.preApprovedDeviceCode`, env var, CLI flag) for marginal benefit. Operators wanting manual testing can `export GENERACY_PRE_APPROVED_DEVICE_CODE=...` before running compose.

### Decision 6: Env-var name stays `GENERACY_PRE_APPROVED_DEVICE_CODE` (Q4 = A)

RFC 8628 terminology: `device_code` is the redemption secret, `user_code` is the display-only string. Confusion with `GENERACY_PRE_APPROVED_ACTIVATION_CODE` is resolved by generacy-cloud #783 Q3 removing that sibling.

### Decision 7: Stdout log only (Q5 = A)

`{ event: 'activation-start', mode: 'pre-approved' | 'interactive' }` is emitted via pino at info level. Relay isn't connected — there's no other surface. Visible via `docker logs orchestrator` and droplet console.

## Implementation patterns referenced

- **Existing-key short-circuit** (`activation/index.ts:47-59`) — same pattern as the new pre-approved short-circuit: read precondition, log it, persist if missing, return.
- **Tier-limit handling** (`activation/index.ts:90-99`) — copied verbatim in the pre-approved branch for consistent error semantics.
- **Pino structured logging** — first parameter is an object, second is the message string (`logger.info({ event, mode }, '…')` is idiomatic in this codebase but the first form `logger.info({ event, mode })` also works because pino accepts object-only).

## Key sources / references

- RFC 8628 (OAuth 2.0 Device Authorization Grant) — terminology reference for `device_code` vs `user_code`.
- `packages/activation-client/src/poller.ts` — existing transient-retry loop; the pre-approved branch reuses this.
- `packages/orchestrator/src/activation/index.ts:101-122` — the canonical approved-path persistence block; the pre-approved branch mirrors this.
- `specs/517-context-cluster-activation/plan.md` — prior surgical activation-path PR; structural and stylistic precedent for this plan.
- Clarification answers in `specs/739-summary-managed-cloud-cluster/clarifications.md` Batch 1 (Q1–Q5).
- Companion issue: `generacy-ai/generacy-cloud` `preApproveActivationCode` keeps `userCode` only — must persist `deviceCode` and pass it through cloud-init.
