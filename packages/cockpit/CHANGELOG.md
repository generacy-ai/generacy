# @generacy-ai/cockpit

## 0.4.0

### Minor Changes

- 0b3d72c: Cockpit dynamic scope — live task-list membership, `scope add` verb, single-issue queue, and non-epic tracking issues as scope (#935).

  Reframes "scope" as any task-list-bearing issue, so both mid-epic ad-hoc work
  and epic-less stabilization runs drive the same file→process→merge loop.

  - `@generacy-ai/cockpit`: `resolveEpic` and the resolver accept a plain
    task-list-bearing tracking issue as the scope ref (no epic marker required).
    The per-poll re-resolution is pinned as a contract: a ref appended to the
    scope issue's task list mid-subscription joins the monitored set within one
    poll cycle and emits an observable first-sight `issue-transition` event
    (rather than a silent snapshot join); removing a ref stops monitoring and
    emits nothing retroactive. Registry isolation (distinct scope refs → distinct
    event buses, no cross-delivery) is made load-bearing with a test.
  - `@generacy-ai/generacy`: adds `cockpit scope add <scope-ref> <issue-ref>`
    (CLI verb + `cockpit_scope_add` MCP tool, with a matching `cockpit_scope_remove`)
    — a concurrency-safe task-list append (re-read + append + verify) that keeps
    body-format knowledge engine-side and returns a typed result. `cockpit queue`
    gains an issue-level form (`--issue <issue-ref>` / MCP param) that assigns the
    cluster account and applies the `process:<workflow>` label for a single issue
    with no phase membership required.

### Patch Changes

- Updated dependencies [92ca0b4]
  - @generacy-ai/config@0.4.0

## 0.3.0

### Minor Changes

- 19e6344: Add the `@generacy-ai/cockpit` foundation library for the Generacy Epic Cockpit (#786).

  Ships the building blocks consumed by the cockpit UI and orchestration layer:
  state classifier and label→state map, config loader and schema, epic manifest
  (io/schema/scoping), a `gh` CLI wrapper, and an orchestrator client (http/stub).

- 4af02da: Add `generacy cockpit watch` and `generacy cockpit status` verbs (#787).

  `watch` polls the epic's issues/PRs and emits structured cockpit events on state
  transitions; `status` renders a grouped, colorized table of the epic's current
  phase/state. Backed by shared scoping, pagination, issue-classification, and
  `gh` wrapper helpers in `@generacy-ai/cockpit`.

- Add `generacy cockpit state`, `cockpit advance`, and `cockpit clarify-context` verbs (#788).

  `state` classifies one issue and prints its curated cockpit tier; `advance`
  manually flips a waiting gate (waiting-for → completed); `clarify-context`
  gathers JSON context for the open clarification request. Also export
  `nodeChildProcessRunner` (and its `CommandRunnerOptions`/`CommandResult` types)
  from `@generacy-ai/cockpit` so CLI verbs reuse the foundation's default
  `CommandRunner` instead of importing `node:child_process` directly.

- Add `generacy cockpit merge` and `cockpit review-context` verbs (#789).

  `merge` resolves an issue to its PR and squash-merges once the required checks
  are green and the `completed:validate` gate is present; `review-context` gathers
  JSON context (PR detail + diff + failing checks) for a review. The foundation
  `@generacy-ai/cockpit` gh wrapper gains `resolveIssueToPRRef`,
  `getPullRequestDetail`, `mergePullRequest`, and `getRequiredCheckNames` (plus the
  `PullRequestRef`, `PullRequestDetail`, `MergeResult`, and `RequiredChecksResult`
  types). The richer PR-resolution verbs use distinct method names so they coexist
  with the watcher's lightweight `resolveIssueToPR`/`getPullRequest`.

- ae01213: Delete the dead cockpit orchestrator/journal subsystems (#805, S1).

  Removes the orchestrator API client (`packages/cockpit/src/orchestrator/**` —
  client, http, stub) and its exports (`createOrchestratorClient`, `OrchestratorClient`,
  health/jobs/workers types), journal liveness (`journal.ts`, `readJournalLiveness`,
  `StuckReason`, `JournalLivenessResult`), and the confirmed-dead `appendChildIssue`
  export from `manifest/io.ts`. Drops `stuck`/`recovered` from the watch event model
  and `CockpitEventSchema` (fixing the producer/schema drift), and removes
  `orchestrator.*` and `stuckThresholdMinutes` from the config schema.

  On the CLI side (`@generacy-ai/generacy`), `generacy cockpit status` loses the
  orchestrator footer line and `generacy cockpit watch` loses the orchestrator
  counts line, along with the now-unused orchestrator token/warn/footer helpers.

- c909706: Single-source epic discovery from the epic issue body (#806).

  Replaces the two-tier manifest + label-search discovery with one mechanism: a
  resolver in `@generacy-ai/cockpit` (`resolveEpic`) that parses the epic issue
  body — `owner/repo#N` task-list refs (`- [ ]` / `- [x]`) grouped under
  `### <phase>` headings, plus markdown-linked and plain-URL variants — and fails
  loud with the expected format when nothing parses. Refs are re-resolved every
  poll tick so children added mid-epic join automatically.

  On the CLI side (`@generacy-ai/generacy`), `generacy cockpit watch`/`status`
  scope by `--epic` only (the `--repos` flag is dropped; the repo set derives from
  the resolved refs), and `generacy cockpit queue <epic-ref> <phase>` reads its
  membership from the matching phase heading (`--label` overrides the default
  `process:speckit-feature`). Removes the manifest read path and label-search
  fallback (`resolveEpicIssues`), the `manifest init`/`sync` verbs and
  `manifest/**` subcommand files, `repos` from the cockpit config schema, and the
  `MONITORED_REPOS` coupling.

  Because the cockpit no longer configures a monitored-repo list, the
  `cockpit advance` / `state` / `clarify-context` commands no longer accept a
  bare issue number (it was resolved against the configured repo); pass a
  repo-qualified `<owner>/<repo>#<n>` ref or a full issue/PR URL instead.

- 8e08521: Collapse the cockpit CLI surface to the rev 3 catalog (#807, S3). Merges the
  `state`, `clarify-context`, and `review-context` verbs into a single
  `generacy cockpit context <issue>` verb that classifies the issue's current gate
  and emits the bundle that gate needs (clarification comment + spec/plan + code
  refs for clarification; PR metadata + diff + checks for
  implementation-review/merge preflight; artifact paths for spec/plan/tasks
  review). Folds the CLI-local `gh-ext.ts` (`CockpitGh`) into the engine's single
  `@generacy-ai/cockpit` gh wrapper and collapses the three ref/scope resolvers
  (`shared/scoping.ts`, `shared/resolve-context.ts`, `issue-ref.ts`) into one
  module. `advance` and `merge` behavior and the exit-code convention
  (0 success / 1 gh-IO / 2 usage / 3 gate refusal) are unchanged.
- 0d15fa9: Make the shared issue→PR resolver authoritative and loud, so `merge` never targets a draft sibling or a coincidentally-mentioned PR (#904).

  Surfaced by the cockpit v1.5 auto-mode smoke test: `cockpit merge` resolved an
  issue to a **draft sibling PR** (via a `pr-body` mention scan across P3 bodies
  that cross-reference sibling issues), then failed downstream with a nameless
  `gh pr merge failed: still a draft`.

  `@generacy-ai/cockpit` replaces the old `resolveIssueToPR` shape with
  `resolveIssueToPRRef`, returning a discriminated `PullRequestRefResolution`
  (`resolved` | `ambiguous` | `pr-is-draft` | `unresolved`) and exporting the new
  `PullRequestRefResolution`, `LinkMethod`, and `PrCandidate` types. Resolution is
  deterministic precedence — `closing-refs` (GitHub's authoritative Development
  link) → `branch-name` (`NNN-*`) → `pr-body` mention scan — with drafts excluded
  from every tier and >1 surviving non-draft candidate yielding `ambiguous` rather
  than a guess. The invariants are codified in the type doc (I-1…I-5). Because the
  fix lives in the shared resolver, `PrFeedbackMonitorService` inherits the same
  guarantees and can no longer attach feedback to the wrong sibling PR.

  The `@generacy-ai/generacy` `merge`, `queue`, and `context` verbs consume the new
  result and now always print/emit `resolved PR #N via <linkMethod>` (or the
  ambiguous/draft candidate list) on both success and failure paths — an operator
  never has to reverse-engineer the target from a second run. Merge exits non-zero
  without touching GitHub on any ambiguous or draft-only outcome.

- bdbee42: Add a `generacy cockpit merge --pr <number>` escape hatch for merging a PR by
  explicit number when issue→PR resolution can't be trusted (#913). The `<ref>`
  issue still supplies `completed:validate` authorization, but the operator names
  the PR directly and the command verifies linkage from the PR side before
  merging.

  - `@generacy-ai/cockpit`: new `GhWrapper.getPullRequestGraphqlDetail(repo, pr)`
    that fetches PR `state`/`headRefName`/`isDraft`/`mergeStateStatus` and
    `closingIssuesReferences` via `gh api graphql`, plus the exported
    `PullRequestGraphqlDetail` type. Tier-1 issue→PR resolution now tolerates the
    gh 2.96.0 minimal `closedByPullRequestsReferences` shape (FR-004) so a gh
    upgrade no longer breaks the parse.
  - `@generacy-ai/generacy`: `merge` grows the `--pr` flag (`parsePrFlag`,
    positive-integer validated). The `--pr` path refuses on missing/mismatched
    closing-issue linkage (`pr-flag-linkage-refused`, sub-kinds `empty-refs` /
    `mismatch`) and on a closed-unmerged PR (`pr-flag-closed-unmerged`), emitting
    the structured failing-check JSON with exit code 3 (usage errors exit 2). The
    sanctioned resolver path keeps its existing exit-0/1 behavior; it never merges
    on red.

- 368f133: Detect PR-number input to `cockpit merge` and make the MCP merge tool
  symmetric with the CLI verb (#928).

  - `@generacy-ai/cockpit`: `PullRequestRefResolution` gains a `{ kind:
'pr-number' }` arm, returned when the caller's `<issue>` argument is itself a
    PR node. Tier-1 resolution now runs a `__typename` classification query only
    when `gh issue view` fails with a "not an Issue"-shaped error, so the common
    input-is-an-issue path pays no extra round-trip. Only tier-1 classifies —
    tiers 2/3 never invent a `pr-number` signal.
  - `@generacy-ai/generacy`: `cockpit merge <issue>` now emits a typed exit-2
    refusal with guidance when the ref is a PR (closes #906 on the CLI), and
    `RunMergeResult` carries the operated-on `prNumber`. The MCP `cockpit_merge`
    tool takes an `issue` ref (renamed from the old inverted `pr` field, with a
    redirection message when a non-numeric `pr` key is seen) plus an optional
    `pr: <number>` escape hatch mirroring the CLI's `--pr` — resolution is
    skipped but every safety precondition (linkage, `completed:validate`, checks
    green) still holds. The `pr-number` refusal maps to the envelope
    `class: 'wrong-kind'`.

### Patch Changes

- bfe4c87: Clean up the G-S1 residue left after deleting the cockpit orchestrator/journal
  subsystems (#810, S4). Removes the stale pending changesets that announced the
  now-deleted orchestrator-status and journal-stuck-detection features, drops the
  orchestrator-client references from the package `description`, the README
  (the "Talk to a running orchestrator", two-mode client, degraded-mode, and
  `ORCHESTRATOR_URL`/`ORCHESTRATOR_API_TOKEN` sections), and the `src/index.ts`
  header comment. Adds a legacy-config tolerance test proving configs that still
  carry the removed `orchestrator.*` / `stuckThresholdMinutes` keys parse cleanly
  (Zod strip mode).

  For the record, the S1 deletion (#805) also dropped the `STALE` column from the
  `generacy cockpit status` table renderer and removed the `stuckAt` /
  `lastJournalAt` fields from `StatusRow`.

- b36c339: Fix the cockpit epic-body parser rejecting refs with trailing titles (#826).

  `parseEpicBody` previously passed the entire checkbox remainder (ref + delimiter +
  title) to `parseRef`, but every shape in `ref-shapes.ts` is `^…$`-anchored, so any
  task-list line carrying a free-form title (`- [ ] owner/repo#N — title`, the house
  style every real epic uses) failed to match and every child ref was dropped. The
  parser now extracts the leading whitespace-delimited token and parses that, treating
  the remainder as an unparsed title, matching the documented epic-body contract.

  The misleading warning reason (hardcoded "bare '#N' shorthand is not accepted") is
  replaced with a rejection-family taxonomy that describes what was actually seen —
  bare `#N`, a non-`/(issues|pull)/N` URL path, or titled-but-not-ref-shaped text —
  and the first-token silence rule keeps prose checkboxes that merely mention a ref
  mid-sentence from warning.

- 4bb30e1: Stop cockpit `queue`/`advance` from 403ing on App-credentialed clusters (#830).

  `cockpit queue` and `cockpit advance` resolved the GitHub identity via `gh api user`,
  which always 403s ("Resource not accessible by integration") on clusters using a
  GitHub App installation token — App tokens have no user identity. Both commands now
  route through a shared `resolveCockpitIdentity` chain that mirrors the orchestrator's
  `identity.ts` precedence: `--assignee` flag / `cockpit.assignee` config →
  `CLUSTER_GITHUB_USERNAME` / `GH_USERNAME` env → `gh api user`, with a loud error
  naming all four knobs when every tier misses. `queue` requires an identity (assignee
  is load-bearing); `advance` treats the actor as cosmetic comment attribution and
  degrades to omitting the actor line rather than failing the gate advance. Adds the
  `cockpit.assignee` config field to the cockpit config schema.

- 1832dbf: Add a `stage-complete` classifier tier so mid-pipeline `completed:*` labels no longer read as terminal (#841).

  The classifier previously mapped every `completed:*` label to the `terminal`
  state, so an issue that had finished an interim phase (e.g. `completed:plan`) but
  was still mid-workflow was ranked terminal and could silently outrank a live
  `waiting-for:*` label under tier precedence. A new `stage-complete` tier fixes
  this: only an explicit `TERMINAL_COMPLETED_LABELS` set (`completed:validate`,
  `completed:epic-approval`, `completed:children-complete`) still maps to `terminal`;
  every other `completed:*` now maps to `stage-complete`, which ranks below
  `waiting`/`error` so an actionable label always wins. Promotion of a new label to
  terminal now requires editing that explicit set, making silent demotion of
  `waiting-for:*` impossible. Within the tier, `STAGE_COMPLETE_PIPELINE_ORDER`
  gives latest-phase-wins tie-breaking for co-occurring demoted labels. The
  `generacy cockpit status` renderer gains a dim color for the new state.

- 9143b62: Fix `cockpit merge` checking `completed:validate` on the PR instead of the issue (#853).

  Workflow protocol labels (`waiting-for:*`, `completed:*`) live on the issue,
  not the PR, so `cockpit merge` could never observe `completed:validate` and
  merge always failed. `runMerge` now reads the label from the issue's
  `IssueStateResult.labels`. The gh wrapper's issue-state query additionally
  surfaces `stateReason` (added to `IssueStateResult` and the `gh issue view`
  `--json` field set) so merge can reason about how an issue was closed.

- c65ec3c: Fix `gh pr checks` requesting nonexistent JSON fields, hard-failing merge and silently blanking every checks surface (#855).

  The gh wrapper's `getPullRequestCheckRuns` requested `--json name,state,conclusion,detailsUrl`, but `conclusion` and `detailsUrl` have never existed on `gh pr checks` (it exposes `bucket`/`link`, not the `gh run` REST vocabulary). gh validates the field list client-side before any network call, so the method failed on every invocation — hard-failing `cockpit merge` and silently degrading `status`/`watch`/`context` checks rollups to blank. The field list is now `name,state,bucket,link`, `CheckRunSummary` drops the unused `conclusion` field (threaded through `review-context-json`), the swallowed wrapper error now emits a `warn` log, and the `resolveIssueToPr` query drops its unused `timelineItems` selection. A CI-tier drift test runs the real pinned gh binary against every `--json` field list the wrapper uses to catch this class of gh-interface drift that mocked fixtures cannot.

- 591059b: Fix `cockpit merge` conflating "no checks reported" with a check failure, which
  prevented CI-less repos from ever merging.

  `gh pr checks` exits non-zero for both "checks failed" and "no checks exist", so
  the gh wrapper's fail-on-nonzero handling rejected repos with no CI configured.
  Now `getPullRequestCheckRuns` recognizes gh's no-checks case (exit 1 + stderr
  matching `no checks reported`) and returns an empty check-run list instead of
  throwing; all other non-zero exits still throw. The merge decision evaluates the
  empty list against the required-checks set: no required checks + none reported is
  vacuously green and proceeds to squash (emitting an explicit note so the
  condition is never silent), while a non-empty required set with contexts absent
  is treated as red, naming the missing required contexts. status/watch rollups
  render an empty list as the existing `none` value.

- 5cdc0bb: `cockpit merge` now deletes the head branch after a successful squash-merge, so
  stale speckit branches (one per child issue) no longer accumulate on an epic.

  The deletion is handled gracefully and never fails the verb: a branch already
  gone (repo-level auto-delete enabled) and cross-fork PRs where the head ref
  can't be deleted are both logged as info and skipped. The merge result line
  reports the outcome ("merged and branch deleted") so the deletion is visible.
  Retroactive cleanup of existing stale branches and flipping the repo-level
  auto-delete setting remain out of scope.

- cf03bb9: Stop cockpit watch/status classifying closed issues as actionable merge candidates (#873).

  The watch/status classifier was label-only: a `completed:validate` label meant terminal/merge-candidate with no check of the issue's open/closed state. Closed issues keep their label residue forever, so every closed-and-merged child kept rendering as an actionable merge candidate on every fresh watch — an operator copying the suggested `/cockpit:merge` would run a merge against an already-merged PR. An issue's `state: closed` now dominates any label-derived actionability tier: closed children render as done in their phase group (no suggestion), the watch startup sweep emits nothing actionable for them, and a live open→closed transition yields exactly one terminal "done" line with no suggested command.

- d27b61e: Fix two pr-feedback defects surfaced during cockpit v1 (#926).

  - `@generacy-ai/cockpit`: `waiting-for:address-pr-feedback` now outranks every
    other `waiting-for:*` gate in the classifier precedence order — an
    actively-rewriting-code state is more specific than any passive gate it can
    coexist with, so a PR mid-feedback no longer classifies as the coexisting
    passive gate.
  - `@generacy-ai/orchestrator`: the pr-feedback handler now clears
    `agent:in-progress` at a single shared `finally` exit path, so no terminal
    return (Cases A/B, either blocked-stuck disposition, or a thrown error) can
    leave the label pinned. The happy path coalesces the
    `waiting-for:address-pr-feedback` + `agent:in-progress` removal into one
    `removeLabels` call so cockpit/auto observers never see one label without the
    other; the `finally` clear is an idempotent backstop and stays non-fatal on
    failure.

- ffd6bb1: Fix `resolveEpicIssues` dropping cross-repo epic children (#801).

  `resolveEpicIssues` now returns repo-qualified child refs (`{ repo, number }[]`)
  instead of a bare `number[]`, preserving each child's repo — including cross-repo
  entries declared in the manifest (`phases[].issues` / `phases[].repos` as
  `owner/repo#n`). `cockpit status` and `cockpit watch` fetch and classify each
  child in its own repo, and the label-graph fallback searches the configured
  `cockpit.repos` for `epic-parent` references rather than only the epic's own repo.
  This makes `status`/`watch --epic` work for cross-repo epics (e.g. a
  `tetrad-development` epic whose children live in `generacy` and `agency`).

- af34d75: Terminate the PR-feedback loop on its own trigger; stop the runaway reply churn (#883).

  The monitor triggers on `unresolvedThreads > 0`, but the handler treated "reply
  posted" as done and never resolved the threads — so a successful cycle left its
  own trigger unchanged and re-fired at poll cadence forever, stacking a duplicate
  "I've addressed this feedback" reply (one per comment, doubling each round) and
  burning a full Claude CLI run every ~5 minutes.

  - **workflow-engine**: adds a `resolveReviewThread(threadId)` GraphQL mutation
    (App-token-capable, 3× backoff retry, no retry on auth failure), a thread `id`
    on the #861 `ReviewThread` shape, and a `blocked:stuck-feedback-loop` label
    definition.
  - **orchestrator**: after a fix cycle pushes a commit and posts one reply per
    _root_ thread, the handler resolves every thread it addressed before clearing
    the label — the termination edge. No-diff cycles now post no replies, log a
    `warn` that the trigger persists, and exit without the success line instead of
    churning. The monitor skips issues carrying the `blocked:` pause.
  - **cockpit**: classifies `blocked:*` labels as the `waiting` state and sorts
    `blocked:stuck-feedback-loop` ahead of the `waiting-for:*` gates so the pause
    surfaces first.

- 59615ab: Fix `cockpit status` / `cockpit watch` listings: pass each `gh search issues`
  term as a separate argument. The query was passed as a single positional arg,
  so gh folded trailing qualifiers into the first one's quoted value (e.g.
  `repo:"o/r is:open"`), producing an invalid query that failed every repo- and
  epic-scoped listing.
- Updated dependencies [8b5e483]
- Updated dependencies [a951c1f]
- Updated dependencies [de0a6bd]
- Updated dependencies [f5b162a]
- Updated dependencies [186a92a]
- Updated dependencies [a179720]
- Updated dependencies [3d718e5]
- Updated dependencies [e829db2]
- Updated dependencies [2d3b73f]
- Updated dependencies [121e84b]
- Updated dependencies [33c9f11]
- Updated dependencies [af34d75]
- Updated dependencies [242b950]
  - @generacy-ai/workflow-engine@0.3.0
  - @generacy-ai/config@0.3.0
