---
"@generacy-ai/orchestrator": patch
---

Stop the address-pr-feedback flow from completing the `implementation-review` human gate without approval (#941).

When a fix session exited, the gate was marked `completed:implementation-review`
server-side regardless of whether the review's findings were actually resolved —
so request-changes verdicts were effectively advisory. During the snappoll run
this advanced the gate twice with no operator call and no
`<!-- generacy-cockpit:manual-advance -->` audit comment, letting a PR with three
known-blocking findings sail through validate.

- `PrFeedbackHandler` now re-asserts `waiting-for:implementation-review` on every
  terminal exit (happy path, both blocked-stuck dispositions, and thrown errors)
  via the shared `finally`, idempotently re-adding the label and logging a
  structured error if some other path stripped it. It runs *before* the
  `agent:in-progress` clear, so the terminal transient state is never
  `{ agent:in-progress present, waiting-for:implementation-review absent }`.
  A fix attempt that does not resolve the findings therefore lands back in
  review rather than past it.
- `LabelManager` gains a seam guard: writing `completed:<human-gate>` now
  requires an explicit `AllowGateComplete` token and otherwise throws
  `HumanGateCompletionUnauthorizedError`. The union has a single member
  (`cockpit-advance` — the path that also posts the manual-advance audit
  comment), so human gates stay attributable and no server-side path can
  silently complete one.
