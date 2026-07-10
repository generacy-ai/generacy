# Clarifications

## Batch 1 — 2026-07-10

### Q1: Multiple closing-refs candidates
**Context**: FR-001 says "if exactly one such PR exists — return it directly" but is silent on the >1 case. `closingIssuesReferences` can in principle contain multiple open PRs (e.g. a duplicate fix opened alongside the primary; a re-opened PR alongside its replacement). The resolver's behaviour here determines whether the merge verb ever silently picks one of several authoritative candidates.
**Question**: When `closingIssuesReferences` returns more than one open PR, what should `resolveIssueToPRRef` do?
**Options**:
- A: Fail loud immediately as ambiguous (list all candidate PR numbers, exit non-zero, do NOT fall through to branch-name).
- B: Filter to non-draft PRs first; if exactly one non-draft remains, return it via `closing-refs`; otherwise fail loud as ambiguous.
- C: Fall through to the branch-name strategy (treat >1 closing-refs the same as zero — closing-refs only "counts" when unambiguous).
- D: Return the first (by PR number ascending / newest / etc.) with a warning log.

**Answer**: *Pending*

### Q2: Multiple branch-name candidates
**Context**: FR-002 says "the single open PR whose head branch begins with `<issue>-`" but does not define behaviour when multiple PRs match (e.g. an abandoned earlier attempt on `NNN-first-try` plus a live `NNN-do-it-properly`). Symmetry with Q1 matters — merge is the one irreversible verb.
**Question**: When more than one open PR has a head branch matching `^<issue>-`, what should `resolveIssueToPRRef` do?
**Options**:
- A: Fail loud immediately as ambiguous (list all candidate PR numbers + branch names, exit non-zero, do NOT fall through to pr-body).
- B: Filter to non-draft PRs first; if exactly one non-draft remains, return it via `branch-name`; otherwise fail loud.
- C: Fall through to the pr-body strategy (treat >1 branch-name the same as zero).
- D: Pick the newest by `createdAt` with a warning log.

**Answer**: *Pending*

### Q3: New reason enum values
**Context**: Today `buildFailingCheckPayload` accepts `reason: 'unresolved' | 'missing-label' | 'checks-failing'`. FR-003, FR-005 and FR-008 introduce three new failure modes that need distinct reasons so callers (auto-mode's finding recorder, `runMerge` tests, telemetry consumers) can distinguish them without string-matching human copy. The exact enum strings are load-bearing because they land in stdout JSON and in test fixtures.
**Question**: Which of the following reason strings should the payload enum gain?
**Options**:
- A: `'pr-is-draft'` (FR-005 draft rejection), `'ambiguous-body-mentions'` (FR-003 >1 non-draft body candidate), `'only-drafts-mention'` (FR-003 draft-only body candidates). Three new variants, spec's own copy verbatim.
- B: Single new variant `'unmergeable'` with a sub-field `subReason: 'draft' | 'ambiguous-body' | 'only-drafts'` — keep the top-level `reason` enum small.
- C: `'pr-is-draft'` + a single `'ambiguous-resolution'` that covers both ambiguity paths, distinguished only by the `candidates: number[]` field on the payload.
- D: Something else — specify below.

**Answer**: *Pending*

### Q4: Where `resolvedPr.number` and `linkMethod` land in the JSON payload
**Context**: FR-004 and FR-008 require every failure path (and the log line on success) to name the resolved PR number and its `linkMethod`. Today's payload has a `pr: { number, url } | null` field. `linkMethod` is new. Downstream consumers (auto-mode finding recorder in `tetrad-development`, cockpit tests) need to know exactly which key to read.
**Question**: What is the JSON shape for reporting the resolved PR + linkMethod on both success and failure?
**Options**:
- A: Extend the existing `pr` field to `pr: { number, url, linkMethod } | null`. Single field, no new top-level key.
- B: Keep `pr: { number, url } | null` unchanged; add a sibling top-level `linkMethod: 'closing-refs' | 'branch-name' | 'pr-body' | null`.
- C: Replace `pr` with `resolvedPr: { number, url, linkMethod } | null`; deprecate the old `pr` key.
- D: On ambiguous failures, replace scalar `pr` with `candidates: Array<{ number, url, isDraft }>` and set `linkMethod` to the strategy that produced the candidate set; on other failures use option A.

**Answer**: *Pending*

### Q5: `resolveIssueToPRRef` return type — how does `linkMethod` flow back to `runMerge`?
**Context**: Today `IGh.resolveIssueToPRRef` returns `PullRequestRef | null` (fields: `number, url, state, draft, headRefName`). `runMerge` needs `linkMethod` to (a) put in the log/stdout line (FR-004) and (b) route to `pr-is-draft` when appropriate (FR-005). Options for surfacing it back:
**Question**: How should `resolveIssueToPRRef` communicate `linkMethod` (and, for the ambiguous / only-drafts paths, the candidate list) to its callers?
**Options**:
- A: Add `linkMethod` (and optional `candidates: PullRequestRef[]`) to the `PullRequestRef` return type. Same shape on success; on ambiguity return `null` and let `runMerge` re-derive candidates.
- B: Change the return type to a discriminated union: `{ kind: 'resolved'; ref: PullRequestRef; linkMethod } | { kind: 'ambiguous'; candidates; strategy } | { kind: 'only-drafts'; candidates } | { kind: 'unresolved' }`. `null` retires.
- C: Keep `PullRequestRef | null` but throw a typed error class (`ResolveAmbiguousError`, `ResolveOnlyDraftsError`) for the loud-fail paths; on the happy path also attach `linkMethod` as an added field on `PullRequestRef`.
- D: Split into two methods — `resolveIssueToPR(...)` (happy path, returns `{ ref, linkMethod }`) and `describeIssuePrCandidates(...)` (called by `runMerge` only when needing to render an ambiguity payload).

**Answer**: *Pending*
