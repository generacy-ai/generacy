# Quickstart: `frameId` mint + consume

**Feature**: #1077
**Audience**: implementer + first-review reader.

## Prerequisites

- Node ≥22, pnpm ≥9 (repo standard).
- `pnpm install` completed.
- No cloud dependency — this feature is cluster-side only.

## Files you will edit

```text
packages/cluster-relay/src/relay.ts
packages/cluster-relay/tests/relay.test.ts
packages/orchestrator/src/routes/cockpit-gates.ts
packages/orchestrator/src/routes/__tests__/cockpit-gates.test.ts
packages/orchestrator/src/types/relay.ts
packages/orchestrator/src/__tests__/cockpit-gates-frameid.integration.test.ts
packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts
.changeset/1077-frameId-mint-consume.md   (NEW)
```

## Landing order (recommended)

1. **`packages/cluster-relay`** — add `PendingFrameMeta`, `PendingFrame`,
   `registerPendingFrame`, TTL timer machinery, and the new settle/drop
   branches at `relay.ts:334`. Update the comment at `:330-333` per D-10 /
   FR-009. Update the `#1063` describe tests as per `contracts/pending-map.md`.
   - `pnpm --filter @generacy-ai/cluster-relay test` should pass.
2. **`packages/orchestrator/src/types/relay.ts`** — add the interface method
   so the orchestrator compiles against the new API.
3. **`packages/orchestrator/src/routes/cockpit-gates.ts`** — add `mintFrameId`
   helper, wire the mint + `registerPendingFrame` + response echo in both
   handlers per `contracts/mint-route.md`. Update the unit tests.
   - `pnpm --filter @generacy-ai/orchestrator test` should pass.
4. **`packages/orchestrator/src/__tests__/cockpit-gates-frameid.integration.test.ts`**
   — extend with the new settle + drop scenarios (real WebSocket peer).
5. **`packages/generacy`** — add optional `frameId` to the two tool wire
   schemas. Type-only impact on callers today; unblocks caller-supplied
   overrides tomorrow.
   - `pnpm --filter @generacy-ai/generacy test` should pass.
6. **Changeset** — write `.changeset/1077-frameId-mint-consume.md` per the
   changeset section in `plan.md` § Constitution Check.

## Sanity checks before opening the PR

Run these commands verbatim (they mirror the spec's SC assertions):

```bash
# SC-006 — cluster-side references to frameId now exist.
grep -rn 'frameId' packages/generacy/src | wc -l
#  expected: > 0 (was 0 before this PR)

# SC-007 — misdirecting comment removed.
grep -n '#1059 steps 4-7' packages/cluster-relay/src/relay.ts
#  expected: no output

# All three affected packages green.
pnpm --filter @generacy-ai/cockpit test
pnpm --filter @generacy-ai/cluster-relay test
pnpm --filter @generacy-ai/orchestrator test
pnpm --filter @generacy-ai/generacy test

# Changeset present and formatted.
ls .changeset/1077-*.md
cat .changeset/1077-*.md   # sanity-check the bump levels
```

## What a passing run looks like at the wire level

Load one of the tool call sites (or `curl` the route directly against a
running orchestrator):

```bash
curl -sX POST http://127.0.0.1:3100/cockpit/gates \
  -H 'content-type: application/json' \
  --data '{
    "type":"gate-open",
    "gateId":"a1b2c3d4e5f6a7b8c9d0e1f2",
    "gateKey":"generacy-ai/generacy#1077:clarification:batch-1",
    "gateType":"clarification",
    "epicRef":"generacy-ai/generacy#1077",
    "issueRef":"generacy-ai/generacy#1077",
    "issueTitle":"Do the thing",
    "issueUrl":"https://github.com/generacy-ai/generacy/issues/1077",
    "title":"Clarification needed",
    "body":"Choose one.",
    "options":[{"id":"a","label":"A"}],
    "allowFreeText":true,
    "sessionId":"sess_local",
    "askedAt":"2026-07-29T00:00:00.000Z"
  }'
```

Response:

```json
{
  "accepted": true,
  "retained": false,
  "frameId": "frm_6e7c94a25f1b8de3f2a1a7c9"
}
```

Log line at the orchestrator's `cluster-relay` logger (when the cloud replies):

```
info: cluster.cockpit.reply settled pending frame
  frameId=frm_6e7c94a25f1b8de3f2a1a7c9
  frameType=gate-open
  gateId=a1b2c3d4e5f6a7b8c9d0e1f2
  accepted=true
  ageMs=421
```

## Troubleshooting

- **`registerPendingFrame is not a function` on the mock client** — extend
  `makeMockClient(...)` helpers in the tests (three sites, all
  `overrides: Partial<ClusterRelayClient>` shape). Grep:
  `grep -rn 'makeMockClient' packages/orchestrator/src/routes/__tests__/`.
- **A retained frame's reply hits the unknown-drop branch** — expected when
  the disconnect exceeded the 30s TTL. Check the `debug` eviction line; if
  the eviction fired before the drain, that's the design (spec Assumption
  §"post-reconnect drain of a frame whose sender is no longer around").
- **`pending.size` non-zero after a test** — a settle path or shutdown clear
  was missed. Check that (a) the reply's `frameId` matched (bogus id →
  drop-branch, does not evict), (b) the test called `disconnect()` (not just
  `wss.close()`), (c) `useFakeTimers` didn't leak between tests.
- **Existing #1063 tests fail on `debug` assertion** — expected. Rewrite per
  `contracts/pending-map.md` § "Update SC-001".
- **New public method on `ClusterRelayClient` is not visible to the
  orchestrator** — you likely edited only `packages/cluster-relay/src/relay.ts`.
  The orchestrator consumes the interface from
  `packages/orchestrator/src/types/relay.ts` — add the method there too.

## Related docs

- [`spec.md`](./spec.md) — feature specification (read-only).
- [`clarifications.md`](./clarifications.md) — resolved design decisions Q1–Q5.
- [`research.md`](./research.md) — implementation-shaping choices D-1…D-10.
- [`data-model.md`](./data-model.md) — types & lifecycle.
- [`contracts/mint-route.md`](./contracts/mint-route.md) — route behaviour.
- [`contracts/pending-map.md`](./contracts/pending-map.md) — relay-client behaviour.
- [`contracts/wire-response.md`](./contracts/wire-response.md) — 202 shape.
