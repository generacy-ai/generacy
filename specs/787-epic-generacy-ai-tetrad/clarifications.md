# Clarifications — #787 `generacy cockpit watch` + `status`

## Batch 1 — 2026-06-26

### Q1: Epic scoping flag
**Context**: `resolveEpicIssues(epic, owner, repo, …)` in `@generacy-ai/cockpit`
requires an epic issue number. Neither verb currently has a documented way to
discover which epic(s) to scope to. `status` (FR-010) calls `resolveEpicIssues`
but the spec never says where the `epic` argument comes from; `watch` is silent
on whether it should filter to epic-scoped issues at all. Without a decision,
the entry point's flag surface and the per-repo enumeration loop cannot be
designed.
**Question**: How should `watch` and `status` determine which issues to
include?
**Options**:
- A: Require an `--epic <owner/repo#NNN>` flag on both verbs. Single-epic only;
  multiple invocations for multiple epics.
- B: Auto-discover every epic from `.generacy/epics/*.yaml` manifests, scope to
  the union of all manifest-listed issues. No flag needed; falls back to "all
  open issues across `cockpit.repos`" when no manifests are present.
- C: Take no epic argument; emit/snapshot every open issue and PR across
  `cockpit.repos` (epic membership is not a filter, just a grouping in
  `status` output).
- D: `--epic` flag *optional* on both verbs; when omitted, behave as option C
  (all repos), when present, scope to that single epic.

**Answer**: *Pending*

### Q2: `watch` event JSON shape
**Context**: FR-005 lists fields (`ts`, `repo`, `kind`, `number`, `from`, `to`,
`sourceLabel`, `url`) but does not pin types or semantics, and Assumptions
explicitly says "Confirm with the upstream Monitor-tool contract … during
/clarify." Consumers (the `Monitor` tool and any `jq`-based scripts) will
depend on a stable shape, so this must be locked before implementation.
**Question**: What are the exact types/semantics for each field, and how are
non-label transitions (issue OPEN→CLOSED, PR open→closed→merged) represented?
**Options**:
- A: `ts` = ISO 8601 string (`"2026-06-26T16:50:00.000Z"`); `from`/`to` are
  `CockpitState | null`; `sourceLabel` is the `ClassifyResult.sourceLabel`
  (the label that drove `to`), or `null` for state changes not driven by a
  label (e.g., the issue was closed). Add an optional `event` field with
  values `"label-change" | "issue-closed" | "pr-merged" | "pr-closed"` so
  consumers can distinguish.
- B: `ts` = epoch milliseconds (number); fields otherwise as A.
- C: `ts` = ISO 8601; treat OPEN→CLOSED as a transition to `terminal` with
  `sourceLabel: "<gh:state:closed>"` (synthetic sentinel string). No
  `event` field — every transition is shaped the same.
- D: Same as A but additionally include the **full label set** for the
  issue/PR at the time of transition (`labels: string[]`) so consumers can
  see context without a follow-up query.

**Answer**: *Pending*

### Q3: PR transition triggers
**Context**: `classify()` is label-based, but PRs have non-label state that an
operator likely cares about: draft↔ready-for-review flip, open→closed→merged,
and check-run roll-up flipping from `PENDING` to `SUCCESS`/`FAILURE`. FR-004
only says "classifies each issue's labels" — it does not say what counts as a
PR transition. This affects both the poll-loop diff logic and the SC-002
acceptance test ("100% of transitions in a 10-step manual phase walk").
**Question**: Which PR signals should `watch` treat as transitions and emit
on the stream?
**Options**:
- A: **Labels only.** PRs are classified by labels (same as issues); draft,
  merged, and check-run state are ignored. Simplest; matches the "labels are
  the source of truth" cockpit model.
- B: **Labels + lifecycle.** Labels (via `classify`) plus open→closed→merged
  emitted as separate transitions (e.g., `to: "terminal"` with
  `event: "pr-merged"`). Draft↔ready and check-runs ignored.
- C: **Labels + lifecycle + check-runs roll-up.** Adds emissions when the
  aggregate check-run state flips (PENDING → SUCCESS / FAILURE). Each
  check-run transition is one line; per-check granularity is excluded.
- D: **Labels + everything signal-bearing.** A, B, C plus draft↔ready
  flip emitted as its own transition.

**Answer**: *Pending*

### Q4: `status` human-readable rendering
**Context**: FR-013 says "human-readable table by default." The codebase
already pulls in chalk-like helpers in other CLI commands and does not
currently depend on `cli-table3`. Picking a rendering approach affects the
package's dependency footprint, terminal-width handling, color use (which the
project's CLI commands have been inconsistent about), and how tests assert
on output.
**Question**: How should `status` render its default human-readable table?
**Options**:
- A: Plain text, column-aligned with `padEnd`; no color; no new
  dependencies. Easiest to test (string equality) and grep.
- B: `cli-table3` for box-drawing borders + `chalk` for state colors
  (`error` red, `waiting` yellow, `active` cyan, `terminal` green,
  `pending`/`unknown` dim). New deps; pleasant to read.
- C: Plain text, column-aligned, but with ANSI colors via `chalk` (already
  transitively available). No box-drawing; auto-disable color when stdout
  is not a TTY.
- D: Defer styling decisions to a later PR: ship a single-line-per-issue
  format ("`#NNN  phase:plan  active  PR #M ✓3/0`") with no library and no
  color. Iterate on layout once an operator has used it.

**Answer**: *Pending*

### Q5: Repo enumeration scale and pagination
**Context**: `GhCliWrapper.listIssues` defaults to `--limit 100`. SC-001 only
benchmarks a 25-issue epic, but a cluster with multiple active epics across
several monitored repos could blow past 100 open items per repo. If `watch`
silently caps at 100, a transition on the 101st issue is never reported —
violating "every transition produces exactly one line." This also affects
SC-006 (60-s outage soak) because pagination amplifies request cost.
**Question**: What's the scale contract — should the verbs paginate, and what
limits do they advertise?
**Options**:
- A: **No pagination in v1.** Pass `--limit 100` per repo; document the
  cap in `--help` and warn on stderr when a repo returns exactly 100 items
  ("possible truncation; raise this issue if you hit it"). Pagination is a
  follow-up.
- B: **Paginate transparently.** Loop `gh search issues … --limit 100` with
  a cursor / `created:<` window until exhausted. No documented cap. More
  gh calls per poll cycle, but no truncation risk.
- C: **Configurable cap.** Add `--limit <n>` flag (default 100, hard max
  500) on both verbs. No automatic pagination; explicit operator choice.
- D: **Cap at 100, fail fast.** If any repo hits exactly 100 results,
  `watch`/`status` exit non-zero with "epic exceeds v1 scale limit; split
  the epic." Forces a config response rather than silent truncation.

**Answer**: *Pending*
