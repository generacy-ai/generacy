# Contract: README `cockpit watch` stream-grammar section

The following block replaces `packages/generacy/README.md` lines 205–259 verbatim on merge.

---

## `cockpit watch` — stream grammar

`generacy cockpit watch <epic-ref>` streams one NDJSON event per line to stdout. Every emitted line is a JSON object with a `type` field equal to exactly one of the three values below. Consumers dispatching on `type` see 100% of the stream.

| `type`             | Fields                                                                                              | Emitted when |
|--------------------|-----------------------------------------------------------------------------------------------------|--------------|
| `issue-transition` | `type`, `ts`, `repo`, `kind`, `number`, `from`, `to`, `sourceLabel`, `url`, `event`, `labels`, `initial?` | Per-issue or per-PR state transition surfaced by the poll loop's diff step. |
| `phase-complete`   | `type`, `phase`, `epicRepo`, `epicNumber`, `ts`, `initial?`                                          | Every ref in a phase is CLOSED (fires once per transition into fully-closed). |
| `epic-complete`    | `type`, `epicRepo`, `epicNumber`, `ts`, `initial?`                                                   | Every ref in the epic is CLOSED. |

`initial: true` (optional, all three types) marks lines emitted during the startup sweep — see [Startup sweep](#startup-sweep).

### `issue-transition`

```json
{"type":"issue-transition","ts":"2026-07-09T14:20:03.111Z","repo":"o/r","kind":"issue","number":123,"from":"pending","to":"active","sourceLabel":"phase:plan","url":"https://github.com/o/r/issues/123","event":"label-change","labels":["phase:plan"]}
```

- `event` — the reason for the transition: `label-change`, `issue-closed`, `pr-merged`, `pr-closed`, or `pr-checks`.
- `from` / `to` — cockpit-state values; `null` on the initial sweep (`from`) or on a terminal close (`to`).
- `sourceLabel` — the label that determined `to`, or `null`.
- `kind` — `issue` for GitHub issues; `pr` for pull requests (`pr-*` events).
- Legacy consumers dispatching on `event` are unchanged; the `event` field is retained with the same enum values and semantics.

### `phase-complete`

Fires once per transition into a fully-closed phase (last open issue in the phase closes; `not_planned` closures count as done).

```json
{"type":"phase-complete","phase":"P1 — Foundation","epicRepo":"generacy-ai/generacy","epicNumber":885,"ts":"2026-07-09T14:23:11.041Z"}
```

- `phase` — the phase heading text, verbatim.
- After a reopen that regresses the phase, re-completion fires the event again.
- Empty phase (heading with `refs.length === 0`) never fires `phase-complete`. One stderr warning is emitted at watch startup instead: `cockpit watch: phase "<heading>" has no issue refs; treated as complete`.
- Issues in the `(no phase)` bucket are excluded from `phase-complete`.
- Phase-less epic (no phase headings) never fires `phase-complete`.

### `epic-complete`

Fires once when every ref in the epic is CLOSED, regardless of phase structure. Empty phases contribute nothing to the ref set, so they don't block the epic edge.

```json
{"type":"epic-complete","epicRepo":"generacy-ai/generacy","epicNumber":885,"ts":"2026-07-09T14:25:03.782Z"}
```

### Startup sweep

If per-issue state, a fully-closed phase, or a fully-closed epic is already the truth at watch start, the corresponding events fire immediately with `"initial": true` so consumers can distinguish "this just happened" from "this was already true when I attached":

```json
{"type":"issue-transition","ts":"…","repo":"o/r","kind":"issue","number":123,"from":null,"to":"active","sourceLabel":"phase:plan","url":"…","event":"label-change","labels":["phase:plan"],"initial":true}
{"type":"phase-complete","phase":"P1 — Foundation","epicRepo":"o/r","epicNumber":1,"ts":"…","initial":true}
{"type":"epic-complete","epicRepo":"o/r","epicNumber":1,"ts":"…","initial":true}
```

Per-issue startup-sweep semantics were introduced in #839; aggregate startup-sweep semantics in #885. Both are covered by the single shape above: `initial: true` on the first appearance.

### `--exit-on-epic-complete`

Boolean flag (default false). When set, watch drains stdout and exits `0` after emitting the `epic-complete` line. That line is guaranteed to be the final line ever written. Consumers on `stdin` see clean EOF after it.

```bash
generacy cockpit watch owner/repo#123 --exit-on-epic-complete | jq -c .
```

### Ordering within a poll cycle

When a single poll produces multiple events, ordering is deterministic:

1. All `issue-transition` events in existing order.
2. All `phase-complete` events in body order.
3. `epic-complete` last if firing.

This guarantees cause precedes effect (the last `issue-closed` is always visible before the `phase-complete` it triggered) and — with `--exit-on-epic-complete` — that `epic-complete` is the final line on stdout before the process exits.

### Payload discipline

`phase-complete` and `epic-complete` carry `epicRepo` and `epicNumber` for correlation. They do **not** carry `closedRefs`, `totalCount`, `suggestion`, or any per-issue field (`repo`, `kind`, `number`, `url`, `labels`, `sourceLabel`, `from`, `to`, `event`). Human-readable prose (celebration lines, next-step suggestions) is the watch plugin's responsibility, derived from the payload — not the engine's.

### Programmatic parsing

```ts
import { CockpitStreamEventSchema } from '@generacy-ai/generacy';

for await (const line of readLines(childStdout)) {
  const evt = CockpitStreamEventSchema.parse(JSON.parse(line));
  // switch on evt.type — full type narrowing available
}
```
