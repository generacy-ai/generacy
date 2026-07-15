---
"@generacy-ai/cockpit": patch
---

Classify `blocked:stuck-merge-conflicts` / `blocked:stuck-validate-fix` as error-tier instead of surfacing them as unrecognized state (#943).

`blocked:stuck-merge-conflicts` — applied by the orchestrator's merge-conflict
handler when its auto-remedy gives up — had no tier in the cockpit classifier,
so it reached consumers as an *unrecognized state*. During the snappoll auto run
that produced 3 unrecognized-state escalations, each interrupting the operator
with a generic "never guess" gate instead of the specific merge-conflict
escalation that already exists for `waiting-for:merge-conflicts`.

- `classify()` now maps an enumerated set of `blocked:*` labels
  (`blocked:stuck-merge-conflicts`, `blocked:stuck-validate-fix`) to the `error`
  tier, with the blocked label as `sourceLabel`. The set is enumerated rather
  than prefix-matched on purpose: any other `blocked:*` name — including
  `blocked:stuck-feedback-loop` (#883) and future additions — still falls
  through to the waiting prefix branch, preserving today's behavior as the safe
  default.
- Adds an intra-error tie-break (`ERROR_PIPELINE_ORDER`) so those blocked labels
  outrank `agent:error` / `failed:*` and co-occurring `waiting-for:merge-conflicts`,
  letting consumers dispatch to the specific escalation gate. The full label set
  remains available on the classified state for consumers wanting the generic
  signal.
