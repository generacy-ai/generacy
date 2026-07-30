# @generacy-ai/cockpit

Foundation library for the Generacy **Epic Cockpit** — a set of pure,
testable primitives any cockpit consumer (UI, CLI, or service) can import.

## What's inside

- A curated `CockpitState` union (`pending | active | waiting | error |
  terminal | unknown`) and a pure `classify(labels)` function that returns a
  single `{ state, sourceLabel }` summary for any GitHub issue's label set.
- The precedence rule the cockpit renders by — `terminal > error > waiting >
  active > pending` — with documented tie-breaks (pipeline order inside
  `waiting`, `WORKFLOW_LABELS` index everywhere else).
- A Zod-validated `cockpit:` config block read from `.generacy/config.yaml`
  (just an optional `owner` — `gh auth status` login is the fallback).
- The single-source epic resolver: `parseEpicBody()`, `resolveEpic()`,
  `matchPhaseHeading()`. Reads the epic issue body — task-list refs
  (`- [ ]` / `- [x]`) grouped under `### <phase>` headings — and returns
  a deduped ref set. Fails loud when the body has no headings or no refs.
- A thin, testable `gh` CLI wrapper (list issues, get one issue, mutate
  labels, read PR check runs) with an injectable `CommandRunner` so unit
  tests never spawn real processes.

## Install

```bash
pnpm add @generacy-ai/cockpit
```

ESM only, Node ≥ 22.

## Usage

### Classify a GitHub issue's labels

```ts
import { classify } from '@generacy-ai/cockpit';

const { state, sourceLabel } = classify([
  'phase:plan',
  'waiting-for:plan-review',
]);
// → { state: 'waiting', sourceLabel: 'waiting-for:plan-review' }
```

### Load the cockpit config block

```ts
import { loadCockpitConfig } from '@generacy-ai/cockpit';

const { config, source } = await loadCockpitConfig();
// config.owner — from cockpit.owner in .generacy/config.yaml,
//                or `gh auth status` login when unset.
// source: 'cockpit-block' | 'defaults'
```

### Resolve the children of an epic from the issue body

```ts
import { resolveEpic, GhCliWrapper } from '@generacy-ai/cockpit';

const resolved = await resolveEpic({
  epicRef: 'owner/repo#42',
  gh: new GhCliWrapper(),
});
// resolved.parsed.phases   — every `### <phase>` heading and its refs
// resolved.parsed.allRefs  — deduped union, sorted by (repo, number)
// resolved.repos           — the unique repo set covered by the epic
```

Fails loud (`LoudResolverError`) on an unparseable body — no manifest
file, no label-search fallback, no silent drops.

## Config schema (`.generacy/config.yaml`)

```yaml
cockpit:
  owner: alice   # optional; defaults to `gh auth status` login
```

## Gates protocol (Cockpit Remote Gates epic, P2 mirror-doc)

**Audience**: engineers implementing the P2 cloud-side fake-cluster tests in
`generacy-ai/generacy-cloud`. This section pins the wire shapes exchanged
between the cluster-side integration harness (`packages/orchestrator/src/__tests__/cockpit-gates-integration.integration.test.ts`)
and the fake relay peer, so the cloud side can emit and expect the exact
same bytes without cross-repo copy-paste.

**Single-source the shapes**: build every wire body through the fixture
builders exported from `@generacy-ai/cockpit` so cluster and cloud stay
byte-identical — never hand-inline a literal:

```ts
import {
  gateOpenFixture,   // POST /cockpit/gates body           → GateOpenSchema
  gateAckFixture,    // POST /cockpit/gates/:id/ack body    → GateAckSchema
  answerLineFixture, // POST /cockpit/answers body + tail   → GateAnswerEnvelopeSchema (+ scope)
  DEFAULT_WIRE_SCOPE,   // { owner, repo, number }
  DEFAULT_WIRE_EPIC_REF // "owner/repo#number"
} from '@generacy-ai/cockpit';
```

### Wire framing

All messages are JSON-encoded WebSocket text frames matching
`RelayMessageSchema` from `@generacy-ai/cluster-relay`. No custom framing,
no compression, no TLS in tests (fake peer is `ws://127.0.0.1:<port>`).

### Cluster → Cloud

**Gate-open event** (emitted when a `POST /cockpit/gates` succeeds). The
route echoes the validated `GateOpen` envelope as `data` verbatim — the
`kind` discriminator lives at the top of `data`, not nested under a `gate`
key:

```jsonc
{
  "type": "event",
  "event": "cluster.cockpit",
  "timestamp": "2026-07-21T12:34:56.789Z",
  "data": {
    "kind": "gate-open",
    "gateId": "g_…",
    "generation": 0,
    "scope": { "owner": "generacy-ai", "repo": "generacy", "number": 1024 },
    "openedAt": "2026-07-21T12:00:00.000Z"
    // …plus any passthrough keys (e.g. `payload`) — GateOpenSchema is .passthrough()
  }
}
```

