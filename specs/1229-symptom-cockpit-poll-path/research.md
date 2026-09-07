# Research: Scope cockpit poll events to the epic's resolved ref set

## D1: Exact-lookup query form — aliased GraphQL `issueOrPullRequest(number:)`

**Decision**: Replace `gh search issues repo:<r> <n> <n> …` with one batched aliased
GraphQL call per repo: `rI: issueOrPullRequest(number: N) { … }` with inline fragments for
`Issue` and `PullRequest`.

**Rationale**:
- GitHub search has **no exact issue-number qualifier**; bare numbers are free-text terms.
  Measured 2026-09-03 against `Painworth/doc-intel`: `repo:Painworth/doc-intel 120`
  returned 6 issues (5 body-text matches); epic #93's real query leaked foreign epic #135.
  Only an exact lookup structurally cannot match free text (clarify Q2=C).
- `gh search issues` implies `is:issue`; `issueOrPullRequest` returns both node types,
  which is exactly what reviving the poll path's PR branch requires (clarify Q1=A).
- The aliased-batch pattern already exists in `packages/cockpit/src/gh/wrapper.ts`
  (`buildTier1FollowupQuery` :413, `tier1FollowupOnce` :1192): dynamic aliased selections,
  `gh api graphql -F owner= -F repo= -f query=`, zod envelope validation,
  `formatShapeMismatchError` diagnostics. We mirror it rather than invent a new transport.

**Alternatives considered**:
- *Post-filter only, keep search* (Q2 option A): zero new code in `packages/cockpit`, but
  keeps over-fetching, keeps the `is:issue` PR blindness (fails FR-003), and keeps
  paginated `listAllIssues` calls. Rejected by clarify Q2=C.
- *REST `search/issues` without `is:issue`*: still free-text matching — fails the
  structural requirement.
- *Per-number `gh issue view` / `gh pr view`*: N calls per repo per cycle — violates the
  budget freeze (FR-004) at any nontrivial epic size.

## D2: Defensive post-filter placement — before snapshotting, shared helper

**Decision**: `filterToRefSet(issues, repo, refs)` in a new
`packages/generacy/src/cli/commands/cockpit/shared/ref-set-filter.ts`, applied in
`runOnePoll` to the fetched list *before* the snapshot loop, and in `status.ts` to the
`listAllIssues` results.

**Rationale**:
- FR-001 requires the filter as defence-in-depth even with the exact lookup ("both").
- `curr` is built exclusively from the fetched list, so filtering the list is equivalent to
  post-filtering `curr` — and it additionally short-circuits the per-PR fetches
  (`getPullRequest`, check-runs) for anything out of scope, protecting the API budget in
  the failure mode the filter exists for.
- Membership key uses `repo.toLowerCase()#number`, matching `snapshotKey`'s #1106
  lowercase-repo normalization, so operator-cased epic-body refs and GitHub-canonical repo
  strings cannot miss.
- `status.ts:83` builds the same free-text query; the shared helper fixes it without an
  independent implementation (FR-001 note). Status keeps its search query — it is a
  one-shot command, not the poll hot spot, and switching it to exact lookup would change
  its PR visibility, which the spec leaves out of scope.

## D3: PR state mapping — `MERGED → CLOSED`, lifecycle stays in `derivePrLifecycle`

**Decision**: The wrapper maps GraphQL `PullRequest.state` `OPEN|CLOSED|MERGED` into the
existing `Issue.state` union (`OPEN|CLOSED`) with `MERGED → CLOSED`; `stateReason: null`
for PRs.

**Rationale**: `Issue` is the established currency of the poll path (`snapshot.ts`
`Pick<Issue, …>`), and merged PRs already surface as closed from search today. Merged
detection is owned by `derivePrLifecycle` (D5 gating) via `getPullRequest`, which is
untouched. Widening `Issue.state` would ripple through every consumer for no behavioral
gain.

**Note**: Issues gain a real `stateReason` (GraphQL provides it; `gh search issues --json`
cannot — see wrapper.ts:838 comment). `diff.ts` never compares `stateReason`, so no new
event class appears; `status` rendering gets strictly better data.

## D4: Missing-ref tolerance — accept NOT_FOUND partial data, reject everything else

**Decision**: On non-zero `gh api graphql` exit, parse stdout; if a valid GraphQL envelope
whose `errors` are all `type: "NOT_FOUND"`, use the partial `data` (missing refs are
absent). Anything else throws.

**Rationale**: Epic bodies can reference deleted/transferred/never-created issues;
`issueOrPullRequest` then returns `null` for that alias plus a NOT_FOUND error entry, and
`gh` exits 1 while still printing the body. A poll path that hard-fails on one stale ref
would starve the whole epic of events. Conversely, swallowing *all* errors would mask auth
or rate-limit failures — those must surface to `runPollLoop`'s per-cycle catch.

**Alternatives**: pre-validating refs with extra calls (budget violation); retry-once like
`tier1FollowupOnce` (unnecessary — the poll loop is itself the retry).

## D5: Chunking — ≤100 aliases per call

**Decision**: Chunk numbers at 100 per GraphQL call.

**Rationale**: With `labels(first: 100)` per alias, 100 aliases ≈ 10k requested nodes —
comfortably under GitHub's 500k node and complexity limits, while keeping "one call per
repo" literally true for every realistic epic (largest observed epics are well under 100
refs). Chunking is a correctness backstop, not an expected path; the budget test pins the
1-call common case.

## D6: `PollDeps` slimming

**Decision**: Remove `safetyCap`, `pageSize`, `epicOwnerRepo` from `PollDeps`.

**Rationale**: All three existed to serve the search+pagination shape: page size and safety
cap bound an unbounded search, and `epicOwnerRepo` was only the target of the zero-refs
sentinel query (`cockpit-no-match-sentinel`). Exact lookup is structurally bounded by the
ref set and zero refs now means zero calls, so all three are dead weight; leaving dead
required/optional params on the poll seam contradicts SC-004's no-dead-code goal. The
compiler drives the four call-site updates.

## Key sources

- `packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts` (`queryForRepo`,
  `runOnePoll`)
- `packages/generacy/src/cli/commands/cockpit/status.ts:83` (same free-text query)
- `packages/cockpit/src/gh/wrapper.ts` (`listIssues` :831, `buildTier1FollowupQuery` :413,
  `tier1FollowupOnce` :1192, `Issue` :9)
- `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts` (`runRealCycle` —
  sole feed of `cockpit_await_events`)
- `packages/generacy/src/cli/commands/cockpit/__tests__/cockpit-graphql-budget.integration.test.ts`
  (pinned per-PR bounds)
- `specs/913-found-during-cockpit-v1/contracts/graphql-selection-set.md` (aliased-selection
  contract precedent)
- Clarify record: `specs/1229-symptom-cockpit-poll-path/clarifications.md` (Q1=A, Q2=C,
  Q3=A)
