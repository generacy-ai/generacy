# MCP Tool Contract: `cockpit_release`

**Feature**: #1015 | **Branch**: `1015-summary-nothing-prevents-two`

## Purpose

Explicitly release a scope claim. Called by `/cockpit:auto` on clean terminal exit (`epic-complete`, `scope-drained`, or ctrl-C-graceful).

**Semantics summary**:
- Caller holds the claim → delete marker comment + remove `cockpit:claimed` label.
- Caller does not hold the claim (superseded, or never held) → no-op success with informational `action`.
- No live claim on the scope → no-op success (with orphaned-label cleanup as side effect).

## Input Schema

```ts
{
  scope: IssueRefInput,       // qualified: object / "owner/repo#N" / github.com URL
  sessionId: string           // /^[a-f0-9]{16,64}$/, opaque
}
```

## Success Envelope

```ts
// Caller was the holder
{
  status: 'ok',
  data: {
    action: 'released',
    releasedClaim: ClaimPayload   // the claim payload that was removed
  }
}

// Different session holds the claim (caller was superseded)
{
  status: 'ok',
  data: {
    action: 'not-holder',
    currentHolder: ClaimPayload   // the current live holder for observability
  }
}

// No live claim
{
  status: 'ok',
  data: {
    action: 'no-claim'
  }
}
```

## Error Envelope

| `class`           | When                                     | `hint`                                                              |
|-------------------|------------------------------------------|---------------------------------------------------------------------|
| `invalid-args`    | Zod parse failure                        | joined Zod error messages                                           |
| `wrong-kind`      | `scope` resolves to a PR                 | (from `normalizeIssueRef`)                                          |
| `transport`       | gh CLI failure                           | first line of gh stderr                                             |
| `scope-not-found` | Discovery fails with 404                 | "scope issue `<owner>/<repo>#<n>` not found"                        |
| `internal`        | Uncaught exception                       | error message                                                       |

Release **never** returns `claim-conflict` — a claim owned by a different session is a valid outcome (action: `not-holder`), not an error.

## Idempotency

Fully idempotent regardless of state:

- Call twice as the holder → first is `released`; second sees no-claim and returns `no-claim`.
- Call as a non-holder while a claim exists → `not-holder` (no writes).
- Call with no claim present → `no-claim` (best-effort orphaned-label removal only).

## GitHub Writes Per Call

| Path         | Writes                            |
|--------------|-----------------------------------|
| `released`   | 2 (delete comment + remove label) |
| `not-holder` | 0                                 |
| `no-claim`   | 0-1 (label cleanup if orphaned)   |

## Wire Example

```json
// Request
{
  "scope": "generacy-ai/generacy#1015",
  "sessionId": "9e5c8a0d755e40b3"
}

// Response (released)
{
  "status": "ok",
  "data": {
    "action": "released",
    "releasedClaim": {
      "version": 1,
      "sessionId": "9e5c8a0d755e40b3",
      "heldSince": "2026-07-21T14:05:03.100Z",
      "heartbeatAt": "2026-07-21T14:47:11.220Z",
      "ledger": ".generacy/cockpit/auto-runs/generacy-ai-generacy-1015-20260721-140503.ledger",
      "scope": "generacy-ai/generacy#1015"
    }
  }
}

// Response (not-holder)
{
  "status": "ok",
  "data": {
    "action": "not-holder",
    "currentHolder": {
      "version": 1,
      "sessionId": "cc1122dd3344",
      "heldSince": "2026-07-21T14:32:00.000Z",
      "heartbeatAt": "2026-07-21T14:47:12.100Z",
      "ledger": ".generacy/cockpit/auto-runs/generacy-ai-generacy-1015-20260721-143200.ledger",
      "scope": "generacy-ai/generacy#1015"
    }
  }
}
```
