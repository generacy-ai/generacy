---
"@generacy-ai/generacy": patch
---

Fix `cockpit advance` stranding every issue it advances (#845).

`advance` previously added `completed:<gate>` and then removed
`waiting-for:<gate>`. But the orchestrator's poll-path resume detection requires
the label *pair*: a `completed:*` label whose matching `waiting-for:*` is absent
is treated as inconsistent and produces no resume event, so poll-only clusters
(fresh local deploys without webhook delivery) never resume advanced issues —
they sit at `{completed:<gate>, agent:in-progress, agent:paused}` indefinitely.

`advance` now posts the manual-advance marker and adds `completed:<gate>` only;
it no longer removes `waiting-for:<gate>`. Clearing `waiting-for:*`,
`completed:*`, and `agent:paused` on resume is owned by the worker, which already
does it. The idempotence and gate-mismatch checks are unchanged, and the
manual-advance comment wording is updated to reflect that `waiting-for:<gate>` is
left in place for the worker to clear on resume.
