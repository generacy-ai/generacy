# Quickstart: verify #1053 fix locally

**Feature**: #1053 — per-run discriminator on `gateKey`
**Branch**: `1053-problem-gateid-pure-function`

## Prerequisites

- Node.js ≥22 (`node --version`).
- `pnpm` at repo root (`pnpm --version`).
- Repo checked out at `/workspaces/generacy` on branch `1053-problem-gateid-pure-function`.

## 1. Reproduce the arithmetic collision (before applying the fix)

The spec §Field instance records the byte-level collision on `christrudelpw/snappoll#1` phase `P2`. Replicate it with a one-liner from repo root:

```bash
node -e "const {createHash} = require('node:crypto'); \
  const k = 'christrudelpw/snappoll#1:phase-queue:P2'; \
  console.log(k, '→', createHash('sha256').update(k, 'utf8').digest('hex').slice(0,24));"
```

Expected output:

```
christrudelpw/snappoll#1:phase-queue:P2 → 075855bf0c3fef1b7f52ed3a
```

This matches the terminal doc id from the field instance (`spec.md` §Field instance table). Every re-run of an epic that previously reached that phase's terminal state produces the same 24-hex → collides with the stored doc → gets dropped.

## 2. Install and build

```bash
pnpm install
pnpm --filter @generacy-ai/cockpit build
pnpm --filter @generacy-ai/generacy build
```

## 3. Run the pure-derivation unit tests

```bash
pnpm --filter @generacy-ai/cockpit test src/__tests__/gates-id.test.ts
pnpm --filter @generacy-ai/cockpit test src/gates/__tests__/schema.test.ts
```

The new test cases (added by this PR) assert:

- `deriveGateKey('christrudelpw/snappoll#1', 'phase-queue', 'P2')` (no `runId`) still equals `'christrudelpw/snappoll#1:phase-queue:P2'` — regression guard.
- `deriveGateId(...)` of the above still equals `'075855bf0c3fef1b7f52ed3a'` — arithmetic anchor to the field instance.
- `deriveGateKey(..., 'christrudelpw-snappoll-1-20260727-200458')` produces a different string.
- `deriveGateId(...)` of the runId-suffixed variant produces a `gateId` != `'075855bf0c3fef1b7f52ed3a'`. **This is the SC-005 assertion**: the field instance is no longer reproducible.

## 4. Run the tool-level tests

```bash
pnpm --filter @generacy-ai/generacy test src/cli/commands/cockpit/mcp/__tests__/cockpit-gate-open-runid.test.ts
pnpm --filter @generacy-ai/generacy test src/cli/commands/cockpit/mcp/__tests__/parity-gate-ack.test.ts
```

Assertions covered:

- Explicit `runId` on input propagates into the POSTed body's `gateKey` field.
- Missing `runId` triggers fallback from `INSTANCE_NONCE` and logs `runIdSource: 'fallback-instance-nonce'` at `info` level.
- Two calls with the same input produce byte-identical POST bodies (askedAt hoist verified).
- `cockpit_gate_ack` accepts `runId` on input without `.strict()` rejection and does NOT include it on the ack wire body.

## 5. Run the end-to-end integration harness (from #1024)

```bash
pnpm --filter @generacy-ai/orchestrator test src/__tests__/cockpit-gates-integration.integration.test.ts
```

The new scenario in this suite (added by this PR):

- Runs the fake relay peer.
- Emits `gate-open` for `christrudelpw/snappoll#1 phase-queue P2` with `runId="RA"` — assert peer sees frame 1 with `gateId_A`.
- Simulates `applied` acknowledgment on Run A.
- Emits `gate-open` for the same triple with `runId="RB"` — assert peer sees frame 2 with `gateId_B` != `gateId_A`.
- Assert peer's inbox view shows two distinct rows.

## 6. Manual end-to-end (SC-005)

Reproduce the exact field instance on a live cluster:

```bash
# Assumes /cockpit:auto is already installed and configured for christrudelpw/snappoll#1

# Drive one auto run to completion (or at least past phase P2) so P2's gate reaches `applied`:
/cockpit:auto --gates=ui christrudelpw/snappoll#1

# Wait for it to complete, or observe the P2 gate transition to `applied` in the cloud inbox.

# Then re-run:
/cockpit:auto --gates=ui christrudelpw/snappoll#1
```

**Post-fix expected behaviour**:

- The second run mints a NEW auto-run id (timestamp component differs).
- The P2 gate-open frame carries a `gateKey` with the new runId suffix.
- `deriveGateId(gateKey)` produces a NEW `gateId` distinct from `075855bf0c3fef1b7f52ed3a`.
- The cloud does NOT recognize the new id → treats as a fresh gate → the inbox shows an `Open` row.
- The auto loop proceeds past the P2 gate instead of stalling.

**Failure signal**: If the inbox still shows `0` items and the auto loop reports "Open gate — needs your answer", the fix has regressed. Check the orchestrator log for:

- The `cockpit_gate_open.runid-source` structured log line — confirm `runIdSource` is not empty and `runId` is present in the outgoing frame.
- The relay log for the `[relay] Ignoring gate-open for terminal gate ...` line — its absence post-fix confirms the collision path no longer fires.

## Troubleshooting

### "runId is required" error at the tool boundary

Not expected — `runId` is optional. If you see this, either:

1. Zod schema was updated to `.min(1)` without `.optional()` — revert to `.string().min(1).optional()`.
2. The caller is passing an empty string `""` instead of omitting the field. Fix on the caller side (empty string is rejected by `.min(1)`; use `undefined` or omit).

### Two calls in the same run produce different `gateId`s

Symptom: within-run duplicate inbox rows for the same natural gate.

Root cause: the auto-loop passed a different `runId` on the two calls. Investigate the skill-side wiring in `agency/packages/claude-plugin-cockpit/commands/auto.md` — the auto-run id should be minted once per run and passed on every `cockpit_gate_open` / `cockpit_gate_ack` invocation.

### Different `gateId` for the same call after MCP-server restart

Symptom: manual (non-auto) caller's retry after restart hits a different `gateId`.

Root cause: this is expected behaviour on the non-auto path — the fallback comes from `INSTANCE_NONCE` which regenerates on process restart. If retry-across-restart idempotency is required, the caller must pass an explicit `runId`.

### `INSTANCE_NONCE` fallback not being logged

Symptom: no `cockpit_gate_open.runid-source` log line at `info` level.

Root cause: log level configured above `info`. Set `LOG_LEVEL=info` on the MCP-server process.

## What this fix does NOT solve

Per plan §Out of Scope:

- The cloud `202 Accepted` on a to-be-dropped frame — FR-004 lands in a follow-up PR gated on generacy-cloud#887.
- The `/cockpit:auto` skill's handler for the (future) `terminal-collision` error class — FR-006 lands in the `agency` companion PR.
- Retroactive cleanup of the terminal doc that caused the field instance — forward-only.

## Related files

- `plan.md` — full implementation plan.
- `research.md` — decision rationale.
- `data-model.md` — schema and type changes.
- `contracts/gate-key-derivation.md` — extended `deriveGateKey` contract.
- `contracts/mcp-tool-input.md` — extended tool input contract.
- `contracts/terminal-collision-error.md` — follow-up PR contract (informational).
