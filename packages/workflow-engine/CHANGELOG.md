# @generacy-ai/workflow-engine

## 0.6.0

### Minor Changes

- d533b41: Tighten the implement-phase "produced no product-code changes" guard so it can no longer be structurally defeated on speckit branches (#1107).

  `@generacy-ai/workflow-engine` gains two local-git `GitHubClient` methods: `getCurrentCommitSha()` (`git rev-parse HEAD`) and `getFilesChangedByOwnCommits(startRef)` (`git log --first-parent --no-merges --name-only <startRef>..HEAD`), which isolate the files a branch's own commits touched — immune to base-merge-introduced and earlier-phase files.

  `@generacy-ai/orchestrator` now (a) excludes the spec-kit `update_agent` targets (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`) by exact root-relative filename via a new `EXCLUDED_EXACT_PATHS` set, and (b) measures a phase-scoped diff window anchored to a start ref captured after the pre-implement base merge and persisted in Redis (via new `PhaseTrackerService` raw string get/set/clear) so it spans all pre-restart increments. The pass/fail surface, escalation path, and detection-failure fallback are unchanged.

- c5343ef: Remove two false-failure paths in the #1107 phase-scoped product-diff guard (#1112).

  `@generacy-ai/workflow-engine` gains a local-git `GitHubClient` method `commitExistsInCheckout(sha)` (`git rev-parse --verify --quiet <sha>^{commit}`): exit 0 → true, exit 1 (commit-missing, full or abbreviated sha) → false, any other exit → throw, so an environment fault is never mistaken for a missing commit.

  `@generacy-ai/orchestrator` reworks the phase-start-ref capture/reuse block so it (a) reads through to the pre-#1110 legacy Redis key (no branch component) on a branch-scoped miss, migrating a valid value to the branch-scoped key before consuming the legacy key once, and (b) verifies a reused ref resolves in the current checkout before anchoring the diff window — re-capturing fresh HEAD when it does not. A non-commit-missing git fault still surfaces via the existing detection-failure path (`product-diff-error` + escalation). The pass/fail surface, escalation path, exclusion lists, and TTL are unchanged.

## 0.5.0

### Minor Changes

- bdbde27: Deterministic branch/spec-slug + PR dedup on speckit workflow re-entry (#1043).

  Speckit workflows re-entering `implement` (e.g., after
  `cockpit_advance(implementation-review)`) could re-derive a different branch
  slug from a mutated description, miss the existing `specs/<N>-*` idempotency
  check in `createFeature()`, and open a duplicate PR alongside the real one
  (as observed in generacy-cloud#850 / #1038 → PR #1041 orphaning PR #1039).

  Fix: new pure resolver `resolveIssueBranch()` in
  `@generacy-ai/workflow-engine` that returns the canonical `<N>-<slug>`
  branch for an issue by querying remote state only (open PRs on `<N>-*`
  branches first, oldest `<N>-*` remote branch as fallback). Two callers:
  `CreateFeatureInput` gains an optional `resolveExistingBranch` callback
  that lets `createFeature()` skip slug re-derivation when a canonical
  branch already exists; `PrManager.ensureDraftPr()` runs the resolver as
  defense-in-depth and adopts the canonical PR instead of opening a
  duplicate on mismatch. Slug-generation logic is unchanged — the callback
  returning `null` falls back to the existing derivation path.

  Emits structured events for observability: `workflow-reentry-branch-reused`
  (happy path, SC-003) and `workflow-reentry-branch-mismatch` (defensive
  path, FR-005).

- 66cf1d6: PR-feedback fixer now consumes review bodies, not just inline threads (#1047).

  `packages/workflow-engine` — adds `Review` + `ReviewSubmissionState` types and
  `GitHubClient.listReviews(owner, repo, prNumber): Promise<Review[]>`. Implements
  via `gh api /repos/{owner}/{repo}/pulls/{n}/reviews`. Introduces the new label
  `blocked:body-finding-unaddressed` used by the orchestrator's Disposition C.

  `packages/orchestrator` — `PrFeedbackHandler` now:

  - Fetches submitted reviews alongside inline threads and merges their bodies
    into the fixer prompt so findings that name files NOT in the diff still
    reach Claude on the same round (FR-002).
  - Applies a per-finding gate: parses the `<!-- generacy-cockpit:unanchored-findings -->`
    marker block in each review body, extracts the `**Files:**` list under each
    `### Finding <n>`, and requires the just-pushed commit to touch at least one
    named file per finding before advancing (FR-003). Older-producer bodies
    without a `**Files:**` line degrade to no-constraint (FR-005), so a two-sided
    producer/consumer rollout is safe.
  - Adds Disposition C: on gate failure, applies
    `blocked:body-finding-unaddressed` and posts a marker-keyed top-level PR
    comment enumerating the unaddressed findings. Distinct from Disposition B
    (`blocked:stuck-feedback-loop`).
  - On resume, findings listed in the newest
    `<!-- generacy-cockpit:body-findings-unaddressed -->` marker comment are
    treated as acknowledged and skip re-gating; they still reach the prompt
    (FR-008).

  No new npm dependencies. No changes to the monitor's blocked-label skip gate —
  `l.startsWith('blocked:')` honors the new label with zero allow-list change.

  **Scope limit** — the fixer only reaches the review-body path when a review
  also carries at least one trusted inline thread. `PrFeedbackMonitorService` still
  gates enqueue on `unresolvedThreadIds.length > 0`, so a review submitted with a
  body finding and NO inline comments does not schedule the fixer. Widening the
  monitor's enqueue trigger to reviews-with-body-findings is tracked as a
  follow-up; body-only reviews should currently be paired with at least one inline
  comment (or the operator can add an inline note before submitting).

- 63436bf: Split PR-feedback CLI-timeout disposition off `blocked:stuck-feedback-loop` and allow up to two bounded auto-retries per trigger (#1070). Three new label vocabulary entries in `@generacy-ai/workflow-engine`: `blocked:fixer-timeout` (retry-eligible, monitor auto-dispatches on next poll), `blocked:fixer-timeout-no-progress` (terminal — CLI timed out with zero commits), `blocked:fixer-timeout-repeat` (terminal — auto-retry budget of 2 exhausted). Orchestrator's `PrFeedbackHandler` collapsed `!success || !hasChanges` branch is split into an explicit four-way switch and the historically contradictory `msg: "Successfully pushed changes" success: false` log line is fixed. Retry counter lives on the monitor (`PrFeedbackMonitorService.fixerTimeoutRetryCount`) and travels handler-ward via a new optional `retryAttempt?: number` field on `PrFeedbackMetadata`; resets only when all review threads are fully resolved (Case C). Cockpit `WAITING_PIPELINE_ORDER` gains the two terminal `blocked:fixer-timeout-*` labels ahead of `waiting-for:address-pr-feedback` (mirrors the `blocked:stuck-feedback-loop` precedence), while the retry-eligible `blocked:fixer-timeout` intentionally sorts below the active waiting gate.
- cd811d1: Detect fixer-CLI self-commit cycles in PR-feedback handler by comparing branch HEAD SHA across the CLI invocation, so `blocked:stuck-feedback-loop` no longer lands on cycles that actually pushed a commit (#1073). New `@generacy-ai/workflow-engine` label vocabulary entry `blocked:resolve-failed` for the narrower case where code changes landed but thread reply/resolve failed — separated from `blocked:stuck-feedback-loop` because the two require different operator remediation (check GitHub API responses vs. read fixer transcripts). Orchestrator's `PrFeedbackHandler` disposition dispatcher gains a head-advance check between the CLI spawn and the pre-existing B1/B2/B3 branch; timeout branches (B4/B5/B6 from #1070) are unaffected. Log lines gain a `source: 'cli' | 'handler'` field on both the CLI-self-commit and handler-commit paths, and the CLI-self-commit path carries `preFixSha` + `postFixSha` so the head-advance claim is auditable rather than asserted (clarification Q4 caveat). The CLI-self-commit info line also carries a `handlerCommitted: boolean` field so operators can distinguish CLI-only, handler-only, and mixed (both committed) cycles from a single grep. Cockpit `WAITING_PIPELINE_ORDER` gains `blocked:resolve-failed` ahead of `waiting-for:address-pr-feedback` (mirrors the terminal `blocked:fixer-timeout-*` precedence). No changes to `PrFeedbackMonitorService`, `PrFeedbackMetadata`, `QueueItem`, or the `blocked:*` short-circuit; this is a producer-side fix.

  **Operator-visible narrowing:** `blocked:stuck-feedback-loop` no longer originates from the zero-resolve path (previously reachable in principle but shown to be unreachable in practice; PR #1075 review). The label now only originates from the B1/B2/B3 branch (`!cliSelfCommitted && (!success || !hasChanges)`). A zero-resolve cycle after a real head-advance now always lands `blocked:resolve-failed`.

### Patch Changes

- 349fdba: Prevent orchestrator worker from resurrecting merged-and-deleted branches (#1051).

  Bundles three independent, additive fixes that together prevent a re-entering
  worker from resurrecting a deleted branch and opening a duplicate PR that claims
  `Closes #<already-closed>`:

  - **FR-001**: adds `--prune` to the multi-ref `git fetch origin` in both
    `RepoCheckout.switchBranch` and `RepoCheckout.updateRepo`. Deleted upstream
    branches are removed from local tracking refs so `reset --hard origin/<branch>`
    no longer silently succeeds against a stale ref. `fetchBase` (single-ref) is
    unchanged.
  - **FR-002/003**: new stateless `push-guard` module + wiring at three sites
    (`pr-feedback-handler.commitAndPushChanges`, `pr-manager.commitAndPush`,
    `phase-loop` entry). Refuses a push when the PR has already merged/closed,
    the remote branch is missing under an open PR, or the PR-state lookup itself
    fails; emits `event: 'push-refused'` with a `reason` enum
    (`pr-merged`/`pr-closed`/`branch-missing`/`pr-lookup-failed`) and clears
    `agent:in-progress` (plus adds `agent:error` on still-open issues). Never
    adds `failed:<phase>` — that would invite `/cockpit:resume` into a loop. The
    refusal signal propagates from `PrManager.commitPushAndEnsurePr` (via a new
    `CommitResult.pushRefused` field) up to `phase-loop`, which aborts the
    workflow — otherwise `ensureDraftPr` would open a duplicate PR against the
    merged branch and the loop would flip the PR ready-for-review with zero
    commits pushed.
  - **FR-005**: `LabelMonitorService.processLabelEvent` drops both `process`
    and `resume` events whose target issue is closed at enqueue time, emitting
    one `info` log line with `dropped: 'issue-closed'`. Zero mutations on drop.
    Complements #1049's `PrFeedbackMonitorService` merged-PR gate, which covers
    only the address-pr-feedback entry path. Scope: gate fires inside
    `processLabelEvent` only — four other enqueue paths (base-advance-monitor,
    worker-dispatcher lease-expiry / post-complete rearm, pr-feedback-monitor)
    are out of scope for this spec and tracked as follow-ups.
  - **FR-004** (RETRACTED): the original writeup claimed cross-issue working-tree
    contamination from `d8e392ca`. That commit is actually a two-parent merge
    commit; the `added` file statuses were an API artifact of GitHub diffing
    merges against parent 1 only. No contamination mechanism was ever present in
    the observed evidence. Corresponding regression test deleted.

  `workflow-engine` gains one new internal method `findPRForBranchAnyState` on
  `GitHubClient` — used only by orchestrator's `push-guard`, not re-exported at
  the public boundary. **Throws** on non-zero `gh` exit (silent null-on-error is
  the wrong contract for a safety-gate input); returns `null` only for the
  operationally-meaningful "no PR exists" case. Uses `--limit 10` plus a
  caller-side merged-precedence scan so a MERGED PR older than a CLOSED PR on
  the same branch still produces the more diagnostic `reason: 'pr-merged'`.
  Existing `findPRForBranch` is intentionally unchanged; five call sites depend
  on its open-only default.

  No new labels, no new persisted state, no workflow-YAML changes.

## 0.4.0

### Minor Changes

- c7807a3: Detect repeat-identical phase failures and escalate to artifact repair instead of retrying verbatim (#942).

  A phase failure caused by a defective generated artifact used to fail forever:
  the retry path re-ran the same phase against the same artifacts. On snappoll#8,
  `implement` failed three times with a byte-identical reason (a self-contradictory
  `tasks.md` kept tripping the `no-product-code-changes` post-exit check) and only
  cleared after a 3-hour hand-implementation. Three verbatim-identical failures are
  an unambiguous signal that retrying will not help — the inputs are wrong.

  - `@generacy-ai/workflow-engine`: adds six `failed:<phase>-repeated` label
    definitions (`specify`, `clarify`, `plan`, `tasks`, `implement`, `validate`),
    applied when the same failure fingerprint fires ≥2×.
  - `@generacy-ai/orchestrator`: fingerprints each phase failure (phase + reason)
    and tracks recurrence, so the phase loop stops retrying on the second
    identical failure and surfaces the distinct `failed:<phase>-repeated` state
    rather than looping. Non-identical failures retry as before.
  - `@generacy-ai/generacy`: `cockpit resume` understands the repeated-failure
    state, so the operator is offered the artifact-repair path (repair/regenerate
    the upstream artifact with the failure reason as context) instead of a plain
    requeue that would reproduce the same failure.

### Patch Changes

- 679d2e7: Authorship-gated clarification answer scanner, quote-safe parser, and
  reply-only resume monitor. Replaces the content-sniffing L488 branch in
  `clarification-poster.ts` (which fails both directions — bot self-answers
  its own gate; developer quote-replies get silently discarded) with
  `viewerDidAuthor`-based authorship + a new engine-written answer marker
  family. Cluster-self-authored comments are answer sources only when they
  carry `<!-- generacy-clarification-answers:<batch> -->`, stamped
  exclusively by the new `cockpit_relay_clarify_answers` MCP tool. Adds
  `ClarificationAnswerMonitorService` (mirror of `MergeConflictMonitorService`)
  so a plain reply resumes the paused gate. `hasPendingClarifications` fails
  closed on missing dir / unreadable file / parse failure. Prompt template,
  parser, write-back regex, and cockpit tool now share `PENDING_ANSWER_LITERAL`
  via `@generacy-ai/workflow-engine`, making prompt/parser drift structurally
  impossible. See #958.

## 0.3.0

### Minor Changes

- de0a6bd: Replace `CLUSTER_ACTING_LOGIN` self-recognition with GraphQL `viewerDidAuthor` on the pr-feedback surface.

  The pr-feedback trust predicate now recognizes cluster-authored comments via
  GitHub GraphQL's `viewerDidAuthor` primitive instead of comparing normalized
  author logins to a provisioned `CLUSTER_ACTING_LOGIN` value. `getPRReviewThreads()`
  threads the field onto every `Comment` returned; decision 1.5 in
  `isTrustedCommentAuthor()` fires on `comment.viewerDidAuthor === true`. All
  `resolveActingIdentity()` / `normalizeLogin()`-based cluster-identity plumbing
  (orchestrator + scaffolders) is removed.

  **Breaking change (FR-004):** the `TrustReason` union entry `'cluster-identity'`
  is renamed to `'self-authored'` on the pr-feedback surface. Hard rename with
  no dual-emit; the string was two days old and preview-channel-only.

  **Operator note (FR-005):** `CLUSTER_ACTING_LOGIN` is unused and safe to remove
  from existing `.env` and `docker-compose.yml`. No auto-cleanup, no startup
  compat log — a redeploy of the orchestrator image is the only action required
  to gain the fix.

- f5b162a: Re-validate on base advance and add a bounded validate-fix cycle (#892).

  Two red classes were stranding issues at `failed:validate` with no recovery, so
  an auto run could never reach `epic-complete`:

  - **Stale integration reds (a).** A new base-advance monitor polls each PR's base
    branch head SHA on the existing ~60s cadence; when it advances (a sibling PR
    merges, an external PR merges, or a direct push lands), every open speckit
    issue sitting at `failed:validate` against that base is re-armed via `cockpit
resume`. Dependency-ordered merges unlock dependents one at a time with no
    membership machinery; `(issue, new base SHA)` is the natural re-arm key and the
    #879 in-flight dedupe collapses storms. `getRefHeadSha` is added to the
    workflow-engine GitHub client for the SHA poll.
  - **Genuine code reds (b).** A red that persists on a fresh merge-preview gets one
    autonomous `ValidateFixHandler` attempt on the branch — a new
    `ValidateFixIntent` in the claude-code plugin, sharing the PrFeedbackHandler
    spawn→commit→push→re-check plumbing with the #883 termination discipline (the
    attempt must change the tree or stop). Attempt identity is a SHA-256 evidence
    hash over the normalized failing-test/module set + first error line (ANSI,
    timestamps, absolute paths, and per-run identifiers stripped), so the same red
    never triggers a second autonomous attempt — further attempts only via the
    escalation gate. Still red after the attempt → `failed:validate` + alert.

- 186a92a: Add the bounded merge-conflict resolution handler #864 deferred (#898).

  `#864` shipped the pre-phase base-merge guardrail and the
  `waiting-for:merge-conflicts` pause but deferred the actual resolver to a
  follow-up that was never filed — so issues that paused at that gate could never
  transition. This ships both halves:

  - **Self-describing pause surface.** The merge-conflict pause comment now
    documents the manual escalation path (resolve on the branch, push, then
    advance) and stays load-bearing as the `blocked:stuck-merge-conflicts`
    escalation surface.
  - **Bounded autonomous resolver.** A merge-conflict monitor enqueues a resolution
    item for issues sitting at `waiting-for:merge-conflicts`, and a new
    `MergeConflictHandler` (shaped like `PrFeedbackHandler`, driven by a new
    claude-code `MergeConflictIntent`) makes exactly one autonomous CLI attempt on
    the branch with #883-style termination discipline: pre-agent git/network flakes
    get bounded 3× retries, the agent runs at most once, and `git push` retries only
    network errors — a non-fast-forward rejection escalates to
    `blocked:stuck-merge-conflicts` rather than looping. On success it applies
    `completed:merge-conflicts` and clears the pause; on failure it preserves the
    gate and emits an evidence block. Adds the `blocked:stuck-merge-conflicts` label
    to the workflow-engine vocabulary.

- 3d718e5: Fix the two label-provisioning surfaces classifying create-races and real
  failures inconsistently, and stop over-long label descriptions failing
  provisioning (#916).

  - `@generacy-ai/workflow-engine`: add a shared `classifyLabelProvisioningError`
    helper (exported, with the `ProvisioningErrorClassification` type) so
    `LabelManager.ensureRepoLabelsExist` (per-worker ensure-pass) and
    `LabelSyncService.syncRepo` (boot-time bulk sync) distinguish a benign
    `already exists` create-race from a real failure (422/401/403/5xx) from one
    home instead of drifting apart. Shorten the `paused:*` / merge-conflict
    `WORKFLOW_LABELS` descriptions that exceeded GitHub's label-description length
    limit and triggered 422s on create.
  - `@generacy-ai/orchestrator`: `LabelSyncService.syncRepo` now catches per-label
    errors — races count as `unchanged` (no longer flip the repo to failed) while
    real failures are logged with cause/status and fail the repo; a `listLabels`
    failure remains fatal for that repo. `LabelManager` records a
    provisioning-failure lineage map and routes all label applies through
    `applyLabels`, so an apply-time 404 on a workflow label is enriched with the
    provisioning cause the operator needs.

- 2d3b73f: fix: assert a product diff before a phase requiring changes can pass (#820)

  An implement phase that produced no product code — only `specs/` artifacts —
  previously passed validate and merged silently. The worker now computes the
  product diff for phases that require changes (`git diff --name-only base...HEAD`,
  excluding the `specs/` path prefix) and fails the phase when no product files
  changed.

  Adds `GitHubClient.getFilesChangedBetween(base, head)` (merge-base/triple-dot
  semantics) to `@generacy-ai/workflow-engine` and its gh-cli implementation, plus
  the `product-diff` helper and `PrManager.getPrNumber()` in
  `@generacy-ai/orchestrator`.

### Patch Changes

- 8b5e483: Author-trust gating for workflow-ingested GitHub comments (#842).

  Three ingestion surfaces — the clarify answer-scanner, the clarify resume prompt,
  and the PR-feedback reader — previously treated every human-authored comment on an
  issue or PR as trusted agent input, with no filter on who wrote it. On a public
  repo this is a live prompt-injection / supply-chain vector: a drive-by account
  (`author_association: NONE`) can attach "apply this patch" or a hostile link and
  have an autonomous worker ingest it as requirements or context. A new shared
  comment-trust helper now gates ingestion by `author_association`: `OWNER`,
  `MEMBER`, and `COLLABORATOR` are trusted by default; `NONE`,
  `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `MANNEQUIN`, and `CONTRIBUTOR` are
  excluded from agent context. The `gh` client and `Comment` type now carry
  `author_association` so the decision is possible, an untrusted-data fence wraps
  comment bodies that still reach a prompt, and each skipped comment is logged with
  author, tier, comment ID, and surface (metadata only — no body content) so a
  repo owner can widen the allowlist deliberately via config rather than silently
  lose a legitimate collaborator's answer. All three surfaces share the one trust
  helper rather than three parallel implementations.

- a951c1f: Provision the cluster's acting identity so the #869 cluster-identity trust rule actually fires (#874).

  The #869 trust machinery shipped correctly but was inert: it compared PR-feedback comment authors against a cluster identity that was never provisioned. On a scaffolded cluster with App credentials, `resolveClusterIdentity()` returns nothing (`gh api user` 403s on App installation tokens), so the trust predicate ran its degraded mode permanently and every first-party comment authored by the App bot was classified untrusted. This introduces a distinct **acting login** (the App bot account that authors the cluster's own comments) separate from the assignee-identity chain (whose issues the cluster works), normalizes the `[bot]` suffix so REST-form (`generacy-ai[bot]`) and GraphQL-form (`generacy-ai`) author logins compare equal, has both the local scaffolder and cloud-deploy write it, and makes the degraded mode observable — `clusterIdentity` is included in every `untrustedCommentSkips` warn and a single identity-resolution-failure error is emitted per process start when resolution fails.

- a179720: Fix App-identity clusters failing to self-recognize their own clarification
  answer posts (#910). The answer-scanner (`integrateClarificationAnswers`) and
  the clarify-resume context builder (`buildTrustedIssueCommentsBlock`) now fetch
  issue comments through a new GraphQL client method
  `getIssueCommentsWithViewerAuth()` instead of the REST `getIssueComments()`,
  so each comment carries the `viewerDidAuthor` primitive keyed on the
  authenticated App identity (stable across installation-token rotation). Both
  call sites retry once on transient failure and fail closed on the second
  failure — no REST fallback, which would silently reproduce the pre-fix defect.
  The comment-trust helper's self-authored shape-drift warning is extended from
  `pr-feedback` to a `MIGRATED_SURFACES` set (`pr-feedback`, `answer-scanner`,
  `clarify-resume`), so a future caller that accidentally routes a migrated
  surface through REST trips the wrong-method alarm instead of silently
  rejecting the cluster's own comments at tier NONE.
- 121e84b: Fix the PR feedback loop never firing because `Comment.resolved` was never populated (#861).

  Thread resolution is a GraphQL-only concept — the REST endpoint underlying
  `getPRComments()` never exposed it, so `Comment.resolved` was always `undefined`
  and the preflight / read-pr-feedback / orchestrator feedback loop treated every
  thread as unresolved (or silently skipped it). Adds `getPRReviewThreads()`, which
  fetches review threads with their `isResolved` state via GraphQL, and rewires
  `preflight`, `read-pr-feedback`, and the orchestrator PR-feedback handler to use
  it. `getPRComments()` and `Comment.resolved` are deprecated and slated for removal.

- 33c9f11: Trust the cluster's own identity in the PR-feedback loop so cockpit request-changes feedback can be auto-addressed (#869).

  The #842 author-trust filter and the cockpit's request-changes path were mutually
  deadlocked: feedback the cockpit posts through its own human-gated gate is authored
  by the cluster's GitHub identity, which GitHub reports as `author_association: NONE`,
  so the handler classified its own first-party payload as untrusted and discarded it.
  The trust predicate now treats the resolved cluster identity as trusted in addition
  to `OWNER`/`MEMBER`/`COLLABORATOR`, and both the monitor and the handler evaluate the
  same shared predicate. A zero-trusted exit (unresolved threads present but none
  trusted) no longer removes the label, log "No unresolved threads found", or exit
  silently — it retains state, logs at `warn` with the skipped authors/reasons, and the
  enqueue-dedupe state is settled so a later trusted comment re-triggers the loop.

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

- 242b950: Stop the label-op crash-loop and provision missing protocol labels on demand (#889).

  Two composing defects made the #864 pre-implement base-merge pause path
  crash-loop the worker on repos provisioned before the `waiting-for:merge-conflicts`
  label existed:

  - **Missing label provisioning.** `gh issue edit --add-label` hard-fails when the
    label doesn't exist, so the pause failed on every pre-#864 repo. Labels the
    orchestrator can apply are now ensured to exist (created on demand) before they
    are applied — generalizing to any future protocol-vocabulary addition, with no
    operator `gh label create` step. A label-protocol audit test fails if a label is
    added to the engine vocabulary without being in the provisioning source of truth.
  - **Label-op failure crash-looped the fleet.** After `LabelManager`'s 3-attempt
    retry was exhausted, the error propagated unhandled and `WorkerDispatcher`
    released the item back to `pending`; the next worker re-claimed, hit the same
    missing label, and released again — indefinitely. A label-op failure is now a
    terminal failure of the _individual item_ (`agent:error`, left in place, not
    re-queued) with a #865-style alert naming the failing label operation and site
    and including the underlying `gh` error as evidence. The worker keeps processing
    other items — no unhandled throw escapes `ClaudeCliWorker.processItem`.

## 0.2.1

### Patch Changes

- 8d152d0: Fix JIT gh-token provider on wizard-bootstrapped clusters (#777).

  The gh JIT token provider was gated on a `github-app` credential descriptor
  that wizard-bootstrapped clusters never have, so it was always `undefined` and
  every `gh` call fell back to the expired ambient `GH_TOKEN`. The provider is now
  built whenever the control-plane `/git-token` path is available and fetches
  credential-less (passing `credentialId` only when a descriptor exists). When a
  provider is present, `GH_TOKEN` is always set on the `gh` subprocess (never
  `undefined`), so it can no longer inherit the stale ambient token.

## 0.2.0

### Minor Changes

- 223d320: feat: cluster-side backstop for expired/near-expiry GH_TOKEN (#762)

  Detect an expired or near-expiry GitHub token and request a refresh instead of
  silently 401-looping. `workflow-engine` now surfaces `GhAuthError` and
  `parseGhStatusCode` so callers can distinguish auth failures, and the
  `orchestrator` adds a credential-expiry watcher plus GitHub auth-health state
  (exposed on the health route) so the label and PR-feedback monitors drive a
  credential-refresh request rather than repeatedly failing on 401s.

## 0.1.2

### Patch Changes

- e69ed75: Follow-up to the bulk worker-scale catch-up (#719). The orchestrator was bumped
  to 0.2.0 in that batch with `^0.1.1` pinning on `@generacy-ai/workflow-engine`,
  but workflow-engine itself wasn't bumped — leaving stable on 0.1.1 from May 20.
  The orchestrator's published 0.2.0 imports `FilesystemWorkflowStore` (added to
  `workflow-engine/src/index.ts`'s top-level re-exports in a later develop commit),
  so loading `@generacy-ai/orchestrator@0.2.0` against `workflow-engine@0.1.1`
  fails with:

      Failed to load @generacy-ai/orchestrator: The requested module
      '@generacy-ai/workflow-engine' does not provide an export named
      'FilesystemWorkflowStore'

  Patch bump (rather than minor) so the orchestrator's existing `^0.1.1` semver
  range picks up `0.1.2` automatically — no orchestrator re-publish needed.

  The broader process gap (per-PR changesets not enforced) is tracked in #720.

## 0.1.1

### Patch Changes

- 6779a85: Bulk patch bump to populate the `stable` npm dist-tag for the 14 packages that were left at 0.1.0 by the previous changeset cycle (which only listed `@generacy-ai/generacy` and `@generacy-ai/cluster-relay`).

  After this changeset is consumed by changesets/action and the resulting version-packages PR merges to main, all 16 public `@generacy-ai/*` packages in this repo will be on `stable` on npm.
