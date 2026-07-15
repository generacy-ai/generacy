---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/orchestrator": patch
"@generacy-ai/generacy": patch
---

Detect repeat-identical phase failures and escalate to artifact repair instead of retrying verbatim (#942).

A phase failure caused by a defective generated artifact used to fail forever:
the retry path re-ran the same phase against the same artifacts. On snappoll#8,
`implement` failed three times with a byte-identical reason (a self-contradictory
`tasks.md` kept tripping the `no-product-code-changes` post-exit check) and only
cleared after a 3-hour hand-implementation. Three verbatim-identical failures are
an unambiguous signal that retrying will not help — the inputs are wrong.

- `@generacy-ai/workflow-engine`: adds six `failed:<phase>-repeated` label
  definitions (`specify`, `clarify`, `plan`, `tasks`, `implement`, `validate`),
  applied when the same failure fingerprint fires ≥2×.
- `@generacy-ai/orchestrator`: fingerprints each phase failure (phase + reason)
  and tracks recurrence, so the phase loop stops retrying on the second
  identical failure and surfaces the distinct `failed:<phase>-repeated` state
  rather than looping. Non-identical failures retry as before.
- `@generacy-ai/generacy`: `cockpit resume` understands the repeated-failure
  state, so the operator is offered the artifact-repair path (repair/regenerate
  the upstream artifact with the failure reason as context) instead of a plain
  requeue that would reproduce the same failure.
