# Refusal Payload Contract

**Feature**: #1015 | **Branch**: `1015-summary-nothing-prevents-two`

## When emitted

Any call to `cockpit_claim` where a **live** claim exists on the scope AND:

- The caller's `sessionId` differs from the live claim's `sessionId`, AND
- `takeover: false` (either explicit or defaulted).

`cockpit_release` never emits this shape (release is always no-op on non-holder).

## Wire shape

```ts
{
  status: 'error',
  class: 'claim-conflict',
  detail: string,               // human-readable summary
  hint: string,                 // action instructions
  holder: {
    version: 1,
    sessionId: string,
    heldSince: string,          // ISO-8601 UTC
    heartbeatAt: string,        // ISO-8601 UTC
    ledger: string,
    scope: string               // "<owner>/<repo>#<n>"
  },
  commentUrl: string            // URL of the marker comment (for direct inspection)
}
```

**Type**: extends the shared `ToolErrorResult` with two extra fields (`holder`, `commentUrl`). Narrows `class` to the literal `'claim-conflict'`.

## Field contracts

### `detail`

Template (exact string, `<...>` are substituted):

```
scope <scope> is already claimed by session <holder.sessionId> (heartbeat <holder.heartbeatAt>, ledger <holder.ledger>)
```

Example:
```
scope generacy-ai/generacy#1015 is already claimed by session ab12cd34ef56789a (heartbeat 2026-07-21T14:03:42.001Z, ledger .generacy/cockpit/auto-runs/generacy-ai-generacy-1015-20260721-140142.ledger)
```

### `hint`

Template (exact string — this is a load-bearing contract; the skill's gate wording is derived from it):

```
retry with takeover: true, run /cockpit:auto ... --takeover, or accept the auto skill gate
```

This surfaces all three takeover paths per FR-005 (Q4 → D).

### `holder`

Full `ClaimPayload` of the incumbent — verbatim from the marker comment. Callers can render the payload in a gate without a second GitHub call.

### `commentUrl`

Full URL of the marker comment, e.g. `https://github.com/generacy-ai/generacy/issues/1015#issuecomment-2099...`. Operators can click through to inspect the raw claim state.

## Consumer behavior

The `/cockpit:auto` skill (in the `agency` repo, out of scope for this branch) is the primary consumer. On receiving a `claim-conflict`:

1. Print a summary line to the ledger:
   ```
   claim · refused · holder=<holder.sessionId> heartbeat=<holder.heartbeatAt>
   ```
2. Present an operator gate with three options:
   - **Take over** — re-invoke `cockpit_claim` with `takeover: true`.
   - **Watch instead** — exit the auto loop cleanly, optionally suggest `/cockpit:watch <scope>`.
   - **Cancel** — exit non-zero, print the refusal payload verbatim.
3. If the operator originally invoked `/cockpit:auto ... --takeover`, skip the gate and go straight to takeover.

**Non-skill consumers** (scripted callers via raw MCP): parse the `holder` field and decide programmatically. `class === 'claim-conflict'` is a stable string; the type carrier for typed clients.

## Test surface

- `parity-claim.test.ts` asserts the exact `class` and template strings.
- The MCP tool boundary test (`server-refuses-worker-role.test.ts`-style — or new `parity-claim.test.ts`) verifies the JSON envelope round-trips through `structuredContent` intact.
- `data-model.md` `RefusalPayload` interface must stay in sync — a code-review checklist item.
