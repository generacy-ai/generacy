# Contract: `terminal-collision` error class (follow-up PR — informational)

**Feature**: #1053 (FR-004 + FR-005 + FR-007)
**Ships in**: A follow-up PR gated on **generacy-ai/generacy-cloud#887**. NOT in this PR.
**Component**: `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts` (definition), `cockpit_gate_open.ts` + `cockpit_gate_ack.ts` (emission sites).
**Consumers**: `/cockpit:auto` skill (FR-006, `agency/packages/claude-plugin-cockpit/commands/auto.md`).

This file is captured HERE (not in the follow-up PR) so the FR-005 reviewer can validate the shape upfront and so cross-repo consumers (#1015, #1020, #1024 exhaustive-switch users) know what's coming.

## Rationale for splitting

Per clarifications Q2 → A (decoupled): FR-001–FR-003 (the discriminator) eliminates the case FR-004 detects. Once the discriminator lands, terminal collisions stop occurring. FR-004 is a backstop, not a blocker for the primary fix. Landing them together would gate this repo's release on the cross-repo dependency (generacy-cloud#887) — deemed not worth the coupling.

## `ErrorClass` extension

**Before** (current, this PR does NOT change this):

```ts
export type ErrorClass =
  | 'invalid-args'
  | 'wrong-kind'
  | 'unknown-gate'
  | 'not-an-epic'
  | 'gate-refusal'
  | 'transport'
  | 'query-unreachable'
  | 'invalid-cursor'
  | 'not-worker'
  | 'contended'
  | 'claim-conflict'
  | 'scope-not-found'
  | 'internal';
```

**After (follow-up PR)**:

```ts
export type ErrorClass =
  | 'invalid-args'
  | 'wrong-kind'
  | 'unknown-gate'
  | 'not-an-epic'
  | 'gate-refusal'
  | 'transport'
  | 'query-unreachable'
  | 'invalid-cursor'
  | 'not-worker'
  | 'contended'
  | 'claim-conflict'
  | 'terminal-collision'    // NEW
  | 'scope-not-found'
  | 'internal';
```

## `ToolErrorResult` for terminal-collision

```ts
{
  status: 'error',
  class: 'terminal-collision',
  detail: `gate ${gateId} was already in terminal state (${outcome}) as of ${createdAt}`,
  // Optional: `terminalOutcome?: 'applied' | 'superseded' | 'failed'` if cloud returns it
  // Optional: `terminalAt?: string` (ISO datetime)
}
```

- `class` is exhaustive-switchable. The `/cockpit:auto` skill branches on `class === 'terminal-collision'` to distinguish this from `'transport'` (retry same frame) and other cloud errors.
- `detail` is human-readable; not parsed by consumers.
- Additional structured fields on the terminal-collision variant are additive (Zod `.optional()` on the extended shape) — Q5-C precedent from `claim-conflict`.

## Cloud-side signal (generacy-cloud#887)

**Before**: cloud's `POST /cockpit/gates` returns `202 Accepted` regardless of whether the frame will be dropped by the relay's terminal-check.

**After (#887)**: when the doc for the incoming `gateId` is already in a terminal state, cloud returns a non-`202` status with a distinguishable body — proposed:

```
HTTP 409 Conflict
Content-Type: application/json

{
  "error": "terminal-collision",
  "gateId": "075855bf0c3fef1b7f52ed3a",
  "terminalOutcome": "applied",
  "terminalAt": "2026-07-23T15:18:38.174Z"
}
```

Exact wire shape is #887's decision; captured here as a proposal.

## Cluster-side detection

`cockpit_gate_open` (and `cockpit_gate_ack`) inspect the HTTP response body when `res.status === 409`:

- If body parses to `{ error: 'terminal-collision', ... }`: return `{ status: 'error', class: 'terminal-collision', detail: ... }`.
- Otherwise: existing 409 → `invalid-args` mapping applies (unchanged).

This is additive to `packages/generacy/src/cli/commands/cockpit/mcp/gates/client.ts` — the classifier gains one branch for `res.status === 409` where the body's `error` field is `'terminal-collision'`.

## Consumer impact

Adding `'terminal-collision'` to the union will break exhaustive switches on `ErrorClass` in:

- `#1015` (active-driver claim consumers)
- `#1020` (cockpit gates shared wire contracts consumers)
- `#1024` (integration harness scenarios that switch on error class)

This is the compiler doing its job. Reviewer of the follow-up PR should:

1. Run `pnpm build` across the workspace to surface the missing switch arms.
2. Add a default `assertNever(result.class)` arm to each consumer that doesn't yet handle `'terminal-collision'`.
3. Coordinate landing order with any concurrent PRs modifying error-class consumers.

## FR-007 — extension to `cockpit_gate_ack`

Same detection + same error class on the ack path. Uses the same 409 → `terminal-collision` mapping in `gates/client.ts`.

## Skill-side handler (FR-006)

Not in the cluster follow-up PR either. Lives in `agency/packages/claude-plugin-cockpit/commands/auto.md`. When the skill receives `class: 'terminal-collision'` from `cockpit_gate_open`, its acceptable behaviours per FR-006:

- (a) mint a fresh run discriminator and retry once
- (b) fall back to a local prompt for that gate
- (c) escalate to the operator with a message naming the gate

The concrete handler shape is decided in the `agency` repo's plan.

## Test coverage

- Unit: extend `packages/generacy/src/cli/commands/cockpit/mcp/gates/__tests__/client.test.ts` with a 409-with-terminal-collision-body case → asserts `class: 'terminal-collision'`.
- Integration: extend `packages/orchestrator/src/__tests__/cockpit-gates-integration.integration.test.ts` with a fake-peer scenario that responds 409 to a re-open of the same `gateKey`.

## Landing order

1. **generacy-cloud#887** — cloud returns non-`202` for terminal-collision.
2. **This repo's follow-up PR** — cluster detects the 409 and surfaces `terminal-collision`. Also lands FR-007 (ack detection).
3. **`agency` companion PR** — `/cockpit:auto` skill handles the new class.

Steps 2 and 3 can land in either order after step 1 (skill degrades gracefully if the cluster hasn't shipped detection yet — no `terminal-collision` errors, unchanged behaviour).
