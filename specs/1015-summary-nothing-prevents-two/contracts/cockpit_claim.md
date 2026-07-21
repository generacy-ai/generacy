# MCP Tool Contract: `cockpit_claim`

**Feature**: #1015 | **Branch**: `1015-summary-nothing-prevents-two`

## Purpose

Idempotent acquire-or-refresh-or-takeover of the active-driver claim on a scope issue. Called by the `/cockpit:auto` skill at arm time and on every wake-tick heartbeat.

**Semantics summary**:
- No existing claim → **acquire**. Post marker comment + apply `cockpit:claimed` label.
- Existing claim by the same `sessionId` → **refresh**. Edit marker comment to update `heartbeatAt`.
- Existing claim by different `sessionId`, `takeover: false` → **refuse** with `class: 'claim-conflict'`.
- Existing claim by different `sessionId`, `takeover: true` → **taken-over**. Delete incumbent comment, post ours, ensure label.
- Stale claim (heartbeatAt > 10 min old) is treated as no-claim regardless of `sessionId` and `takeover` flag.

## Input Schema

```ts
{
  scope: IssueRefInput,       // qualified: object / "owner/repo#N" / github.com URL
  sessionId: string,          // /^[a-f0-9]{16,64}$/, opaque
  ledger: string,             // relative path, 1-512 chars, not validated
  takeover?: boolean          // default false
}
```

## Success Envelope

```ts
// Action: 'acquired'
{
  status: 'ok',
  data: {
    action: 'acquired',
    claim: ClaimPayload,      // the just-posted payload
    commentUrl: string        // URL of the marker comment
  }
}

// Action: 'refreshed'
{
  status: 'ok',
  data: {
    action: 'refreshed',
    claim: ClaimPayload,      // updated payload with fresh heartbeatAt
    commentUrl: string
  }
}

// Action: 'taken-over'
{
  status: 'ok',
  data: {
    action: 'taken-over',
    claim: ClaimPayload,      // new (caller's) payload
    commentUrl: string,
    displaced: ClaimPayload   // previous incumbent's payload
  }
}
```

## Error Envelope

| `class`           | When                                                                    | `hint`                                                                                              |
|-------------------|-------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| `invalid-args`    | Zod parse failure on any field                                          | joined Zod error messages                                                                           |
| `wrong-kind`      | `scope` resolves to a PR, not an issue                                  | (from `normalizeIssueRef`) "pass an issue ref to `cockpit_claim`; PRs cannot hold a scope claim"    |
| `claim-conflict`  | Existing live claim by different session AND `takeover: false`          | "retry with `takeover: true`, run `/cockpit:auto ... --takeover`, or accept the auto skill gate"    |
| `transport`       | gh CLI failure (network / auth / rate-limit)                            | first line of gh stderr                                                                             |
| `scope-not-found` | Discovery fails with 404 on the scope                                   | "scope issue `<owner>/<repo>#<n>` not found"                                                        |
| `internal`        | Uncaught exception at the tool boundary                                 | error message                                                                                       |

The `claim-conflict` error additionally carries:

```ts
{
  status: 'error',
  class: 'claim-conflict',
  detail: string,               // 'scope <s> is already claimed by session <id> (heartbeat <ts>, ledger <p>)'
  hint: string,
  holder: ClaimPayload,         // full incumbent payload for gate rendering
  commentUrl: string            // marker comment URL for direct inspection
}
```

## Idempotency

- Refresh is a no-op-except-heartbeat when called by the incumbent — safe to call every wake tick.
- Acquire re-issued by the same session on a claim it already holds returns `action: 'refreshed'` (not a fresh `acquired`).
- Takeover re-issued when the caller is already the incumbent returns `action: 'refreshed'` (no `displaced` field, no delete-of-self).

## GitHub Writes Per Call

| Path         | Writes |
|--------------|--------|
| `acquired`   | 2 (post comment + add label) |
| `refreshed`  | 1 (edit comment)             |
| `taken-over` | 2 (delete incumbent + post new; label already present) |
| `refused`    | 0                             |

Aligned with SC-006 (≤1 write per auto-loop wake — the hot path is `refreshed`).

## Race Behavior

Two callers acquiring simultaneously against `no-claim`:
1. Both discover `no-claim` on parallel reads.
2. Both post their marker + label.
3. Both re-discover.
4. The oldest `heldSince` wins (R-9 tiebreaker). Loser's marker comment is deleted by the winner's re-discover pass. Loser receives a refusal on their re-discover verify step.

Two callers takeover-racing:
1. Both delete the incumbent's comment (second delete is idempotent-not-found — treated as success).
2. Both post their own marker.
3. Both re-discover; oldest-wins tiebreaker. Loser deletes their own comment and returns `class: 'claim-conflict'` naming the winner.

## Wire Example

```json
// Request
{
  "scope": "generacy-ai/generacy#1015",
  "sessionId": "9e5c8a0d755e40b3",
  "ledger": ".generacy/cockpit/auto-runs/generacy-ai-generacy-1015-20260721-140503.ledger",
  "takeover": false
}

// Response (acquired)
{
  "status": "ok",
  "data": {
    "action": "acquired",
    "claim": {
      "version": 1,
      "sessionId": "9e5c8a0d755e40b3",
      "heldSince": "2026-07-21T14:05:03.100Z",
      "heartbeatAt": "2026-07-21T14:05:03.100Z",
      "ledger": ".generacy/cockpit/auto-runs/generacy-ai-generacy-1015-20260721-140503.ledger",
      "scope": "generacy-ai/generacy#1015"
    },
    "commentUrl": "https://github.com/generacy-ai/generacy/issues/1015#issuecomment-2100..."
  }
}

// Response (claim-conflict)
{
  "status": "error",
  "class": "claim-conflict",
  "detail": "scope generacy-ai/generacy#1015 is already claimed by session ab12cd34ef56789a (heartbeat 2026-07-21T14:03:42.001Z, ledger .generacy/cockpit/auto-runs/generacy-ai-generacy-1015-20260721-140142.ledger)",
  "hint": "retry with takeover: true, run /cockpit:auto ... --takeover, or accept the auto skill gate",
  "holder": {
    "version": 1,
    "sessionId": "ab12cd34ef56789a",
    "heldSince": "2026-07-21T14:01:42.001Z",
    "heartbeatAt": "2026-07-21T14:03:42.001Z",
    "ledger": ".generacy/cockpit/auto-runs/generacy-ai-generacy-1015-20260721-140142.ledger",
    "scope": "generacy-ai/generacy#1015"
  },
  "commentUrl": "https://github.com/generacy-ai/generacy/issues/1015#issuecomment-2099..."
}
```
