# Clarifications

## Batch 1 — 2026-07-07

### Q1: GH_USERNAME env var in chain
**Context**: The orchestrator's `services/identity.ts` (lines 48–61) consults **two** env vars in order — `CLUSTER_GITHUB_USERNAME` first, then `GH_USERNAME` — before falling back to `gh api /user`. The spec's Summary references "`CLUSTER_GITHUB_USERNAME` (and `GH_USERNAME`)" but FR-001 only names `CLUSTER_GITHUB_USERNAME`. This affects both the helper's implementation and the failure-message wording required by SC-004.
**Question**: Should the cockpit identity helper also consult `GH_USERNAME` (as a tier-2b fallback between `CLUSTER_GITHUB_USERNAME` and `gh api user`), matching identity.ts precedence exactly? If yes, must the loud error message (FR-002) and warning (FR-003) also name `GH_USERNAME`?
**Options**:
- A: Yes — mirror identity.ts exactly: precedence is flag/config → `CLUSTER_GITHUB_USERNAME` → `GH_USERNAME` → `gh api user`. Error/warning messages name both env vars.
- B: Yes to precedence, but error/warning only name `CLUSTER_GITHUB_USERNAME` (canonical) to keep the message short.
- C: No — cockpit consults only `CLUSTER_GITHUB_USERNAME`. Divergence from orchestrator is intentional (cockpit runs on the operator's shell, not the cluster).

**Answer**: *Pending*

### Q2: `cockpit.assignee` config key scope
**Context**: FR-001 lists tier 1 as "`--assignee` flag / `cockpit.assignee` config", and the Assumptions section notes the config key "exists (or can be added)". A grep against `packages/generacy/src/cli/commands/cockpit/**` shows no current reader for `cockpit.assignee` — the key does not yet exist. Adding a new config surface expands scope beyond the bug fix; dropping it simplifies but diverges from the FR-001 wording.
**Question**: Is adding a `cockpit.assignee` config key in scope for this fix?
**Options**:
- A: Yes — add `cockpit.assignee` as a new config key (specify which file — e.g., `.generacy/config.yaml` under a `cockpit:` block) and thread it into the helper.
- B: No — drop `cockpit.assignee` from tier 1. Tier 1 is `--assignee` flag only. Track adding the config key as a follow-up issue.
- C: Defer — helper accepts an optional `configAssignee` parameter today (unused). Adding the config plumbing happens in a separate PR.

**Answer**: *Pending*

### Q3: Tier-1 sub-precedence (flag vs config)
**Context**: Only relevant if Q2 keeps `cockpit.assignee` config in tier 1. When both `--assignee <login>` (CLI flag) and `cockpit.assignee` (config) are set, one must win. FR-001 says "explicit `--assignee` flag / `cockpit.assignee` config" (single tier) without ordering. The Acceptance Criteria for US1 says "Existing precedence — explicit `--assignee` flag / `cockpit.assignee` config wins over env — is preserved" — again silent on flag-vs-config order.
**Question**: When both `--assignee` flag and `cockpit.assignee` config are present, which wins?
**Options**:
- A: Flag wins (standard CLI convention — explicit invocation overrides persistent config).
- B: Config wins (project-pinned identity should not be silently overridden).
- C: Error — reject conflicting inputs and instruct the operator to pick one.
- D: N/A — Q2 answered B or C (config not in scope this cycle).

**Answer**: *Pending*

### Q4: FR-006 investigation deliverable
**Context**: FR-006 (P2) asks the implementer to "Verify the smee-receiver's no-assignee skip path aligns with the orchestrator's `webhooks.ts` guard … Document divergence or file a follow-up issue if they disagree." The "file a follow-up issue" branch is clear. The "document divergence" (or "document no-divergence") branch has no defined location.
**Question**: If the investigation finds no divergence — or documents actual divergence without filing an issue — where should the finding be recorded?
**Options**:
- A: A `research.md` (or dedicated `fr-006-notes.md`) file under `specs/830-found-during-cockpit-v1/` in this repo.
- B: A comment on this GitHub issue (#830), tagged as "FR-006 investigation".
- C: An addition to the spec's Assumptions section (append a line summarising the finding).
- D: A new follow-up GitHub issue in every case (even "no divergence" — as a "verified: no action needed" note) so the check is discoverable.

**Answer**: *Pending*
