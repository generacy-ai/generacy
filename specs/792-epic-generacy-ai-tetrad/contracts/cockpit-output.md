# Contract: Cockpit Output Shapes

Stable byte-level output that downstream consumers (humans, jq, #787 watch consumers) depend on. Any future change must bump a version field or add a new event type — never mutate these in place.

## A. `generacy cockpit status` table footer (stdout, ASCII, no color)

Exactly one line appended below the table, separated by a newline.

| State | Output (literal) |
|---|---|
| Available | `orchestrator: <N> jobs, <M> active workers` |
| No token | `orchestrator: (no token; set ORCHESTRATOR_API_TOKEN to enable)` |
| Unavailable | `orchestrator: (unavailable — <reason>)` |

Where `<N>` and `<M>` are non-negative integers (decimal, no thousands separator). `<reason>` is one of `cloud-unreachable`, `http-error`, `timeout`, or `unknown`. Em-dash is U+2014.

## B. `generacy cockpit status --json` envelope

Single line, JSON, terminated by `\n`. Adds an `orchestrator` field to the existing `StatusEnvelope`:

```jsonc
{
  "scope": { "kind": "epic", "owner": "...", "repo": "...", "issue": 123 },
  "rows": [...],
  "orchestrator":
    | { "available": true,  "jobs": <int>, "workers": <int> }
    | { "available": false, "reason": "no-token" | "cloud-unreachable" | "http-error" | "timeout" | "unknown" }
}
```

- `workers` is the **count** (not a list).
- Field name `workers` is preserved (do not rename to `activeWorkers`) — JSON consumers added in #787 expect this name.
- The `available: false` branch never carries `jobs` or `workers`.
- Reason strings outside the enum above MUST be normalized to `"unknown"` by the writer.

## C. `generacy cockpit watch` NDJSON event

A new event type. Existing `CockpitEvent` lines (label-change, pr-checks, etc.) are unchanged. Emit cadence per `data-model.md §5` state machine.

**Schema (zod, lives in `watch/orchestrator-counts.ts`)**:

```jsonc
// available branch
{ "type": "orchestrator-counts", "jobs": <int>, "workers": <int> }

// unavailable branch
{ "type": "orchestrator-counts", "available": false, "reason": "no-token" | "cloud-unreachable" | "http-error" | "timeout" | "unknown" }
```

- One baseline line at startup (always emitted, even if the orchestrator is unreachable — the baseline communicates "I tried").
- After baseline, emit only when state changes:
  - Available→available: emit iff `jobs` or `workers` changed.
  - Available→unavailable, unavailable→available, unavailable→unavailable with different `reason`: emit.
  - Unavailable→unavailable with same `reason`: silent.
- Validation runs by default (mirrors `CockpitEventSchema` pattern). `skipValidate` available as escape hatch.
- Written via a single `process.stdout.write` (no `console.log`).

## D. Stderr warnings

Written at most **once per CLI invocation**, only when the orchestrator transitions from reachable→`cloud-unreachable`/`http-error` (timeout is included). One line, terminated by `\n`:

```
cockpit: orchestrator unavailable: <reason>
```

`<reason>` is the raw enum value. No timestamp, no color.

- Suppressed for `reason === 'no-token'` (that state is already explicit in the footer / event and is not a runtime failure).
- Suppressed for any subsequent failure in the same invocation.
- The stdout JSON envelope / NDJSON stream is never affected by this warning.

## E. Exit codes

All orchestrator-related conditions return exit `0` for both `status` and `watch`. The cockpit's own GH-failure exit codes (e.g. `watch` exit `3` on poll error) are unchanged.
