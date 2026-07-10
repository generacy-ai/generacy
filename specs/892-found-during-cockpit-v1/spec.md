# Feature Specification: Found during the cockpit v1

**Branch**: `892-found-during-cockpit-v1` | **Date**: 2026-07-09 | **Status**: Draft

## Summary

Found during the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92), finding #43 — the design gap behind three P2 issues stranding at failed:validate, and the answer to the operator's question "perhaps we need something to request changes when validate fails?"

## Confirmed mechanism (empirical, not theorized)

christrudelpw/sniplink#8's validate red reproduces exactly: `next build` type-check fails with `Cannot find module '@/components/CopyButton'` — `CopyButton` is created by sibling #7, per the epic's own working convention ("where two issues share a component, one *creates* it and the other *reuses* it"). At validate time no sibling had merged, so the merge-preview (#864, confirmed present in the validate path) equaled the branch tip, and the import could not resolve. The same tree validates green the moment #7 is in main: re-running #6's validate on today's merge-preview passes 34/34 tests + build.

So this red class is **not a code defect and not agent-fixable**: an agent "requesting changes" on #8's branch cannot conjure #7's component — its best case is a no-op and its worst case is *duplicating the sibling's file*, manufacturing the very conflict the file-disjoint convention prevents. Nothing re-triggers validate when main advances, so the reds are permanent: the phase deadlocks with the dependency sitting un-merged behind a red of its own, and an auto run can never reach phase-complete.

## Proposal — split by red class

**(a) Re-validate on base advance (the fix for this class).** When a base branch advances (any sibling PR merges, external PR merges, or a direct push land a new head SHA), automatically resume every open speckit-workflow issue whose PR targets that base and is sitting at `failed:validate` (via the `cockpit resume` verb, filed separately): their merge-preview has changed, so the red is stale evidence. Scope is per (repo, base branch), not "epic membership" — the orchestrator does not maintain a membership construct, and re-validating a red whose preview didn't materially change is a cheap no-op that comes back red with the same evidence hash (feeding the existing bound). Natural idempotency key: one re-validate per (issue, new base SHA) — the queue's in-flight dedupe (#879) already collapses storms. Convergence property: dependency-ordered merges unlock dependents' re-validates one merge at a time, with no explicit ordering machinery — #7 merges → #8 re-validates green → #8 merges.

Trigger mechanism: poll the base-branch head SHA on the existing monitor cadence (~60s); a SHA change *is* the base-advance event, uniformly catching sibling merges, external PR merges, and direct pushes. Local clusters have no webhook infrastructure by design — the orchestrator is poll-based everywhere else. The new SHA is both the trigger and the natural re-arm dedupe key.

**(b) Bounded validate-fix cycle (the operator's ask, for genuine code reds).** A red that *persists on a fresh merge-preview* is a real defect. Mirror the merge-fixer/PR-feedback shape: one autonomous agent attempt on the branch with the failure evidence (stdout-inclusive, per the evidence finding) and the #883 termination discipline — the attempt must change the tree or stop; re-validate after push; still red → `failed:validate` + alert + human escalation (auto mode's existing gate). One autonomous attempt per distinct red (evidence hash), further attempts only via the escalation gate — same "the gate is the bound" rule as agency#392 Q3.

Evidence hash: SHA-256 of a structured extract — sorted `{failing_test_name | failing_module_path}` list plus first error line per failure, with ANSI escapes / timestamps / absolute paths / per-run identifiers normalized. Full stdout still flows into the fix prompt; the hash is identity, not payload. Collisions err safe: "same red" → no autonomous re-attempt → escalation.

Sibling-duplication guard: on-demand `gh pr diff --name-only` across every open PR targeting the same base branch (matching Q1's scope). Fix-cycle spawns are rare, so N small calls beat a cached manifest, and always-current matters here — the file-owning sibling may have opened a PR seconds ago and may sit in a different speckit phase (no phase-label filter).

Agent identity: fresh worker on the *same* role as the validate that produced the red — inherits `credentialRole`, tools, and prompt shell. The fix is workflow work on the workflow's own branch; a dedicated fixer role adds credential wiring for no security-boundary gain. Implementation shares the `PrFeedbackHandler` spawn→commit→push→re-check plumbing (same shape, different prompt/evidence source); observability comes from a distinct ledger/event tag, not a distinct identity.

Ordering note: (a) must run before (b) is judged — a fix cycle should only ever fire on a red that survived a current-base re-validate, or the agent will "fix" phantom integration reds.

## Regression tests

- Sibling merge → stuck failed:validate issues in the same epic re-arm exactly once for the new base SHA; green preview → completed:validate without agent involvement.
- Red persisting on fresh preview → exactly one fix-cycle attempt; tree-changing push → re-validate; unchanged tree → no retry, escalation.
- Fix cycle never creates a file that exists on any open sibling branch of the same phase (guard against sibling duplication).
- End-to-end: three cross-dependent siblings queued in parallel converge to all-merged with no human action beyond existing gates.


## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
