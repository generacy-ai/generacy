# Clarifications: Orchestrator Auto-Activation via Pre-Approved Device Code

**Issue**: [#739](https://github.com/generacy-ai/generacy/issues/739)
**Branch**: `739-summary-managed-cloud-cluster`

---

## Batch 1 — 2026-06-02

### Q1: Env Var Cleanup After Redemption
**Context**: The spec's Open Questions asks whether `GENERACY_PRE_APPROVED_DEVICE_CODE` should be removed from `process.env` after successful redemption. Defense-in-depth argues yes (prevents accidental reuse and reduces footprint of any later memory/log dump). Leaving it in place is simpler and the server already enforces single-use, making this advisory only. The choice affects `activate()` cleanup logic in `packages/orchestrator/src/activation/index.ts`.
**Question**: After successful redemption, should the orchestrator `delete process.env.GENERACY_PRE_APPROVED_DEVICE_CODE`?
**Options**:
- A: Yes — delete from process.env after the key file is persisted (defense-in-depth).
- B: No — leave it; server-side single-use enforcement is sufficient.
- C: Yes, and also overwrite/redact it in any structured log emission.

**Answer**: *Pending*

### Q2: Redemption Failure Behavior on Managed Deploys
**Context**: FR-005 says that if `GENERACY_PRE_APPROVED_DEVICE_CODE` is set but redemption fails (expired, already-redeemed, invalid), the orchestrator "falls back to the interactive flow." On a managed cloud deploy with no human present, this fallback is effectively the same as never activating — the container sits waiting for a code paste that will never come, and SC-004 only confirms the container doesn't crash. We need to decide what "fail" means for unattended deploys. This affects exit codes, retry behavior, relay status events, and whether the cluster surfaces `error` state to the cloud.
**Question**: When a pre-approved device code redemption fails on an unattended deploy, what should the orchestrator do?
**Options**:
- A: Fall back to interactive flow as written (FR-005), accept that managed deploys hang until manual intervention.
- B: Bounded retry of `pollForApproval` first (e.g. 3× with backoff covering transient cloud errors), then fall back to interactive if all retries fail.
- C: Fall back to interactive AND push an `error` lifecycle status to the cloud relay so the dashboard shows the failure mode.
- D: Fail-fast: exit non-zero so the container restart policy / cloud-side health monitor can surface the failure.

**Answer**: *Pending*

### Q3: `--pre-approved-device-code` CLI Flag
**Context**: The spec's Open Questions asks whether to add a `--pre-approved-device-code` CLI flag to `generacy launch` / `generacy deploy` for manual testing, or rely on env-only delivery. A flag adds testability (operators can seed an out-of-band approved code without editing `.env`) but enlarges the CLI surface and creates a third name to keep consistent alongside `LaunchConfig.preApprovedDeviceCode` and the env var. Affects `packages/generacy/src/cli/commands/launch/` and `commands/deploy/`.
**Question**: Should `generacy launch` and `generacy deploy` accept a `--pre-approved-device-code <code>` flag in addition to receiving the value from `LaunchConfig`?
**Options**:
- A: Yes — add the flag on both commands; flag overrides any cloud-provided value.
- B: No — env/LaunchConfig only; operators wanting manual testing can set the env var.
- C: Flag only on `launch` (local testing path); `deploy` stays env/LaunchConfig only.

**Answer**: *Pending*

### Q4: Env Var Naming Disambiguation
**Context**: After this change, two similarly-named env vars coexist: `GENERACY_PRE_APPROVED_ACTIVATION_CODE` (the display-only user_code like `VH57-EJRH`, kept per Out of Scope) and the new `GENERACY_PRE_APPROVED_DEVICE_CODE` (the redemption secret). The names differ only by one word and they encode different things with very different sensitivity (user_code is shown to humans; device_code is essentially a one-time bearer credential). Rename now while the second name has zero producers and zero readers, or accept the close-by-one-word naming?
**Question**: Should the env var pair be renamed for clarity, or kept as `_ACTIVATION_CODE` (user_code) and `_DEVICE_CODE` (redemption secret)?
**Options**:
- A: Keep both names as specified — `_ACTIVATION_CODE` for the display user_code and `_DEVICE_CODE` for the redemption secret.
- B: Rename to `GENERACY_PRE_APPROVED_USER_CODE` + `GENERACY_PRE_APPROVED_DEVICE_CODE` (matches RFC 8628 terminology directly).
- C: Keep `_ACTIVATION_CODE` and pick a clearly-distinct name for the secret, e.g. `GENERACY_ACTIVATION_REDEMPTION_TOKEN`.

**Answer**: *Pending*

### Q5: Activation Mode Log Surface
**Context**: FR-008 specifies structured log fields `{ event: 'activation-start', mode: 'pre-approved' | 'interactive' }` for on-call diagnosis but does not specify where these go. Orchestrator stdout is captured by Docker; structured relay events are visible in the cloud dashboard; both have different on-call workflows. SC-001 measurement is "watch cluster doc's `lastSeen` field" but that doesn't expose activation mode. For diagnosing a stuck-at-Connecting cluster, on-call needs to know which path was attempted.
**Question**: Where should the `activation-start` structured event be emitted?
**Options**:
- A: Stdout JSON only (existing pino logger). Visible via `docker logs`.
- B: Relay event only (`cluster.activation` channel). Visible in cloud dashboard timeline.
- C: Both — stdout JSON for local debug, plus a relay event so cloud-side on-call can diagnose without droplet SSH access.

**Answer**: *Pending*

---

*Generated by `/clarify` at 2026-06-02*
