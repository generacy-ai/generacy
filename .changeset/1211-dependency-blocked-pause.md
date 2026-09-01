---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/orchestrator": patch
"@generacy-ai/cockpit": patch
---

Engine-native pause/resume for implement phases blocked on sibling issues (#1211).

Before this change, an implement agent that correctly declined to write code —
because a clarify answer told it to wait for a sibling issue to merge — hit the
no-progress guard and was reported as `failed:implement` + `agent:error`. The
`waiting-for:dependencies` label existed in the vocabulary but nothing read or
applied it. Every dependency block therefore cost an operator a mute, a manual
watch, and a `cockpit resume` — and each forced requeue rebased onto a moved
`develop`, generating conflict escalations of its own.

The implement agent can now emit a `SPECKIT_IMPLEMENT_BLOCKED: {"on": [...]}`
sentinel. The phase loop commits WIP, posts a `<!-- generacy-dependency-block -->`
marker comment carrying the canonical refs, and applies
`waiting-for:dependencies` via the normal gate path — a deliberate pause, not a
failure. A new `DependencyMonitorService` polls each blocked issue's refs and,
once all are closed, posts a re-arm comment, applies `completed:dependencies`,
and enqueues a `continue`. Refs closed as `not planned`, or PRs closed without
merging, are flagged with ⚠ in the re-arm comment; the resumed agent re-verifies
and can re-emit the sentinel if it is genuinely still blocked.

Runaway blocks are capped: three block cycles per grant escalate to
`waiting-for:dependency-limit` with a limit comment, and three consecutive
failures reading a ref post one escalation comment. Neither ever fails open —
the gate stays held.

- `workflow-engine` (minor): new label vocabulary (`completed:dependencies`,
  `waiting-for:dependency-limit`, `completed:dependency-limit`) and a new public
  `GitHubClient.getIssueRefState()` returning `state` / `state_reason` /
  `isPullRequest` / `merged`, plus the `IssueRefState` type.
- `orchestrator` (patch): blocked-branch handling in the phase loop, the
  `SPECKIT_IMPLEMENT_BLOCKED` sentinel parse, `dependency-block` helpers, the new
  monitor service, and the `dependencies` / `dependency-limit` gate entries. No
  new public exports.
- `cockpit` (patch): both new gates added to `WAITING_PIPELINE_ORDER`. The gate
  vocabulary derives from `WORKFLOW_LABELS`, so `cockpit advance --gate
  dependencies` and `--gate dependency-limit` work with no CLI change.

The path is inert unless the agent emits the sentinel; no feature flag, and no
change to existing PARTIAL handling or the no-progress guard.