**Gate-ack event** (emitted when a `POST /cockpit/gates/:id/ack` succeeds).
`data` is the validated `GateAck` envelope; the route injects the path `:id`
as `gateId`:

```jsonc
{
  "type": "event",
  "event": "cluster.cockpit",
  "timestamp": "…",
  "data": {
    "kind": "gate-ack",
    "gateId": "g_…",
    "generation": 0,
    "outcome": "answered",
    "ackedAt": "2026-07-21T12:05:01.000Z"
    // …plus any passthrough keys (e.g. `answer`)
  }
}
```

Both events use `data.kind` (`"gate-open"` | `"gate-ack"`) as the
discriminator on the `cluster.cockpit` channel.

### Cloud → Cluster

**Answer down-path** — the cloud injects operator-authored answers into the
cluster via an `api_request` frame that the orchestrator proxies to its
`POST /cockpit/answers` route:

```jsonc
{
  "type": "api_request",
  "correlationId": "<uuid v4>",
  "method": "POST",
  "path": "/cockpit/answers",
  "headers": { "content-type": "application/json" },
  "body": {
    "kind": "gate-answer",
    "deliveryId": "dlv_…",   // dedup key — the writer keeps one file line per deliveryId
    "gateId": "g_…",
    "generation": 0,
    "answeredAt": "2026-07-21T12:05:00.000Z",
    "answer": { /* operator's choice */ },
    "scope": { "owner": "generacy-ai", "repo": "generacy", "number": 1024 }
    // `answeredBy` optional
  }
}
```

> **Seam pinned by the harness**: the answers route validates
> `GateAnswerEnvelopeSchema` (which does not require `scope`), but the doorbell
> tailer validates `GateAnswerLineSchema` (which does). A body **without**
> `scope` is written to the answers file yet silently dropped by the doorbell.
> `answerLineFixture()` carries `scope` so the single wire shape satisfies both
> ends — mirror it exactly.

Response frame (200 on happy path, `{ accepted, deduped }`; 4xx on validation
error):

```jsonc
{
  "type": "api_response",
  "correlationId": "<same as request>",
  "status": 200,
  "body": { "accepted": true, "deduped": false }
}
```

### Connection lifecycle

1. Orchestrator dials `wss://…/relay` (or `ws://127.0.0.1:<port>` in tests).
2. Orchestrator sends a `handshake` frame carrying its cluster metadata.
3. Peer responds with a `heartbeat` frame — this transitions the client from
   `authenticating → connected`. (Fake peer mirrors this pattern; see
   `packages/cluster-relay/tests/relay.test.ts:93-100`.)
4. Steady state: `event` / `api_request` / `api_response` frames in both
   directions, `heartbeat` at the configured interval.

### Retain-and-replay across disconnect

When the peer disconnects while a `cluster.cockpit` event is pending, the
orchestrator retains the event and replays it on the next successful
connection. Mirror of the `cluster.vscode-tunnel` pattern in
`packages/orchestrator/src/routes/retained-tunnel-event.ts`.

Assertion pattern (harness scenario S1b): `disconnect → POST /cockpit/gates
→ reconnect → assert peer sees the event exactly once on the new socket`.

### Further reading

- Harness invocation and troubleshooting:
  [`specs/1024-part-cockpit-remote-gates/quickstart.md`](../../specs/1024-part-cockpit-remote-gates/quickstart.md).
- Fake-peer wire contract in full:
  [`specs/1024-part-cockpit-remote-gates/contracts/fake-peer-protocol.md`](../../specs/1024-part-cockpit-remote-gates/contracts/fake-peer-protocol.md).
- 8-scenario catalog:
  [`specs/1024-part-cockpit-remote-gates/contracts/scenario-catalog.md`](../../specs/1024-part-cockpit-remote-gates/contracts/scenario-catalog.md).

## References

- Spec: [`specs/806-epic-generacy-ai-tetrad/spec.md`](../../specs/806-epic-generacy-ai-tetrad/spec.md)
- Plan: [`specs/806-epic-generacy-ai-tetrad/plan.md`](../../specs/806-epic-generacy-ai-tetrad/plan.md)
- Resolver contract: [`specs/806-epic-generacy-ai-tetrad/contracts/resolver.md`](../../specs/806-epic-generacy-ai-tetrad/contracts/resolver.md)
- CLI contract: [`specs/806-epic-generacy-ai-tetrad/contracts/cli.md`](../../specs/806-epic-generacy-ai-tetrad/contracts/cli.md)
