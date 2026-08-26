# @generacy-ai/workflow-engine

## 0.7.0

### Minor Changes

- 8c925b4: Add `review` and `remediate` to the workflow phase machinery (#1121).

  Widens the canonical `WorkflowPhase` vocabulary with two new phases and threads them through every hand-maintained duplication site so the packages compile and existing runs stay byte-identical. This ships type/config/label plumbing plus inert stub execution only — real executors, prompts, verdict/finding logic, and concrete `remediate` triggers land in later epic issues.

  `@generacy-ai/workflow-engine` (minor) adds the `phase:`/`completed:`/`failed:`/`failed:*-repeated` label families for both `review` and `remediate` to `WORKFLOW_LABELS` (no `waiting-for:` gate labels) and widens the `CorePhase` union.

  `@generacy-ai/config` (minor) widens the public `template-schema` `phases` keys to accept optional `review` / `remediate` agent entries.

  `@generacy-ai/orchestrator` (patch) inserts `review` into `PHASE_SEQUENCE` between `implement` and `validate` (feature/bugfix inherit it; `speckit-epic` unchanged), maps both new phases to the `implementation` stage, adds a `reviewPhaseEnabled` flag (default `false`) that skips `review` before any label side effect fires, adds an inert stub executor for both phases, and adds an off-sequence `remediate` seam gated on an injectable `remediateTrigger` (undefined in production → dead by default).

  `@generacy-ai/generacy` (patch) adds `review` / `remediate` to the cockpit `resume` `KNOWN_PHASES` list.

- c1154f5: Review phase executor — structured findings artifact + engine-internal verdict (#1124).

  Replaces the inert `runStubPhase('review')` (from #1121) with a real executor. The engine builds an in-process charter prompt (selected by `review.profile`), spawns the CLI via a new `review` launch intent, the agent writes a structured findings sidecar, and the engine Zod-validates the findings and **recomputes** the verdict (`clean` | `changes-required`) — the agent-claimed verdict is ignored and GitHub review state is never used (the cluster account 422s on `REQUEST_CHANGES` against its own PR). The next-phase decision is driven through the synchronous `remediateTrigger` seam, bounded by `maxRemediations` with a `waiting-for:remediation-limit` gate pause. Remains byte-identical when `reviewPhaseEnabled=false`.

  `@generacy-ai/workflow-engine` (minor) adds the `waiting-for:remediation-limit` label vocabulary.

  `@generacy-ai/generacy-plugin-claude-code` (minor) adds the `review` launch intent kind.

  `@generacy-ai/orchestrator` (patch) adds the review-artifact sidecar module, the review charter builder, the `ReviewExecutor`, the `on-remediation-limit` gate condition, and the phase-loop/worker wiring — internal plumbing with no new public exports.

- 6920dc0: Wire the review phase's findings artifact to the PR — one COMMENT-event review per round plus draft/ready lifecycle (#1125).

  `@generacy-ai/workflow-engine` gains three public `GitHubClient` methods: `createReview(owner, repo, prNumber, input)` (REST `POST /pulls/{n}/reviews`, one atomic COMMENT/APPROVE/REQUEST_CHANGES submission with inline `comments[]`), `convertPullRequestToDraft(owner, repo, prNumber)` (GraphQL node-ID resolve + idempotent `convertPullRequestToDraft` mutation, mirroring `resolveReviewThread`'s retry/auth handling), and `listPullRequestFiles(owner, repo, prNumber)` (REST `GET /pulls/{n}/files`, returns `{ filename, status, patch? }[]` for diffability checks). New wire types `ReviewEvent`, `CreateReviewComment`, `CreateReviewInput`, `PullRequestFile`.

  `@generacy-ai/orchestrator` adds an internal `ReviewPoster` service that posts exactly one COMMENT review per review round (inline threads where diffable, a greppable engine marker + round number in the body, no finding dropped), dedupes re-posts by grepping existing reviews, and resolves threads for findings the artifact marks resolved on re-review rounds. `PrManager` gains an in-memory `markedReadyByEngine` flag and `convertToDraftIfEngineMarkedReady`, and the phase loop wires review-side effects (post + mark-ready-on-clean) after the review stub and draft-conversion on remediate entry. All GitHub transitions are best-effort and idempotent. The posting path is production-inert until #1124 lands the review executor — it is invoked only through the injectable `PhaseLoopDeps.readFindingsArtifact` seam, which defaults to `undefined`.

- 1484e11: Remediate phase executor — remediation counter + remediation-limit gate (#1128).

  Replaces the inert `runStubPhase('remediate')` (from #1121) with a real `RemediateExecutor` that runs a single code-change pass over the open blocking findings recorded in the review sidecar, then backtracks to `review` for verification. The loop is bounded by an explicit, resettable `remediationCount` (distinct from the monotonic `round`) that is incremented by exactly one on every executor return path — normal exit, timeout kill, and spawn failure — so a perpetually-timing-out attempt still consumes budget. At the cap the `on-remediation-limit` gate pauses with `waiting-for:remediation-limit` + `agent:paused` and posts a gate-body comment; an operator adds `completed:remediation-limit` to reset the counter and re-arm the gate. No terminal `blocked:*` label is ever applied, and the executor never resolves review threads, marks the PR ready, writes GitHub review state, or touches `round`/`verdict`. Remains byte-identical when `reviewPhaseEnabled=false`.

  `@generacy-ai/workflow-engine` (minor) adds the `completed:remediation-limit` label vocabulary.

  `@generacy-ai/generacy-plugin-claude-code` (minor) adds the `remediate` launch intent kind.

  `@generacy-ai/orchestrator` (patch) adds the remediate charter builder, the `RemediateExecutor`, the `remediationCount` sidecar field and bump/reset helpers, and the phase-loop/worker wiring — internal plumbing with no new public exports.

- 81f873b: PR-feedback monitor: exclude engine review threads, route external feedback into the remediate loop

  - `PrFeedbackMonitorService` now excludes engine-authored review threads from the trigger, so the engine's own review comments no longer re-enqueue the fixer.
  - When the review phase is enabled, trusted external PR feedback (inline threads + review bodies) is seeded into the shared `review`/`remediate` phase loop instead of the legacy fixer, and converges through the `on-remediation-limit` gate (`waiting-for:remediation-limit`).
  - The legacy (review-phase-disabled, default) fixer keeps its own bounded stop: a no-diff / push-failed cycle still applies `blocked:stuck-feedback-loop` so the monitor pauses re-enqueue until an operator clears it. Each path has a distinct bounded stop — the flag-ON path uses the `remediation-limit` gate, the flag-OFF path uses `blocked:stuck-feedback-loop`.

- a7658b4: CI-aware merge readiness — skipped≠passed + post-validate approval gate (#1133).

  The worker previously treated a PR as merge-ready the moment the `validate`
  phase succeeded. Repo `ci.yml`s skip draft PRs, and a `skipped`/`neutral` run
  reads as SUCCESS in naive rollups, so a PR whose CI never executed could sail
  through the final gate.

  Fix (behind the new independent `ciMergeGateEnabled` flag, default off →
  byte-identical to today when disabled):

  - `@generacy-ai/workflow-engine`: new public `GitHubClient.getCiRunsForSha`
    client method (primary `commits/{sha}/check-runs` readout, `actions/runs`
    fallback filtered to the head SHA, both normalized to `CiRun`), a pure
    `aggregateCiVerdict(runs)` three-state verdict (`green` | `pending` |
    `not-passed`) that drops `skipped`/`neutral` and requires ≥1 concrete
    `success` with no failures to be green, and the new `waiting-for:ci` /
    `completed:ci` label vocabulary.
  - `@generacy-ai/orchestrator`: folds a bounded exponential-backoff CI wait
    into `validate` completion (never busy-loops, pauses with `waiting-for:ci` +
    `agent:paused` on timeout), relocates the `implementation-review` gate to
    fire on `validate` via the new `on-ci-green` condition once CI is confirmed
    green, and threads `ciMergeGateEnabled` / `ciWaitTimeoutMs` from env through
    config, resolver, and phase-loop.

- 6a5b1c3: Fix validate-origin remediation to consume the shared remediation budget and have a reliable stop. Both validate-origin and review-origin remediations now converge on the single `RemediateExecutor` (each dispatch bumps `remediationCount`), so the `on-remediation-limit` gate is reachable on the validate path. The validate failure fingerprint reason is now stable across test-output nondeterminism, and the executor reports a `timedOut` signal so partial work from a timeout-kill is committed while a clean-run non-zero exit leaves the branch untouched. When a clean-run non-zero exit skips the remediate commit, the working tree is now reverted (hard-reset + clean, preserving `.generacy/`) via the new `GitHubClient.discardWorkingTreeChanges()` method so the abandoned partial fix cannot be committed by the subsequent review phase. Retires the `ValidateFixHandler` adapter and the `validate-fix` launch intent.
- c78736b: Bound the external-feedback re-entry budget, fence untrusted `detail` at ingestion, and resolve the working branch from the PR head ref (#1159).

  Fixes three composing defects on the flag-ON `address-pr-feedback` review/remediate path that together reproduced the #883-class runaway loop:

  - **Budget bounding**: a blanket `failed:*` monitor re-enqueue skip (no allow-list) — plus the two other non-completing loop exits (`waiting-for:merge-conflicts`, `waiting-for:ci`) — keeps the `clearReviewArtifact` budget reset reachable only on the two legitimate reset occasions, so the `on-remediation-limit` cap becomes globally reachable across re-entries instead of resetting on every poll.
  - **Prompt-injection fencing**: untrusted `detail` is wrapped with `wrapUntrustedData` at the two ingestion sites (seed comment body, validate-evidence output) before it reaches the remediate charter. Engine-authored review findings are not wrapped.
  - **Head-ref checkout**: on the `address-pr-feedback` re-entry, the working branch is resolved from the linked open PR's `head.ref` (zero/one/many rule) instead of `createFeature(issueNumber)`, removing the duplicate-PR path under #1043 slug drift. Linked-PR counting matches the branch's numeric prefix by value so zero-padded branches (`042-slug` under `numberPadding: 3`) are counted for issue #42. The ambiguous (>1 linked open PR) park now applies a new `blocked:ambiguous-linked-prs` label so the monitor's `blocked:*` skip suppresses re-enqueue churn and surfaces the ambiguity once for the operator.

  Internal defect fix (`workflow:speckit-bugfix`). The only new public surface is the `blocked:ambiguous-linked-prs` label vocabulary in `workflow-engine`. Whole path stays behind `reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED`; the new monitor skips only affect issues already carrying the corresponding label.

- 975156e: Keep engine bookkeeping sidecars out of PR branches (#1162).

  The phase-completion commit path staged the whole working tree with an unscoped
  `git add -A` (`stageAll()`), committing engine bookkeeping sidecars
  (`.generacy/review-findings-*`, `review-candidate-*`, `pause-context-*`) into
  product PR diffs. Because the findings sidecar carries raw validate stderr
  tails, the next review round then reviewed the engine's own bookkeeping as if it
  were product code. The orchestrator-internal fixes:

  - **FR-001/FR-002**: `PrManager.commitAndPush` now stages a targeted, filtered
    set — `[...status.staged, ...status.unstaged, ...status.untracked]` minus any
    path matching `isEngineSidecar` — and commits only when something
    product-relevant remains. Including `status.staged` means an index-only product
    change (already `git add`ed, no further working-tree diff) is no longer
    stranded. The commit is made with an explicit pathspec of that filtered set
    (`git commit -m <msg> -- <paths>`), so a sidecar some other actor pre-staged
    into the index can never be folded in by a whole-index commit — the "never
    committed" guarantee holds even against a dirty index. A sidecar-only phase
    produces no commit (no empty commits). Deletions reported in `status.unstaged`
    are still staged so removals commit. `.generacy/config.yaml` and
    `.generacy/epics/*` remain product files and continue to commit.
  - **FR-004**: the shared `ENGINE_SIDECAR_PREFIXES` predicate (`isEngineSidecar`)
    is folded into `product-diff.ts`'s `EXCLUDED_PATH_PREFIXES`, so any _already
    committed_ sidecar on a pre-fix branch is excluded from the review-round diff —
    the raw stderr tail never reaches the reviewed files. The list is the single
    source of truth for sidecar exclusion and now enumerates every
    `.generacy/<name>-<id>.json` bookkeeping file written into the checkout:
    `review-findings-`, `review-candidate-`, `pause-context-`, `external-feedback-`
    (carries raw external human/PR feedback text), and `workflow-state-`.
  - **`@generacy-ai/workflow-engine`**: `GitHubClient.commit()` gains an optional
    `pathspec?: string[]` argument (`git commit -m <msg> -- <paths>`); when omitted
    the whole index is committed (unchanged legacy behavior). This is the primitive
    the scoped phase-completion commit above relies on.
  - **FR-003**: `remediationCount` is mirrored to Redis via `PhaseTracker`
    (`remediation-count:<owner>:<repo>:<issue>:<branch>`, 7-day TTL) alongside the
    disk sidecar, reconciled on gate re-entry (`max(disk, redis)`, never lowers a
    spent budget) and cleared on `completed:remediation-limit` resume. This keeps
    the cap durable across a worker restart / re-clone now that the sidecar is no
    longer committed. Best-effort no-op when Redis is down (falls back to the disk
    value). `review-artifact.ts` gains `seedRemediationCount`.

  No new labels, no new public exports, no workflow-YAML changes. Pre-shipped repos
  with committed sidecars are cleaned up via the one-time manual
  `specs/1162-severity-major-p1-engine/scripts/cleanup-committed-sidecars.sh`.

### Patch Changes

- c78d07a: Red CI must not silently complete the workflow (#1157).

  With `ciMergeGateEnabled` on (#1133), a successful `validate` followed by red CI
  terminated the workflow indistinguishably from success: the `not-passed` verdict
  merely skipped the `on-ci-green` gate, control fell through to
  `onPhaseComplete('validate')` (granting `completed:validate`, cockpit's
  merge-eligible surface), the loop returned `completed: true`, and the completion
  flow re-marked the PR ready. No pause, no `waiting-for:*`, no comment.

  Fix (defect fix, no new public exports):

  - `@generacy-ai/orchestrator`: the `not-passed` verdict now pauses the workflow
    in the same recoverable state as the existing `timeout` pause
    (`waiting-for:ci` + `agent:paused`, no `completed:validate`), posting a
    best-effort reason comment. An unresolvable head SHA fast-fails into the same
    pause before `waitForCiGreen` is ever called. The shared `pauseForCiReadiness`
    helper never calls `onPhaseComplete`, so the red path can never grant
    `completed:validate` or reach `completed: true`. Also fail-closes the
    `actions/runs` fallback: a would-be `green` aggregated from the fallback
    (token lacks `checks:read`, third-party required checks invisible) is
    downgraded to `not-passed`.
  - `@generacy-ai/workflow-engine`: `startup_failure` and `stale` become
    first-class failing CI conclusions (union-member widening is a semantic
    correction of already-passed-through values), so a hard CI failure resolves
    promptly to `not-passed` instead of falling through to `pending` and forcing
    the slow 15-minute timeout.

- 1adc973: Reconcile review/remediate docs, comments, and enumerations with shipped
  behavior (#1167). Cockpit's `WAITING_PIPELINE_ORDER` gains
  `waiting-for:remediation-limit` (after `waiting-for:implementation-review`) and
  `waiting-for:ci` (last), and `STAGE_COMPLETE_PIPELINE_ORDER` gains
  `completed:validate` / `completed:remediate` / `completed:review` so the new
  review/remediate gates sort deterministically instead of falling back to the
  default `WORKFLOW_LABELS` index. The workflow-engine `ReviewGate` union is
  widened with the existing `remediation-limit` and `ci` gate labels for type
  completeness. No runtime behavior change — these are deterministic-ordering and
  type-surface additions only.
- 79672be: Fix the second wave of review/remediate regressions found in the post-merge review of #1153: narrow the resume-strip retain set (clarification/sibling-review/ci answers are stripped again; only remediation-limit and, under the CI gate, implementation-review survive), trust actions-runs CI green and post an honest, deduped CI-pause comment, dedupe the remediation-limit comment against issue comments, clear the Redis remediation budget on completion and at the on-ci-green approval pause, mark validate-origin/body-only findings `synthetic` so the verification pass can resolve them, gate resolution-scoped reviews on scope consumption instead of "no prior artifact", preserve engine sidecars across `git clean` while never committing them (PrManager and the legacy feedback handler), expand untracked directories in `getStatus`, and reclassify fail-then-pass infra failures against real vitest/pnpm output with a per-package fallback.

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
