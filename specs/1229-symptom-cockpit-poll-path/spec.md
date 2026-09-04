# Feature Specification: Scope cockpit poll events to the epic's resolved ref set

**Branch**: `1229-symptom-cockpit-poll-path` | **Date**: 2026-09-04 | **Status**: Draft
**Issue**: [generacy#1229](https://github.com/generacy-ai/generacy/issues/1229) | **Type**: Bug

## Summary

The cockpit poll path (`packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts`)
emits `issue-transition` events for issues that are **not in the epic's resolved scope**. A
`/cockpit:auto` run therefore dispatches on other epics' issues (spurious dispatch), acting
on work it does not own.

Root cause: `queryForRepo` builds a `gh search issues` query of the form
`repo:<owner/repo> <number> <number> …`, where bare numbers are **full-text search terms**.
GitHub returns the issue with that number *and* every issue whose title/body merely mentions
it. Those foreign results are snapshotted into `curr`, diffed by `computeTransitions` with no
ref-set membership filter, and published unfiltered onto the epic event bus
(`event-bus-registry.ts`). `auto.md` invariant #7 forbids the consuming session from
filtering the stream, so the session acts on whatever arrives.

Measured against `Painworth/doc-intel` (2026-09-03):
- `gh search issues repo:Painworth/doc-intel 120` → 6 issues; only `#120` is the ref, the
  other 5 match on body text.
- Epic `#93`'s real query (`47 48 97 98 99 100 101 102 103 104 105`) returned
  `93, 97..105, 135` — foreign epic `#135` leaks in.

Second, distinct defect in the same function: `gh search issues` implies `is:issue`, so **PR
refs listed in an epic body are never returned by the poll path**. The PR-handling code in
`runOnePoll` (`buildPrSnapshot`, `derivePrChecksNeeded`, `derivePrLifecycle`, the
`isPullRequest(issue)` branch) is therefore dead on the poll path — PR lifecycle/checks
events only ever arrive via the smee source.

Aggregate/phase accounting is unaffected: `aggregate.ts` keys off `parsed.allRefs`, not
`curr`. This is a spurious-dispatch bug, not a wrong-completion bug — but spurious dispatch
means acting on another epic's issue, which is a correctness and safety problem for
`/cockpit:auto`.

## User Stories

### US1: Poll events stay inside the epic's scope (Primary)

**As an** operator running `/cockpit:auto` on an epic,
**I want** the poll path to emit transition events only for issues in that epic's resolved
ref set,
**So that** the automated session never dispatches on another epic's issues.

**Acceptance Criteria**:
- [ ] An issue that merely *mentions* an in-scope number (matching only via free-text
      search) never produces a snapshot or event.
- [ ] An in-scope issue that genuinely transitions still produces its event.
- [ ] The scope restriction is enforced structurally — either by post-filtering `curr`
      against the resolved ref set, by a query form that cannot match on free text, or both.
      A query-only fix must be pinned by a test proving out-of-scope results are dropped.

### US2: PR refs are handled correctly and unambiguously

**As a** maintainer of the cockpit watch subsystem,
**I want** PR refs from an epic body to either be polled through a path that actually returns
PRs, or the dead PR branch removed with smee-only sourcing documented,
**So that** the poll path has no silently dead code and PR event sourcing is understood.

**Acceptance Criteria**:
- [ ] The resolution for PR refs (poll them properly vs. remove the branch + document
      smee-only sourcing) is decided in `/clarify` and reflected in code + docs.
- [ ] No dead PR-handling branch is left undocumented on the poll path.

### US3: No regression in GitHub API budget

**As an** operator whose cockpit is already the rate-limit hot spot (generacy#970),
**I want** the fix to add no GitHub API calls per poll cycle,
**So that** scoping correctness does not trade off against rate-limit exhaustion.

**Acceptance Criteria**:
- [ ] The number of GitHub API calls per poll cycle does not increase relative to current
      behavior.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Snapshots and events MUST be restricted to the epic's resolved ref set; an out-of-scope issue returned by search MUST NOT produce a snapshot or event. | P1 | Structural enforcement (post-filter `curr`, non-free-text query, or both). |
| FR-002 | An in-scope issue that transitions MUST still emit its event. | P1 | No false negatives from the new filter. |
| FR-003 | The PR-ref handling on the poll path MUST be resolved: either PR refs are polled through a path that returns PRs, or the PR branch is removed and smee-only PR-event sourcing is documented. | P1 | Decision deferred to `/clarify`. |
| FR-004 | The fix MUST NOT increase the number of GitHub API calls per poll cycle. | P1 | generacy#970 — poll path is rate-limit hot spot. |
| FR-005 | A test MUST prove out-of-scope search results are dropped; a test MUST prove an in-scope issue is emitted; a test MUST cover the chosen PR-ref resolution. | P1 | Query-only fixes require the out-of-scope drop test specifically. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Out-of-scope issues emitted per poll cycle | 0 | Unit test with a search result that matches only on free text; assert no event. |
| SC-002 | In-scope transition events preserved | 100% | Unit test asserting a genuine in-scope transition still emits. |
| SC-003 | GitHub API calls per poll cycle | ≤ current baseline | Compare call count in poll cycle before/after. |
| SC-004 | Dead code on poll path | 0 undocumented dead branches | Code review + docs reflecting PR-ref resolution. |

## Assumptions

- The epic's resolved ref set (`deps.refs` / `parsed.allRefs`) is authoritative for scope
  membership at poll time.
- `aggregate.ts` phase accounting is correct and out of scope for this fix (keys off
  `allRefs`, not `curr`).
- The `/cockpit:auto` consuming session must not filter the stream (`auto.md` invariant #7),
  so filtering must happen at or before event emission.

## Out of Scope

- The answers-file leak tracked in the sibling issue (independent of this defect).
- Changes to aggregate/phase completion accounting.
- Changes to the smee event source, beyond documenting its role if PR-ref polling is removed.
- Broader rate-limit optimization work under generacy#970.

---

*Generated by speckit*
