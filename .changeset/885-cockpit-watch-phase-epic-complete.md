---
"@generacy-ai/generacy": minor
---

Emit synthetic `phase-complete` / `epic-complete` events from `cockpit watch` (#885).

`cockpit watch` now derives two NDJSON events from the snapshot diff it already
computes: `phase-complete` fires once each time the last open issue in a phase
transitions to closed (state-dominates-labels per #873; `not_planned` counts as
done, and a reopen→regress→re-complete fires it again), and `epic-complete` fires
when every phase is complete. `(no phase)` issues are excluded from
`phase-complete` but counted toward `epic-complete`. A startup sweep emits
already-complete phases with `initial: true`. The new `--exit-on-epic-complete`
flag makes watch emit `epic-complete` and exit 0 — the termination edge auto mode
needs (default behavior unchanged). The event contract is documented in the
package README.
