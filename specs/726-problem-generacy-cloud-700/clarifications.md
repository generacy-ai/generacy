# Clarifications: #726 — Handle `tier-limit-exceeded` PollResponse Variant

## Batch 1 — 2026-05-26

### Q1: Consumer scope (FR-003 path correction)
**Context**: FR-003 says "CLI consumer of `pollForApproval` (in `packages/generacy/src/cli/commands/launch/`) branches on `result.status === 'tier-limit-exceeded'`". But `pollForApproval` is **not** called from `launch/` — the `launch` CLI just runs `docker compose up` and tails logs for the activation URL. The actual callers are:
1. `packages/orchestrator/src/activation/index.ts:79` — primary path, runs **inside the orchestrator container** during boot. Surfaces via the orchestrator logger.
2. `packages/generacy/src/cli/commands/deploy/activation.ts:59` — `generacy deploy` (BYO-VM SSH), runs on the user's host. Currently only branches on `pollResult.status === 'approved'`.

**Question**: Which consumer(s) must branch on `tier-limit-exceeded` and emit the user-facing error?
**Options**:
- A: Both the orchestrator (`activation/index.ts`) and the deploy command (`deploy/activation.ts`). Orchestrator surfaces via logger; deploy uses `console.error` + `process.exit`. (Maximum coverage.)
- B: Orchestrator only — the deploy command is rarely used; tier-limit will appear in orchestrator logs that deploy streams.
- C: Deploy command only — the orchestrator boot loop is internal; users see errors via cloud UI, not container logs.
- D: Add a launch-side surface too (e.g., orchestrator writes a sentinel file or emits a structured marker line that the `launch` CLI scans from `docker compose logs` and surfaces before its activation-URL timeout fires).

**Answer**: *Pending*

---

### Q2: Orchestrator error-result shape
**Context**: `packages/orchestrator/src/activation/index.ts` currently has only one terminal failure path: `throw new ActivationError(..., 'DEVICE_CODE_EXPIRED')` after exhausting cycles. The `activate()` return type is `ActivationResult` (api-key + identity fields). There is no defined shape for "activation rejected by cloud with a recoverable user-facing reason".

**Question**: How should `activate()` propagate `tier-limit-exceeded` upward?
**Options**:
- A: Throw `new ActivationError('Worker count of N exceeds your <tier> plan limit of M', 'TIER_LIMIT_EXCEEDED')`. Caller (`server.ts`) decides how to surface; existing try/catch around `activate()` catches it and pushes an error status via the relay (consistent with `CONTROL_PLANE_WAIT_TIMEOUT` flow in `server.ts`).
- B: Return a new discriminated `ActivationResult` shape (`{ kind: 'approved', ... } | { kind: 'tier-limit-exceeded', cap, requested, tier }`). Larger blast radius — touches `ActivationResult` consumers across orchestrator startup.
- C: Throw a generic `ActivationError` (existing `ACTIVATION_FAILED` code or similar) with the message text only — no new error code. Simplest, but loses programmatic discriminability for the relay/wizard.

**Answer**: *Pending*

---

### Q3: Tier name display formatting
**Context**: The cloud's `tier: z.string()` field carries the org's plan tier. Cloud likely returns lowercase identifiers like `"basic"`, `"pro"`, `"enterprise"` (this is the convention in `generacy-cloud`). The spec's proposed message ("exceeds your `<tier>` plan limit") and the issue body's example ("exceeds your Basic plan limit") use a capitalized form.

**Question**: How should `<tier>` be rendered in the user-facing error message?
**Options**:
- A: Verbatim from the cloud — whatever string the cloud returns is inserted directly. Cloud is the source of truth; capitalization is its responsibility. (Risks "exceeds your basic plan limit" if cloud sends lowercase.)
- B: Title-case the first character (`"basic"` → `"Basic"`) on the cluster side.
- C: Maintain a small mapping table on the cluster side (`basic` → `Basic`, `pro` → `Pro`, `enterprise` → `Enterprise`); fall back to verbatim for unknown values.

**Answer**: *Pending*

---

### Q4: Error message wording — match existing or use spec's text
**Context**: The spec's proposed message is `Worker count of <requested> exceeds your <tier> plan limit of <cap>. Upgrade your plan or retry with --workers=<cap>.` The existing `worker-count-resolver` (lines 47-52) emits `--workers=${opts.workers} exceeds tier cap of ${tierCap}. Upgrade your tier or reduce --workers.` These wordings differ ("Worker count of N" vs `--workers=N`; "plan limit of N" vs "tier cap of N"; "Upgrade your plan" vs "Upgrade your tier"; "retry with --workers=<cap>" vs "reduce --workers"). The spec assumes a "reusable error formatter" in `worker-count-resolver`, but there is no formatter — only inline string interpolation in a `throw new Error(...)`.

**Question**: Which wording should the new tier-limit-exceeded surfacing use?
**Options**:
- A: Use the spec's proposed text verbatim (introduces wording drift from `worker-count-resolver`).
- B: Match `worker-count-resolver`'s existing wording style for consistency (e.g., `--workers=N exceeds your <tier> tier cap of M. Upgrade your tier or reduce --workers.`).
- C: Extract a shared formatter (e.g., `formatTierLimitError({ requested, cap, tier })`) into a small util consumed by both `worker-count-resolver` and the new tier-limit-exceeded branch; pick one wording and apply everywhere.

**Answer**: *Pending*

---

### Q5: `pollForApproval` JSDoc and `ActivationLogger.info` vs `.error` for tier-limit
**Context**: The current JSDoc on `pollForApproval` says "Returns the final PollResponse (either 'approved' or 'expired')." After this change there's a third terminal value. Separately, the spec doesn't say whether the poller itself should log anything when it receives `tier-limit-exceeded`, or whether it should pass through silently and let the caller log.

**Question**: Should the poller log on `tier-limit-exceeded`, and at what level?
**Options**:
- A: Poller does not log — caller (orchestrator/deploy) decides. Update only the JSDoc to mention `'tier-limit-exceeded'` as a new terminal status. (Minimal change; preserves caller's control over surfacing.)
- B: Poller logs `logger.warn('Activation rejected: tier limit exceeded (requested=N, cap=M, tier=T)')` before returning, in addition to the caller's user-facing message. (Two log lines, but a clear breadcrumb for support.)
- C: Poller logs `logger.error(...)` and the caller is responsible only for `process.exit`/throw. (Inverts the current convention where the poller is silent on terminal states.)

**Answer**: *Pending*
