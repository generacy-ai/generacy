# Clarifications

## Batch 1 — 2026-08-27

### Q1: Blocked-refs persistence contract
**Context**: Assumption 3 says the blocked refs are "stored in a stage comment", and FR-007's re-arm monitor must later *machine-read* those refs to poll their closed state. But the stage comment is an edited-in-place status table, not an append-only machine-parseable artifact, and every existing machine-read comment contract in the codebase uses a dedicated HTML-marker comment (e.g. `<!-- generacy-cockpit:unanchored-findings -->`, `<!-- generacy-remediation-limit -->`). The choice determines the monitor's parse contract, dedup behavior across repeated blocks, and what survives if the stage comment is regenerated.
**Question**: Where should the engine persist the `on` refs so the re-arm monitor (and the operator) can reliably read them?
**Options**:
- A: Dedicated marker-stamped comment (e.g. `<!-- generacy-dependency-block -->` + a machine-parseable refs list); newest marker comment wins; stage comment may additionally mention the block for human readability
- B: Embed the refs inside the existing stage comment and have the monitor parse them out of the stage table
- C: Persist refs in the orchestrator's state store (Redis) keyed by issue, with the comment as human-readable display only

**Answer**: *Pending*

### Q2: Partial progress in the same increment as the blocked sentinel
**Context**: An implement increment can legitimately complete some tasks (e.g. scaffolding, tests-first) before hitting the dependency wall and emitting `SPECKIT_IMPLEMENT_BLOCKED`. Today the increment path WIP-commits and pushes before re-entering. If the engine pauses without committing, that work is stranded in a checkout that may be recycled; the ordering of commit-push vs. gate application must be pinned.
**Question**: When the blocked sentinel is present, should the engine commit and push any uncommitted work before applying the dependency gate, and may `SPECKIT_IMPLEMENT_PARTIAL` and `SPECKIT_IMPLEMENT_BLOCKED` coexist in the same increment (blocked wins control flow, partial counts recorded)?
**Options**:
- A: Yes to both — commit/push WIP (when there are changes) before pausing, and both sentinels may coexist with blocked taking precedence over the increment re-loop
- B: Commit/push WIP, but treat the two sentinels as mutually exclusive — if both appear, blocked wins and partial is ignored/logged
- C: Pause immediately without committing; the agent is responsible for committing before emitting the sentinel

**Answer**: *Pending*

### Q3: Definition of a "closed" dependency
**Context**: FR-007 re-arms "when all `on` refs are closed" via `gh issue view --json closed`. GitHub issues can be closed as *completed* or *not planned*, and an `owner/repo#N` ref may actually be a PR (closed-unmerged vs merged). A dependency closed as not-planned or a PR closed without merging usually means the blocker was abandoned — resuming implement may then re-block or produce wrong work, but holding the gate forever strands the issue.
**Question**: Which terminal states of a referenced issue/PR count as "dependency resolved" for re-arm purposes?
**Options**:
- A: Any closed state counts (simple `closed == true`, PRs included) — the resumed implement phase is responsible for re-checking and re-emitting the sentinel if the dependency wasn't actually delivered
- B: Only closed-as-completed issues and merged PRs count; closed-as-not-planned / closed-unmerged keep the gate held and are surfaced to the operator
- C: Any closed state re-arms, but a not-planned/unmerged close is flagged in the re-arm comment so the operator is alerted

**Answer**: *Pending*

### Q4: Bounding repeated block cycles
**Context**: The Design Notes say resuming re-enters implement, which "will re-check the dependency and either proceed or re-pause." A wrong or perpetually-open dependency ref could cycle blocked → resumed → blocked indefinitely, consuming a worker slot and CLI spend on every cycle. The sibling remediation loop was explicitly capped (`maxRemediations` + `waiting-for:remediation-limit`) for exactly this class of loop.
**Question**: Should repeated dependency-block cycles on the same issue be bounded, and what happens at the bound?
**Options**:
- A: Unbounded — each re-pause is a legitimate wait; the monitor only re-arms on ref closure, so cycles are naturally rare and no cap is needed
- B: Cap the number of blocked→resume cycles (small N); at the cap, escalate to a distinct operator gate instead of re-pausing silently
- C: Unbounded cycles, but dedupe the gate comment/labels so repeated blocks add no new noise, and log a warning with the cycle count

**Answer**: *Pending*

### Q5: Monitor behavior on unresolvable refs
**Context**: The re-arm monitor polls each ref's closed state. A ref can be permanently unresolvable (issue deleted, repo renamed, token lacks access, malformed ref that slipped through) or transiently unreadable (gh/network failure, rate limit). If unresolvable refs silently hold the gate, the issue strands invisibly — the exact failure mode this feature exists to eliminate.
**Question**: How should the monitor treat a ref whose closed state cannot be determined?
**Options**:
- A: Fail-safe — treat as still-open (gate stays held), log a warning each poll cycle, keep retrying indefinitely; operator uses cockpit advance as the manual override
- B: Distinguish transient vs persistent — retry transient errors quietly, but after N consecutive failures on the same ref surface an operator-visible escalation (comment or distinct label) while keeping the gate held
- C: Fail-open after N consecutive failures — treat the undeterminable ref as closed and re-arm, letting the resumed implement phase re-emit the sentinel if genuinely still blocked

**Answer**: *Pending*
