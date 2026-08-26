# Changelog

## 0.13.2

### Patch Changes

- 8c925b4: Add `review` and `remediate` to the workflow phase machinery (#1121).

  Widens the canonical `WorkflowPhase` vocabulary with two new phases and threads them through every hand-maintained duplication site so the packages compile and existing runs stay byte-identical. This ships type/config/label plumbing plus inert stub execution only — real executors, prompts, verdict/finding logic, and concrete `remediate` triggers land in later epic issues.

  `@generacy-ai/workflow-engine` (minor) adds the `phase:`/`completed:`/`failed:`/`failed:*-repeated` label families for both `review` and `remediate` to `WORKFLOW_LABELS` (no `waiting-for:` gate labels) and widens the `CorePhase` union.

  `@generacy-ai/config` (minor) widens the public `template-schema` `phases` keys to accept optional `review` / `remediate` agent entries.

  `@generacy-ai/orchestrator` (patch) inserts `review` into `PHASE_SEQUENCE` between `implement` and `validate` (feature/bugfix inherit it; `speckit-epic` unchanged), maps both new phases to the `implementation` stage, adds a `reviewPhaseEnabled` flag (default `false`) that skips `review` before any label side effect fires, adds an inert stub executor for both phases, and adds an off-sequence `remediate` seam gated on an injectable `remediateTrigger` (undefined in production → dead by default).

  `@generacy-ai/generacy` (patch) adds `review` / `remediate` to the cockpit `resume` `KNOWN_PHASES` list.

- cf38f6b: Add per-workflow orchestrator overrides to `.generacy/config.yaml` (#1122).

  `@generacy-ai/config` gains a new `orchestrator.workflows.<name>` map so a target repo can vary `validateCommand`, `preValidateCommand`, `maxRemediations`, and a `review` block per workflow (e.g. `speckit-feature` vs `speckit-bugfix`). New public schema/type exports: `WorkflowReviewSchema`, `WorkflowOverrideSchema`, `WorkflowReview`, `WorkflowOverride`. Value schemas are `.strict()` so unknown keys fail loudly.

  `@generacy-ai/orchestrator` gains an internal `resolveWorkflowOverrides` resolver (plus `DEFAULT_REVIEW` and `ResolvedWorkflowConfig`) that walks each field independently with `??` — precedence workflow-level > repo-level > cluster default for validate commands, and workflow-level > built-in default for `maxRemediations`/`review` (no repo tier). No consumer wiring yet; the review/remediate phases consume it under epic #1120.

- c1154f5: Review phase executor — structured findings artifact + engine-internal verdict (#1124).

  Replaces the inert `runStubPhase('review')` (from #1121) with a real executor. The engine builds an in-process charter prompt (selected by `review.profile`), spawns the CLI via a new `review` launch intent, the agent writes a structured findings sidecar, and the engine Zod-validates the findings and **recomputes** the verdict (`clean` | `changes-required`) — the agent-claimed verdict is ignored and GitHub review state is never used (the cluster account 422s on `REQUEST_CHANGES` against its own PR). The next-phase decision is driven through the synchronous `remediateTrigger` seam, bounded by `maxRemediations` with a `waiting-for:remediation-limit` gate pause. Remains byte-identical when `reviewPhaseEnabled=false`.

  `@generacy-ai/workflow-engine` (minor) adds the `waiting-for:remediation-limit` label vocabulary.

  `@generacy-ai/generacy-plugin-claude-code` (minor) adds the `review` launch intent kind.

  `@generacy-ai/orchestrator` (patch) adds the review-artifact sidecar module, the review charter builder, the `ReviewExecutor`, the `on-remediation-limit` gate condition, and the phase-loop/worker wiring — internal plumbing with no new public exports.

- 6920dc0: Wire the review phase's findings artifact to the PR — one COMMENT-event review per round plus draft/ready lifecycle (#1125).

  `@generacy-ai/workflow-engine` gains three public `GitHubClient` methods: `createReview(owner, repo, prNumber, input)` (REST `POST /pulls/{n}/reviews`, one atomic COMMENT/APPROVE/REQUEST_CHANGES submission with inline `comments[]`), `convertPullRequestToDraft(owner, repo, prNumber)` (GraphQL node-ID resolve + idempotent `convertPullRequestToDraft` mutation, mirroring `resolveReviewThread`'s retry/auth handling), and `listPullRequestFiles(owner, repo, prNumber)` (REST `GET /pulls/{n}/files`, returns `{ filename, status, patch? }[]` for diffability checks). New wire types `ReviewEvent`, `CreateReviewComment`, `CreateReviewInput`, `PullRequestFile`.

  `@generacy-ai/orchestrator` adds an internal `ReviewPoster` service that posts exactly one COMMENT review per review round (inline threads where diffable, a greppable engine marker + round number in the body, no finding dropped), dedupes re-posts by grepping existing reviews, and resolves threads for findings the artifact marks resolved on re-review rounds. `PrManager` gains an in-memory `markedReadyByEngine` flag and `convertToDraftIfEngineMarkedReady`, and the phase loop wires review-side effects (post + mark-ready-on-clean) after the review stub and draft-conversion on remediate entry. All GitHub transitions are best-effort and idempotent. The posting path is production-inert until #1124 lands the review executor — it is invoked only through the injectable `PhaseLoopDeps.readFindingsArtifact` seam, which defaults to `undefined`.

- 1ec9980: Add delta-scoped verification-pass convergence logic for the engine-native `review`
  phase (#1126). A re-review (round ≥ 2) is now scoped to the change set since the
  last-reviewed SHA — or, for a merge-conflict re-arm, the resolution base/head SHAs
  carried on the pause-context sidecar — unioned with still-open findings, so
  review⇄remediate loops converge instead of inventing fresh nitpicks each round.

  New internal module `packages/orchestrator/src/worker/review/`: `determineReviewMode`
  (full-review round 1 vs. verification round n+1), `computeReviewDelta` (resolution →
  last-reviewed → full-diff base selection, widening safely on an unresolvable SHA
  without resetting to round 1), `composeVerificationInput`, `buildVerificationPrompt`,
  and a monotonic status machine (`advanceArtifact` / `filterNewFindings` /
  `computeVerdict`) that resolves addressed delta-located findings, keeps `resolved`
  terminal, drops sub-blocking advisory findings after round 1, and advances the
  last-reviewed SHA. The findings-artifact interface is a placeholder seam for #1124.
  `PauseContextSchema` gains read-side optional `resolutionBaseSha`/`resolutionHeadSha`
  (written by #1131). No new public package exports.

- 428f8c6: Add a standalone deterministic engine-authored review marker-match helper
  (`matchEngineAuthoredReviewMarker` / `commentCarriesEngineAuthoredReviewMarker` /
  `ENGINE_AUTHORED_REVIEW_MARKERS`) co-located in the review-poster marker module
  (#1127 D-3 fallback). Line-anchored at column 0, case-sensitive ASCII; `> `-quoted
  markers do not match. Internal surface consumed by #1130's monitor routing; not
  re-exported from the package's public entrypoint.
- 1484e11: Remediate phase executor — remediation counter + remediation-limit gate (#1128).

  Replaces the inert `runStubPhase('remediate')` (from #1121) with a real `RemediateExecutor` that runs a single code-change pass over the open blocking findings recorded in the review sidecar, then backtracks to `review` for verification. The loop is bounded by an explicit, resettable `remediationCount` (distinct from the monotonic `round`) that is incremented by exactly one on every executor return path — normal exit, timeout kill, and spawn failure — so a perpetually-timing-out attempt still consumes budget. At the cap the `on-remediation-limit` gate pauses with `waiting-for:remediation-limit` + `agent:paused` and posts a gate-body comment; an operator adds `completed:remediation-limit` to reset the counter and re-arm the gate. No terminal `blocked:*` label is ever applied, and the executor never resolves review threads, marks the PR ready, writes GitHub review state, or touches `round`/`verdict`. Remains byte-identical when `reviewPhaseEnabled=false`.

  `@generacy-ai/workflow-engine` (minor) adds the `completed:remediation-limit` label vocabulary.

  `@generacy-ai/generacy-plugin-claude-code` (minor) adds the `remediate` launch intent kind.

  `@generacy-ai/orchestrator` (patch) adds the remediate charter builder, the `RemediateExecutor`, the `remediationCount` sidecar field and bump/reset helpers, and the phase-loop/worker wiring — internal plumbing with no new public exports.

- 9fe10bf: Route a failing `validate` phase into the engine-native review → remediate →
  validate loop instead of the legacy one-shot `validate-fix-handler` side path
  (`workflow:speckit-bugfix`). On a validate red with `reviewPhaseEnabled`, the
  phase loop checks the failure-fingerprint backstop first (escalating with
  `failed:validate-repeated` at the repeat threshold), otherwise synthesizes a
  `changes-required` review artifact and backtracks into `review`, dispatching the
  thin remediate adapter at exactly one site — the remediate seam. `failed:validate`
  is no longer applied on the routed path (the loop owns escalation), and the
  `resumeReason === 'base-advance'` precondition is removed. With
  `reviewPhaseEnabled = false` behavior is byte-identical to before. No new public
  exports and no new label vocabulary.
- 81f873b: PR-feedback monitor: exclude engine review threads, route external feedback into the remediate loop

  - `PrFeedbackMonitorService` now excludes engine-authored review threads from the trigger, so the engine's own review comments no longer re-enqueue the fixer.
  - When the review phase is enabled, trusted external PR feedback (inline threads + review bodies) is seeded into the shared `review`/`remediate` phase loop instead of the legacy fixer, and converges through the `on-remediation-limit` gate (`waiting-for:remediation-limit`).
  - The legacy (review-phase-disabled, default) fixer keeps its own bounded stop: a no-diff / push-failed cycle still applies `blocked:stuck-feedback-loop` so the monitor pauses re-enqueue until an operator clears it. Each path has a distinct bounded stop — the flag-ON path uses the `remediation-limit` gate, the flag-OFF path uses `blocked:stuck-feedback-loop`.

- d4c7f66: Merge-conflict re-arm targets a resolution-scoped review, not the interrupted phase (#1131).

  After `MergeConflictHandler` successfully resolves a merge conflict, the worker now re-arms into a `review` phase scoped to just the resolution diff (`baseSha..headSha` — the pre-merge branch tip → the `--no-ff` merge commit) instead of blindly resuming the interrupted phase. This closes a semantic-conflict safety gap: a git-clean-but-semantically-broken merge previously sailed straight back into the phase it interrupted with no correctness review of the resolution.

  The re-arm is gated on `reviewPhaseEnabled`: when the flag is OFF, behavior is byte-identical to before (`startPhase: metadata.phase`). When the scope SHAs can't be determined, it re-arms `review` with a whole-branch fallback (scope omitted). An empty resolution window short-circuits the review executor straight to `validate`. `reviewScope`/`diffWindow` are orchestrator-internal and not re-exported.

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

- 9f309be: Bugfix profiles: verification review charter, targeted validate with
  diff-classification guards, and an opt-in fail-then-pass regression proof.

  The `verification` review profile now interrogates four bugfix questions (root
  cause vs symptom, regression test present, scope creep, regression risk). For
  `speckit-bugfix` runs the validate phase classifies the diff and rewrites the
  built-in default validate command to the pnpm `...[origin/<base>]` filter form
  (with docs-only, test-only, single-package, and full-fallback safety guards),
  logging the decision; custom validate commands run verbatim. An opt-in
  `failThenPass` check proves changed test files fail on the base ref and pass on
  the branch, using an isolated git worktree. Internal worker behavior only — no
  new public API and no workflow-engine label vocabulary.

- 109f5df: Resume label-strip no longer discards human-gate answers (#1154).

  `LabelManager.onResumeStart()` runs before the phase loop on every `continue`
  and stripped `completed:<X>` for every co-present `waiting-for:<X>` gate.
  Pre-epic gates survived because their resume phase is past the gate, but the
  two new epic gates (`remediation-limit` and the on-ci-green
  `implementation-review`) re-evaluate at the resumed phase and depend on the
  surviving `completed:<X>` label — so the operator's answer was silently
  discarded and the workflow re-parked, making the gates un-answerable.

  Fix (internal bug fix across `label-manager.ts`, `phase-resolver.ts`, and
  `phase-loop.ts`; no new public exports, no new label vocabulary — `waiting-for:ci`
  / `completed:ci` already ship from #1133):

  - Guard the completed-strip loop in `onResumeStart()` with
    `!isHumanGateCompletion(...)` so every `completed:<X>` for a human-gate
    suffix survives the resume strip; stale `waiting-for:*` and `agent:paused`
    removals are unchanged.
  - Add `'ci': { phase: 'validate', resumeFrom: 'validate' }` to `GATE_MAPPING`,
    which auto-includes `ci` in the derived `HUMAN_GATE_SUFFIXES` and gives
    `completed:ci` a defined resume phase.
  - Marker-dedupe the "Remediation limit reached" gate-body comment on the
    `<!-- generacy-remediation-limit -->` marker so a re-parked cap does not
    re-post it every resume cycle.
  - Best-effort defensive clear of a lingering `completed:remediation-limit` on
    any clean pass through `review`.

  Both fixes sit behind the epic's existing feature flags
  (`reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED`; `ciMergeGateEnabled` /
  `WORKER_CI_MERGE_GATE_ENABLED`) — a flag-off cluster is unaffected.

- 77e8334: Review executor must fail (not falsely pass) on CLI failure, timeout, or missing findings (#1155).

  Fixes a critical (P0) phantom-clean verdict: the review-phase executor returned `success: true, exitCode: 0` unconditionally and `readCandidateFindings` returned `[]` for a missing/invalid sidecar, so a review whose CLI died, timed out, or crashed was read as zero findings, computed to a `clean` verdict, and advanced the unreviewed change to `validate` (and marked the PR ready) as though a real review had confirmed it.

  The executor now propagates the real child exit code / timeout into `PhaseResult` (mirroring `remediate-executor.ts`), and the agent writes its findings to a separate candidate path (`review-candidate-<id>.json`) that the engine clears before spawning, so a candidate present after the spawn is provably written this round. `readCandidateFindings` returns `ReviewFinding[] | null` — `null` (missing / unreadable / invalid) is treated as no proof of review, `[]` is a genuine clean review. A failed / no-verdict round persists nothing: any prior-round engine artifact — including `round` and `remediationCount` — is left exactly as-is, so repeated failures cannot burn the #1128 remediate cap and a crash between the candidate write and the engine rewrite cannot silently reset the budget. The happy path (valid candidate, exit 0) is byte-identical to before. The new candidate-path helpers are internal worker surface, not re-exported from the package public `index.ts`.

- 8a5375a: Wire the PR review-posting + draft/ready lifecycle — the reader was never supplied (#1156).

  The entire #1125 PR-visibility/lifecycle block in the phase loop was dead in production: it guards on both `deps.reviewPoster` and `deps.readFindingsArtifact`, but the worker wiring site supplied only the poster and left the reader `undefined`, so the guard was permanently false. As a result no COMMENT-event review ever posted, re-review never resolved inline threads, the clean-verdict `markReadyForReview` never fired, and `convertToDraftIfEngineMarkedReady` was a guaranteed no-op.

  This supplies the `readFindingsArtifact` closure (via a new pure `bridgeReviewArtifact()` in `review-findings-bridge.ts` that maps the engine-written `ReviewArtifact` sidecar into the `FindingsArtifact` the poster consumes) plus the four latent-defect corrections wiring it exposes: severity-threshold bridging consistent with `computeVerdict`, a live `getPrNumber` getter on `ReviewPoster` (kills the "post to PR #0" bug for early rounds), the posting/gating `round` taken from the sidecar rather than the loop-local counter that resets each run, and a cross-run `markedReadyByEngine` flag persisted in the sidecar so a later re-entry can convert a previously-engine-marked-ready PR back to draft without ever demoting a human-marked-ready PR.

  Internal plumbing only — no new public exports. Whole path stays inert when `reviewPhaseEnabled=false` or no sidecar is produced.

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

- 6a5b1c3: Fix validate-origin remediation to consume the shared remediation budget and have a reliable stop. Both validate-origin and review-origin remediations now converge on the single `RemediateExecutor` (each dispatch bumps `remediationCount`), so the `on-remediation-limit` gate is reachable on the validate path. The validate failure fingerprint reason is now stable across test-output nondeterminism, and the executor reports a `timedOut` signal so partial work from a timeout-kill is committed while a clean-run non-zero exit leaves the branch untouched. When a clean-run non-zero exit skips the remediate commit, the working tree is now reverted (hard-reset + clean, preserving `.generacy/`) via the new `GitHubClient.discardWorkingTreeChanges()` method so the abandoned partial fix cannot be committed by the subsequent review phase. Retires the `ValidateFixHandler` adapter and the `validate-fix` launch intent.
- c78736b: Bound the external-feedback re-entry budget, fence untrusted `detail` at ingestion, and resolve the working branch from the PR head ref (#1159).

  Fixes three composing defects on the flag-ON `address-pr-feedback` review/remediate path that together reproduced the #883-class runaway loop:

  - **Budget bounding**: a blanket `failed:*` monitor re-enqueue skip (no allow-list) — plus the two other non-completing loop exits (`waiting-for:merge-conflicts`, `waiting-for:ci`) — keeps the `clearReviewArtifact` budget reset reachable only on the two legitimate reset occasions, so the `on-remediation-limit` cap becomes globally reachable across re-entries instead of resetting on every poll.
  - **Prompt-injection fencing**: untrusted `detail` is wrapped with `wrapUntrustedData` at the two ingestion sites (seed comment body, validate-evidence output) before it reaches the remediate charter. Engine-authored review findings are not wrapped.
  - **Head-ref checkout**: on the `address-pr-feedback` re-entry, the working branch is resolved from the linked open PR's `head.ref` (zero/one/many rule) instead of `createFeature(issueNumber)`, removing the duplicate-PR path under #1043 slug drift. Linked-PR counting matches the branch's numeric prefix by value so zero-padded branches (`042-slug` under `numberPadding: 3`) are counted for issue #42. The ambiguous (>1 linked open PR) park now applies a new `blocked:ambiguous-linked-prs` label so the monitor's `blocked:*` skip suppresses re-enqueue churn and surfaces the ambiguity once for the operator.

  Internal defect fix (`workflow:speckit-bugfix`). The only new public surface is the `blocked:ambiguous-linked-prs` label vocabulary in `workflow-engine`. Whole path stays behind `reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED`; the new monitor skips only affect issues already carrying the corresponding label.

- a1099e3: Wire four silently-dropped per-workflow/agent config keys so they take effect at runtime (#1160).

  Four config keys shipped by the engine-native review/remediate epic parsed cleanly (or were documented) but were ignored at their runtime call sites:

  - `validateCommand` — the non-bugfix validate seed now resolves through `resolveWorkflowOverrides` so a per-workflow `workflows.<name>.validateCommand` reaches the validate spawn. `speckit-bugfix` keeps its targeted-validate narrowing composed over the resolved base.
  - `preValidateCommand` — the pre-validate install step now reads the resolved value; an explicit `""` at the workflow tier skips the install, while an unset tier falls through to the repo/cluster default.
  - `phases.review` / `phases.remediate` agent selection — the review and remediate executors now resolve the agent via a new field-by-field `resolveReviewLikeAgent`, preferring the phase tier and falling back to the full `implement` resolution per field. Remediate never inherits the `review` tier.
  - `ciWaitTimeoutMs` — added as an optional per-workflow override on the public `WorkflowOverride` schema (bounded `>= 30_000`, mirroring the cluster floor) and wired into the CI-readiness wait.

  `@generacy-ai/config` bumps **minor** (additive optional `ciWaitTimeoutMs` on the public `WorkflowOverride` type — new user-facing config surface). `@generacy-ai/orchestrator` bumps **patch** (internal call-site wiring plus the new non-exported `resolveReviewLikeAgent`; no public export change).

- ea0b243: Collapse the parallel review findings-artifact schemas, unify the verdict/severity logic, and activate the convergence engine inside the live review executor (#1161).

  Three separate findings-artifact shapes, two `computeVerdict` implementations, and three `SEVERITY_RANK` tables had accreted across the review/remediate path. This consolidates them onto a single canonical `ReviewFinding`/`ReviewArtifact` schema, one `computeVerdict`, and one `SEVERITY_RANK` in `worker/review-artifact.ts`. Findings now carry a deterministic `id` (`sha256(file + "\0" + title)` sliced to 24 hex chars). The finding `round` constraint is tightened from non-negative to positive to match its semantics (rounds start at 1). A `backfillFindingFields` pass runs before Zod validation so pre-#1161 sidecars still parse: it default-fills a missing `id` and normalizes the pre-#1161 seed-synthesized `round: 0` up to `1` (an un-normalized 0 would otherwise fail the tightened schema and silently discard all prior review state on a mid-issue upgrade).

  The #1126 delta-scoped convergence merge (round-N→N+1 carry-forward + verdict recompute) now runs end-to-end **inside** the live review executor; the old `runReviewConvergence` phase-loop pre-pass is deleted, so the round lives only in the sidecar (single round source). The per-workflow default `blockingSeverity` is reconciled to `major` for `speckit-feature` and `critical` for every other workflow, in both code and `docs/reference/review-artifacts.md`, and a `settings = null` resolution path is fixed.

  Internal consolidation and bug fix — no new public exports, no new label vocabulary. The whole path stays behind `reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED`, so a flag-off cluster is byte-identical.

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

- 5dfedcb: Fix four merge-conflict scoped-review lifecycle defects (#1164, `workflow:speckit-bugfix`).

  The merge-conflict → scoped-review path introduced with the engine-native review/remediate epic carried four related defects. All fixes are orchestrator-internal (`worker/` surface, not re-exported at the package public boundary); no new label vocabulary and no new persisted state. Both epic flags (`reviewPhaseEnabled`, `ciMergeGateEnabled`) remain the on/off switches — a cluster with both OFF is unaffected.

  - **Stale `reviewScope` (FR-001/FR-002)** — the review executor now honors `context.reviewScope` only on round 1 (`!priorRound`). Round 2+ falls back to the standard `lastReviewedCommitSha`..HEAD delta, so remediation commits are visible and the loop converges instead of burning to the remediation cap with the defect already fixed.
  - **Base-delta resolution scope (FR-003)** — the resolution scope now carries the live conflicted-path allowlist (`git diff --name-only --diff-filter=U`) on the post-conflict-resolution success path only; the charter names the allowlist instead of the full parent-1 base delta. No-op and clean-merge success paths leave it absent and fall back to the pre-#1164 range description.
  - **Trivial-diff charter rule (FR-004/FR-005)** — the "empty or trivial diff → blocking finding" paragraph is emitted only for whole-PR round-1 reviews (`!verification && !diffWindow`), so a small-but-valid scoped resolution no longer triggers a spurious `changes-required` loop.
  - **Validate-bypass + crash window (FR-006/FR-007/FR-008)** — `applySuccessDisposition` now also removes `completed:validate` + `completed:implementation-review` on re-arm so the terminal short-circuit no longer fires on the post-merge tree and `validate` runs on the merged tree before mark-ready. Ownership-label clearing moves to an `afterEnqueue` closure invoked after `enqueueIfAbsent` resolves, converting the pre-#1164 "no label + no work" stall into a benign "queued work + stale ownership label".

- 2ff9839: Close four flag-matrix guardrail corners for the review/remediate epic (#1165, `workflow:speckit-bugfix`).

  Corner 4 (`worker/types.ts`): `getPhaseSequence` now filters `review` out of the fallback sequence for an unknown/custom workflow regardless of `reviewPhaseEnabled`, so only known workflows can opt into the `review` phase. Corner 1 (`worker/phase-loop.ts`): on the default (`reviewPhaseEnabled` OFF) path a failing `validate` gets exactly one bounded remediate attempt before escalating, keeping the legacy path self-healing without the full engine-native review→remediate loop. Corners 2 and 3 are doc/test-only (legacy `blocked:stuck-feedback-loop` bound reconcile; `speckit-bugfix` `on-ci-green` gate pin) and add no runtime behavior. Both epic flags remain default `false`, so a flags-OFF cluster is byte-identical to before.

- a56f79e: Harden the `speckit-bugfix` targeted-validate classifier and fail-then-pass regression prover (#1166).

  Closes seven post-merge-review defects (#1134/#1150) in the bugfix-profile validate path, all in the wiring layer — the pure `classifyDiff` classifier stays untouched:

  - **targeted-validate wiring** (`phase-loop.ts`): existence-filter the changed-file set before classification so deletion-only and rename diffs never emit `pnpm vitest run <nonexistent-file>`; probe `pnpm ls --filter "...[origin/<base>]"` for the built-in default and fall back to the full command when the selection is empty or the probe errors (fail-safe); substitute `<base>` in custom `validateCommand`s with the resolved base branch so the same command works on `develop`- and `main`-based repos.
  - **fail-then-pass prover** (`fail-then-pass.ts`): a conservative `isInfraFailure` predicate maps pre-collection failures (zero tests collected, dist/module-resolution errors) to `skip` instead of a false `base-passed`/`branch-failed`; a base-test timeout maps to `skip: timeout` while phase-signal aborts still propagate; the worktree lifecycle is made best-effort and signal-free in `finally`, and a `git worktree add` failure skips rather than throwing.

  Every new fallback/skip/infra decision emits exactly one structured log line. Non-bugfix workflows and non-triggering bugfix runs stay byte-identical.

- 4e0ad87: Add an engine-side `tasks.md` safety net for the implement→continue increment (#1187, `workflow:speckit-bugfix`).

  The implement→continue increment previously fired only when the agent emitted a `SPECKIT_IMPLEMENT_PARTIAL` sentinel. When the agent stopped mid-tasklist without emitting it, `result.implementResult` was `undefined`, the re-loop was skipped, `completed:implement` was granted, and a substantially-unfinished tree advanced into review→remediate (which caps and stalls).

  The fix adds an engine-side fallback: after a `success` implement phase with **no** sentinel, the engine reads the workflow's `tasks.md`, counts unchecked `- [ ]` tasks, and — when work remains — synthesizes a `result.implementResult` so the existing increment block (WIP commit/push, fresh session, no-progress guard, `i--; continue`) drives re-entry unchanged. The sentinel stays the fast path; `tasks.md` becomes the fallback source of truth. All changes are orchestrator-internal (`worker/` surface, not re-exported at the package public boundary); no new public exports and no new label vocabulary. A fully-checked or task-less `tasks.md` advances exactly as today, and an unreadable/ambiguous fallback source logs and advances (fail-open).

  Also fixes a latent teardown hang in `@generacy-ai/generacy`'s cockpit doorbell `AnswersFileSource`: the `fs.watch` async iterator was awaited on `stop()` without an `AbortSignal`, so a pending `next()`/`return()` never settled once the watch loop was active (parent dir present), hanging teardown until the test timeout. An `AbortController` is now wired through the watcher and aborted before `stop()` awaits the iterator's `return()`.

- b7b6151: Fix the clarify gate silently self-answering and skipping (#1189).

  The FR-004 discriminator that distinguishes a question comment from a cockpit answer block required a colon after `Q<n>` (`### Q1: Topic`). A clarification batch posted with a different separator — `### Q1 — Topic` — therefore fell on the answer-block side of the test: the fail-closed guard never fired, `parseAnswersFromComments` captured each question's own topic as its answer, `clarifications.md` was written with `**Answer**: — <question title>`, every question read as answered, and the `on-questions` gate was skipped. The workflow then ran plan → tasks → implement on unanswered design questions, and because integration only ever replaces the literal `*Pending*`, a real answer posted afterwards could never land.

  The discriminator now keys on whether the `Q<n>` heading line carries any trailing content, which is the property that actually separates the two shapes: a question comment always names its topic on the heading line, while a cockpit answer block writes a bare `### Q1` and puts the answer on the next line. A bare heading (with or without trailing whitespace) still does not match, so legitimate cockpit integrations are unaffected.

- 7be3119: Teach the `tasks.md` safety net to recognize the heading task grammar (#1192, `workflow:speckit-bugfix`).

  The #1187 safety net counted only GitHub-style checkbox task lines (`- [ ] T001`). The implement prompt emits **two** task grammars — checkbox and heading (`### T001` unchecked → `### T001 [DONE]` done). A `tasks.md` written in the heading grammar parsed as zero task lines, so `evaluateTasksMd` returned `{ kind: 'complete', total: 0 }`, the safety net no-op'd, `completed:implement` was granted, and a substantially-unfinished tree advanced into review→remediate — silently reproducing the exact bug #1187 was built to prevent.

  The fix is additive and confined to `countTasks`: heading-task detection (`### T001`) with a strict `[DONE]` position (checked only when `[DONE]` immediately follows the task-ID token) and a boundary that rejects range/summary follow-ons (`### T001-T026 remaining`, en-/em-dash variants). Both grammars feed the same `{ unchecked, checked, total }` tally, so mixed-grammar files sum. Checkbox behavior is byte-identical. The phase-loop `complete` branch also gains one log-only `info` line keyed on `total === 0`, so an operator can distinguish "no task lines recognized in either grammar" from a legitimate all-checked advance. All changes are orchestrator-internal (`worker/` surface); no new public exports and no new label vocabulary.

- a625c4c: Capture the agent's real messages in CLI-phase failure comments. The worker's
  `OutputCapture` stores every Claude CLI stream-json line as a `type: 'text'`
  chunk whose `data` is the raw envelope, so the agent's prose lives at
  `data.message.content[].text` (assistant turns) or `data.result` (final turn) —
  not at a flat `data.text`. `synthesizeOutputTail` only read `data.text`, so every
  CLI-phase failure comment (e.g. `implement` failing `no-product-code-changes`)
  rendered an empty or one-line "output (last N lines)" tail even when the agent
  had explained itself at length. Extract text from all three envelope shapes so
  the diagnostic tail carries the agent's last message — the "why it stopped"
  narrative that is the whole point of the failure comment — while still skipping
  structural tool/lifecycle chunks and de-duplicating the trailing `result` echo.
- 06c6b3e: Grant `completed:review` only on a clean review verdict. The phase loop granted
  `completed:review` on every successful review-phase execution — before the
  verdict was inspected — so a `changes-required` review (about to remediate and
  re-review) was labelled "review completed" while its findings were still open.
  That misreported progress (cockpit's `STAGE_COMPLETE_PIPELINE_ORDER` treats
  `completed:review` as a stage-complete marker) and set the label-derived-resume
  trap the merge-conflict path already carries an explicit-`startPhase` workaround
  for (a resume could resolve straight past an open review into `validate`).

  The review verdict is now read up front and the grant is gated on it: a
  `changes-required` pass clears `phase:review` without granting `completed:review`
  (new `LabelManager.onPhaseExecutedWithoutCompletion`), and the clean grant lands
  on the converging pass. The cap/remediate/verdict logic keys on the review
  sidecar (`verdict` / `remediationCount` / `round`), never on this label, so
  withholding it is behavior-safe.

- 79672be: Fix the second wave of review/remediate regressions found in the post-merge review of #1153: narrow the resume-strip retain set (clarification/sibling-review/ci answers are stripped again; only remediation-limit and, under the CI gate, implementation-review survive), trust actions-runs CI green and post an honest, deduped CI-pause comment, dedupe the remediation-limit comment against issue comments, clear the Redis remediation budget on completion and at the on-ci-green approval pause, mark validate-origin/body-only findings `synthetic` so the verification pass can resolve them, gate resolution-scoped reviews on scope consumption instead of "no prior artifact", preserve engine sidecars across `git clean` while never committing them (PrManager and the legacy feedback handler), expand untracked directories in `getStatus`, and reclassify fail-then-pass infra failures against real vitest/pnpm output with a per-package fallback.
- Updated dependencies [8c925b4]
- Updated dependencies [cf38f6b]
- Updated dependencies [c1154f5]
- Updated dependencies [6920dc0]
- Updated dependencies [1484e11]
- Updated dependencies [81f873b]
- Updated dependencies [a7658b4]
- Updated dependencies [c78d07a]
- Updated dependencies [6a5b1c3]
- Updated dependencies [c78736b]
- Updated dependencies [a1099e3]
- Updated dependencies [975156e]
- Updated dependencies [d6d53d7]
- Updated dependencies [1adc973]
- Updated dependencies [79672be]
  - @generacy-ai/workflow-engine@0.7.0
  - @generacy-ai/config@0.6.0
  - @generacy-ai/generacy-plugin-claude-code@0.6.0
  - @generacy-ai/cockpit@0.9.0
  - @generacy-ai/control-plane@0.8.2

## 0.13.1

### Patch Changes

- d533b41: Tighten the implement-phase "produced no product-code changes" guard so it can no longer be structurally defeated on speckit branches (#1107).

  `@generacy-ai/workflow-engine` gains two local-git `GitHubClient` methods: `getCurrentCommitSha()` (`git rev-parse HEAD`) and `getFilesChangedByOwnCommits(startRef)` (`git log --first-parent --no-merges --name-only <startRef>..HEAD`), which isolate the files a branch's own commits touched — immune to base-merge-introduced and earlier-phase files.

  `@generacy-ai/orchestrator` now (a) excludes the spec-kit `update_agent` targets (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`) by exact root-relative filename via a new `EXCLUDED_EXACT_PATHS` set, and (b) measures a phase-scoped diff window anchored to a start ref captured after the pre-implement base merge and persisted in Redis (via new `PhaseTrackerService` raw string get/set/clear) so it spans all pre-restart increments. The pass/fail surface, escalation path, and detection-failure fallback are unchanged.

- c5343ef: Remove two false-failure paths in the #1107 phase-scoped product-diff guard (#1112).

  `@generacy-ai/workflow-engine` gains a local-git `GitHubClient` method `commitExistsInCheckout(sha)` (`git rev-parse --verify --quiet <sha>^{commit}`): exit 0 → true, exit 1 (commit-missing, full or abbreviated sha) → false, any other exit → throw, so an environment fault is never mistaken for a missing commit.

  `@generacy-ai/orchestrator` reworks the phase-start-ref capture/reuse block so it (a) reads through to the pre-#1110 legacy Redis key (no branch component) on a branch-scoped miss, migrating a valid value to the branch-scoped key before consuming the legacy key once, and (b) verifies a reused ref resolves in the current checkout before anchoring the diff window — re-capturing fresh HEAD when it does not. A non-commit-missing git fault still surfaces via the existing detection-failure path (`product-diff-error` + escalation). The pass/fail surface, escalation path, exclusion lists, and TTL are unchanged.

- Updated dependencies [d533b41]
- Updated dependencies [c5343ef]
  - @generacy-ai/workflow-engine@0.6.0
  - @generacy-ai/cockpit@0.8.1

## 0.13.0

### Minor Changes

- dcf915d: Cockpit auto model/effort configuration + effort on conversation launches.

  `@generacy-ai/cockpit`: `CockpitConfigSchema` gains an optional `auto` block
  (`cockpit.auto` in `.generacy/config.yaml`) for the `/cockpit:auto` run loop —
  `loop` (model/effort for the loop session, consumed by headless launchers),
  `heartbeatSeconds` (base heartbeat interval, 60–3600), `quiet` (suppress
  transcript narration for headless runs), and `agents` (per-role
  `{ provider?, model?, effort? }` selectors for the clarifier / reviewer /
  validator / fixer / diagnoser analysis subagents, mirroring the orchestrator's
  `AgentEntrySchema`). An invalid `auto` block degrades to a loader warning and
  is ignored, so it can never break `owner`/`assignee` consumers.

  `@generacy-ai/orchestrator` + `@generacy-ai/generacy-plugin-claude-code`:
  `ConversationTurnIntent` / `POST /conversations` gain an optional `effort`
  field, threaded through `ConversationManager`/`ConversationSpawner` to
  `claude --effort <level>` — the phase path already supported effort; the
  conversation path (used for headless slash-command launches like
  `/cockpit:auto`) now does too.

### Patch Changes

- Updated dependencies [dcf915d]
  - @generacy-ai/cockpit@0.8.0
  - @generacy-ai/generacy-plugin-claude-code@0.5.0

## 0.12.1

### Patch Changes

- c06f16d: Widen `WebhookSetupService.LOCKED_EVENTS` from 4 to 7 entries (adds `pull_request_review`, `pull_request_review_comment`, `issue_comment`) so PR-review feedback and clarification-answer comments arrive over the smee channel instead of waiting for the (adaptively widened) poll interval (FR-001). Heal existing active Generacy webhooks on orchestrator boot: when a hook's events are a strict subset of `LOCKED_EVENTS`, PATCH the hook to include the missing events, count as `reactivated`, emit `info: Existing webhook was missing events — patched` in place of the pre-fix warn line (FR-002 / FR-003 / FR-004). Reactivate branch now merges the full `LOCKED_EVENTS` set instead of only `'issues'` so reactivated hooks are not born already stale (FR-005). Public API (`WebhookSetupResult.action` union, `WebhookSetupSummary` shape) unchanged. Fixes #1092.
- 75ba0f7: Add optional per-phase `effort` alongside `model` on the `orchestrator.agents` block (#1095), and bring the two fixer paths that ignored agent config into parity with `pr-feedback-handler`.

  - `@generacy-ai/config`: new `EffortSchema` enum (`low | medium | high | xhigh | max`), new optional `effort` field on `AgentEntrySchema`, and `.strict()` on `AgentEntrySchema` / `WorkflowAgentEntriesSchema` (both levels) / `AgentsConfigSchema`. Typos inside `orchestrator.agents` (`defualt:`, `implment:`, `efort:`) now fail validation; typos outside the block continue to strip silently.
  - `@generacy-ai/generacy-plugin-claude-code`: new public static `ClaudeCodeLaunchPlugin.hasEffortMechanism()` — probes `claude --help` once per process (result cached) and reports whether `--effort` is a recognized flag, so a container whose CLI predates or removes `--effort` reports `false` and the drop warning fires instead of a silent unknown-option spawn failure. `--effort` is now appended by all four builders (`buildPhaseLaunch`, `buildPrFeedbackLaunch`, `buildValidateFixLaunch`, `buildMergeConflictLaunch`). `buildValidateFixLaunch` and `buildMergeConflictLaunch` also gain the `--model` push previously missing on those two paths.
  - `@generacy-ai/generacy`: new `loadConfigWithWarnings` helper + `warnings` field on `generacy validate --json` output. When `effort` is set but the resolved provider has no CLI mechanism for effort in this release, a warning naming both `effort` and the provider is surfaced on both the auto-discovery and explicit-path branches (exit code stays 0). New "Orchestrator Agent Selection" section in `docs/docs/getting-started/configuration.md` and an updated `packages/generacy/examples/config-full.yaml` demonstrate the block with `effort:`.
  - `@generacy-ai/orchestrator`: internal plumbing only — `mergeAgentEntry` and `resolveAgentForPhase` learn to walk `effort` as a fourth independent field; `CliSpawnOptions` + `PhaseIntent` / `PrFeedbackIntent` / `ValidateFixIntent` / `MergeConflictIntent` gain the field; `validate-fix-handler` and `merge-conflict-handler` now call `resolveAgentForPhase(config, workflowName, 'implement')` and forward `{ provider, model, effort }` to their intents and `LaunchRequest.provider`. `cli-spawner` and all three fixer handlers (`pr-feedback`, `validate-fix`, `merge-conflict`) emit one `agent.effort.dropped` warn line per spawn when `effort` cannot be delivered (extracted into shared `effort-mechanism-check.ts`). `MergeConflictMonitorService` now enqueues unlabeled paused issues with `workflowName: 'unknown'` (mirrors `pr-feedback-monitor-service.resolveWorkflowName`) so the handler-side Q1=B fallback is reachable in production.

  Behavior-preserving: any repo with no `agents` block, or with `agents` set but `effort` unset, produces byte-identical argv + env across all four spawn paths (SC-004).

- Updated dependencies [5df2231]
- Updated dependencies [75ba0f7]
  - @generacy-ai/config@0.5.0
  - @generacy-ai/generacy-plugin-claude-code@0.4.0
  - @generacy-ai/cockpit@0.7.1
  - @generacy-ai/control-plane@0.8.1

## 0.12.0

### Minor Changes

- ff142d7: Make the per-user execution lease path functional in worker mode so concurrent
  cockpit auto sessions can execute in parallel across worker replicas (#1016).

  The cluster-side lease protocol (#418) was dead end-to-end: `cluster-relay`'s
  `RelayMessageSchema` did not include any lease message types, so every inbound
  `lease_response` / `slot_available` / `cluster_rejected` was dropped at the
  Zod parse; the orchestrator additionally expected `lease_granted`/`lease_denied`
  message types the cloud never sends (it sends a single `lease_response`
  discriminated by `status`); and worker mode — the only mode that runs the
  dispatcher — never routed inbound relay messages to its LeaseManager at all.
  Net effect: dispatch was never lease-gated, and a lease denial (had it ever
  arrived) would have paused a replica's polling forever on a missed
  `slot_available`.

  Changes:

  - `cluster-relay`: add lease-protocol message types + schemas matching the
    cloud wire contract (`lease_request`, `lease_release`, `lease_heartbeat`,
    `lease_response`, `slot_available`, `cluster_rejected`, `tier_info`).
  - `orchestrator`: `LeaseManager` consumes `lease_response` (granted / denied /
    released / error), learns the tier's concurrency limit from the denial
    payload (the cloud never emits `tier_info`), sends the `correlationId` the
    cloud requires on `lease_release` (releases were previously refused
    server-side and only expired by TTL), and swallows release acks.
  - `orchestrator`: worker mode wires inbound relay messages to the dispatcher's
    LeaseManager.
  - **Enforcement is opt-in** (`lease.enforce` / `ORCHESTRATOR_LEASE_ENFORCE=true`,
    default OFF): because the lease path has been dead since #418, existing
    clusters run `workers: N` replicas unmetered — silently enabling enforcement
    would cap their effective concurrency at the org's tier limit (free tier: 1).
    With enforcement off, dispatch behaves exactly as before this change.
  - `WorkerDispatcher`: the lease gate engages whenever a lease manager is
    configured (previously also gated on receiving `tier_info`, which never
    arrives). Denials pause claiming and now auto-resume via a
    `denialResumeMs` backstop (new `DispatchConfig` field, default 60s) if the
    `slot_available` broadcast is missed; transient cloud errors re-enqueue and
    retry without pausing; request timeouts fail open (dispatch without a lease)
    so lease-less clouds cannot starve dispatch. The per-replica
    one-job-at-a-time cap is unchanged — parallelism comes from `workers: N`
    container replicas, now properly metered by per-user cloud leases.

- 7db8ba2: Add orchestrator-side wire for the Cockpit Remote Gates epic (#1021). Three new HTTP routes on the orchestrator (`POST /cockpit/gates`, `POST /cockpit/gates/:id/ack`, `POST /cockpit/answers`), one new `cluster.cockpit` relay channel with retain-and-replay on reconnect (bounded FIFO with count + byte caps, drop-oldest), and one append-only NDJSON answers file at `/workspaces/.generacy/cockpit/answers.ndjson` with size-based rotation (`.1`..`.N`) and in-memory `deliveryId` dedup rebuilt on boot. `@generacy-ai/cockpit` gains `packages/cockpit/src/gates/` with `GateOpenSchema`, `GateAckSchema`, `GateAnswerSchema` (Zod with passthrough for forward-compat) and inferred TS types. Auth reuses `authMiddleware` via a new `COCKPIT_INTERNAL_API_KEY` env var (parallel to `ORCHESTRATOR_INTERNAL_API_KEY` from #598); `/cockpit/answers` reaches the orchestrator via the cluster-relay dispatcher's implicit `orchestratorUrl` fallback with no new route entry. Downstream MCP tools, the doorbell that tails `answers.ndjson`, and the cloud-side inbox UI ship as separate epic issues.

### Patch Changes

- 403f0c3: fix(cockpit): conform the gate wire contract to the frozen spec (#1034).

  The `packages/cockpit/src/gates/` module previously shipped an invented gate
  wire envelope (`kind`-discriminated, `scope`-wrapped, with a `gate-ack`
  sub-event and a nested-`answer` down-path) that matched **neither** the frozen
  authoritative contract in
  `tetrad-development/docs/cockpit-remote-gates-plan.md § "Wire contracts"` **nor**
  the generacy-cloud receiver (`gates-wire.md` Shapes 1/2/3), which dispatches on
  `data.type` and log-drops any unknown subtype. Net effect: the orchestrator's
  own `GateOpenSchema` rejected the plugin's `cockpit_gate_open` call, and even a
  patched frame would have been silently dropped cloud-side (`data.type ===
undefined`) — no gate ever reached the operator inbox. This supersedes the
  envelope portions of #1032/#1033 (gate-open `scope`) and the gate-ack work
  (#1035), which refined the wrong shape.

  Now conformant to the frozen contract (the cloud is the authoritative
  receiver/sender; these schemas mirror it field-for-field):

  - **Schema module** (`packages/cockpit/src/gates/`): `GateOpenSchema`
    (`type:'gate-open'`, flat — `gateKey`, `gateType` enum, `title`/`body`/
    `options`/`allowFreeText`/`sessionId`/`askedAt`, 24-hex `gateId`),
    `GateOutcomeSchema` (`type:'gate-outcome'` — THE ACK, replaces `GateAckSchema`),
    `GateAnswerSchema` (down-path `type:'gate-answer'`, flat `optionId`/`freeText`/
    `actor`, both `freeText` and `actor.email`/`actor.displayName` **nullable** to
    match what the cloud sends). Adds `deriveGateKey`/`deriveGateId`
    (`sha256(gateKey)[:24]`). Removes the dead `GateAckSchema` /
    `GateAnswerEnvelopeSchema`.
  - **Orchestrator** (`routes/cockpit-gates.ts`, `routes/cockpit-answers.ts`): the
    `/ack` route now stamps `type:'gate-outcome'` (path-authoritative `gateId`,
    defaulted `at`) instead of emitting a `gate-ack`; the emitted relay `data`
    carries `type` as the cloud sub-event discriminator; `/cockpit/answers`
    validates the frozen flat `GateAnswerSchema` (24-hex `gateId`) before append.
  - **MCP tools**: `cockpit_gate_open` now **derives** `gateKey`+`gateId` in TS
    and self-validates the assembled frozen record before POSTing (the plugin/LLM
    never hand-builds a sha256); `cockpit_gate_ack` assembles a `gate-outcome`.
  - **Doorbell**: the answers tailer parses the frozen flat down-path line
    (`type`/`gateKey`/flat `optionId`/`freeText`/`actor`); repo-scope filter keys
    on the `gateKey` issue-ref (owner/repo, child-issue numbers pass).

  Known follow-up: cross-repo child-issue answers are dropped by the tailer's
  owner/repo scope filter (documented inline; cross-repo remote gates are not yet
  exercised). Pairs with the `@generacy-ai/claude-plugin-cockpit` change that
  emits the frozen record shape.

- dbb0fbe: Cockpit gates — read-only status query + stable sweep generation derivation (#1038).

  Adds three additive pieces that jointly kill the sweep-duplicate bug in
  `/cockpit:auto --gates=ui`:

  1. **`@generacy-ai/cockpit`** (minor) — new pure helper
     `computeClarificationAnswerSetHash({ questions })`: canonical 12-hex hash of
     the sorted-by-`questionNumber` list of `{ questionNumber, questionText }`.
     Same round of asks → same `generation` → same `gateId`, regardless of
     whether the agency-side sweep or the live in-repo path derived it (SC-002).
     `deriveClarificationGeneration({ batchId })` signature unchanged; the new
     helper is additive.

  2. **`@generacy-ai/generacy`** (minor) — two new read-only MCP tools on the
     cockpit MCP server:

     - `cockpit_gate_status({ issueRef, gateType, generation })` →
       `{ gateId, status: 'open' | 'answered' | 'absent' }`
     - `cockpit_gate_list({ issueRef, gateType? })` →
       `{ gates: [{ gateId, gateType, generation, status }], truncated? }`
       Both are thin HTTP clients over `GET /cockpit/gates`. Adds one new
       `ErrorClass` union member (`query-unreachable`), distinct from `transport`
       so the sweep's downstream dispatch can differ (abort vs. AskUserQuestion
       fallback). Retry policy: 3 attempts, 0/1500/3500 ms (≤5s total).

  3. **`@generacy-ai/orchestrator`** (patch) — new `GET /cockpit/gates` route +
     `CloudGateQueryClient` (mirrors `packages/control-plane/src/services/cloud-pull-client.ts`).
     The route dispatches to the cloud via HTTPS + cluster API key, applies the
     seven-to-three cloud-status collapse, and the non-terminal filter for
     list-mode responses. Existing `POST /cockpit/gates` handlers untouched.

  Unblocks the agency-side sweep (generacy-ai/agency#450) and the cloud-side
  Firestore query endpoint (generacy-ai/generacy-cloud epic 850).

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

- 00c6b54: Widen the PR-feedback orchestration guard so reviews on completed workflows still enqueue (`agent:*` / `workflow:*` / `completed:*` are all evidence), lift drop-gate log lines to `info` when the PR has unresolved threads (with a named `gate:` field), and add a merged-PR gate so reviews on merged PRs never reach the checkout path. Fixes #1049.
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

- afab7d5: workflow:speckit-bugfix

  Reclaim orphaned queue claims when the owning worker dies without unwinding;
  escalate wedged-in-flight drop logs to `warn` on the transition edge (#1054).

  `RedisQueueAdapter` gains `reapOrphanClaims()` — a Lua-atomic sweep over
  `orchestrator:queue:claimed:*` that reclaims claims whose owning worker's
  heartbeat key is absent (SIGKILL / OOM / dispatcher-replica-replace).
  Reclaimed items are re-queued with `queueReason: 'resume'`, `attemptCount++`,
  and a per-reclaim `warn` line carrying both pre- and post-increment counters
  so infra-caused increments stay distinguishable from execution-failure
  increments in log queries. The reclaim is race-safe via a server-side
  `EXISTS heartbeat` re-check inside the script (US2) and grace-window guard
  (FR-005). `WorkerDispatcher.reaperLoop` invokes it sequentially after the
  existing in-memory `reapStaleWorkers` on the same cadence.

  A new shared `drop-log-helper.ts` (pure function) escalates the four
  "Dropping ... enqueue (item already in flight)" sites plus the two
  `enqueueIfAbsent` adapter sites from silent `info` to a single `warn` on the
  transition edge when a wedged in-flight entry's age crosses the new
  `DispatchConfig.maxRunDurationMs` threshold (default 30 min). No repeat
  `warn`s between edges — a wedge produces exactly one `warn` line on entry
  plus one from the reap sweep, then subsequent drops for the same wedged
  itemKey fall back to `info`.

  Reproduces the exact wedge from `generacy-ai/generacy#1051` (worker died
  mid-claim → item stranded 84 minutes with 17 identical `info`-level drop
  lines) as a regression test.

- 1ce646f: Periodic `RedisQueueAdapter.reconcileInFlight()` closes the residue-in-SET
  gap from #1054 finding 6 (#1058).

  `reapOrphanClaims` (PR #1056, `RECLAIM_ORPHAN_SCRIPT`) is candidate-set-
  driven by `orchestrator:queue:claimed:*` keys — it cannot see an itemKey
  that lives in `orchestrator:queue:in-flight-items` **without** a matching
  claim-hash entry (Redis eviction, a future refactor that `HDEL`s without
  a paired `SREM`, or out-of-band operator action). Every subsequent
  `enqueueIfAbsent()` for that issue is then silently dropped by
  `ENQUEUE_IF_ABSENT_SCRIPT`'s `SISMEMBER` guard and no code path
  un-wedges it.

  Fix adds `reconcileInFlight` as a periodic sweep on the dispatcher's
  reaper cadence (immediately after `reapOrphanClaims`, plus one boot
  sweep at process start). Detection is client-side: `SSCAN
IN_FLIGHT_KEY`, `ZRANGE PENDING_KEY 0 -1` + parse, `SCAN
CLAIMED_KEY_PREFIX*` + `HKEYS` per hash, in-memory set-difference.
  Action is two-sweep-gated: a residue candidate must be observed as
  residue in two consecutive sweeps before removal (in-memory tracker
  Map). Confirmed candidates go through a minimal single-key
  `RECONCILE_IN_FLIGHT_SCRIPT` (`SISMEMBER` + `SREM`, `numberOfKeys: 1`
  — CROSSSLOT-safe under Redis Cluster) that atomically re-checks against
  a concurrent `enqueueIfAbsent`/`enqueue` re-add. Composes with
  #1054/PR #1056 (`RECLAIM_ORPHAN_SCRIPT`) and #1060/PR #1065
  (`ENQUEUE_IF_ABSENT_SCRIPT` co-atomicity) — additive, no changes to
  existing scripts. `QueueManager.reconcileInFlight` is an internal
  contract; `InMemoryQueueAdapter` implements it as a no-op (in-memory
  `pending`, `claimed`, and `inFlightSet` cannot diverge by
  construction).

- fbcf85f: Restore `RedisQueueAdapter.enqueue()` in-flight-SET invariant (#1060).

  `RedisQueueAdapter.enqueue()` previously ran `ZADD pending` only — no
  `SADD orchestrator:queue:in-flight-items`, no dedupe — silently corrupting
  the `in-flight = pending ∪ claimed` invariant that `CLAIM_SCRIPT`,
  `ENQUEUE_IF_ABSENT_SCRIPT`, `RECLAIM_ORPHAN_SCRIPT`, `release()`, and
  `complete()` all rely on. Because the `process:<workflow>` label handler is
  the dominant intake path, this let a concurrent monitor `enqueueIfAbsent`
  pass its `SISMEMBER` guard and land a second distinct pending member,
  producing two concurrent worker claims on the same issue (observed
  2026-07-28 on the tetrad-development cluster: four concurrent claims across
  #1053 + #1054).

  Fix:

  - New `ENQUEUE_SCRIPT` Lua constant (byte-identical to
    `ENQUEUE_IF_ABSENT_SCRIPT`) executes `SISMEMBER` → conditional `SADD` +
    `ZADD` atomically. Registered as `enqueueItem` via `defineCommand`.
  - `QueueAdapter.enqueue` and `QueueManager.enqueue` signatures widened from
    `Promise<void>` to `Promise<boolean>` (`true` = enqueued, `false` =
    dropped as in-flight). Both `RedisQueueAdapter` and `InMemoryQueueAdapter`
    updated. Interface JSDoc documents the invariant.
  - `InMemoryQueueAdapter.enqueue()` now funnels its dedupe drop through
    `emitDropLog` with the same `{ itemKey, source: 'enqueue', reason:
'in-flight', ageMs }` shape as Redis for cross-adapter log parity.
  - `LabelMonitorService.processLabelEvent()` `type === 'process'` branch
    observes the boolean; a `false` return is treated as success (the item is
    already in flight and the enqueue's intent is satisfied). The adapter
    owns the drop log.
  - `WorkerDispatcher.handleLeaseExpired()` calls `queue.release()` before
    the old `queue.enqueue()` call — with the new dedupe, a naked `enqueue()`
    here would be dropped and leave the item orphan-claimed (`CLAIM_SCRIPT`
    deliberately preserves in-flight-SET membership). The redundant
    `enqueue()` and its `getQueueItems` duplicate check are removed;
    `release()`'s retry branch atomically re-pends the item at `retry`
    priority. Lease-expired items now land at `retry` instead of `resume` —
    acceptable divergence, matches how the queue treats any retry.

  Composition: additive to #1054 / PR #1056's `RECLAIM_ORPHAN_SCRIPT`.
  The reclaim script deliberately does not `SREM` on reclaim; its correctness
  depends on the in-flight SET being populated at enqueue time — this fix
  makes that reliably true. Regression covered by
  `redis-queue-adapter.enqueue-invariant.test.ts`,
  `in-memory-queue-adapter.enqueue-invariant.test.ts`, and
  `queue-adapter-parity.test.ts` (SC-003 cross-adapter parity, SC-004
  end-to-end invariant, SC-006 regression guard).

- af5619f: Preserve caller-supplied `frameId` on `GateOpenSchema` / `GateOutcomeSchema` and
  the orchestrator cockpit-gates route so `cluster.cockpit.reply` correlation
  (generacy-cloud#890) _can_ stop collapsing onto `(gateId, frameType)` on
  idempotent retries. Additive-optional wire-schema field; older callers
  unaffected.

  This makes correlation _possible_, not delivered. Nothing on the cluster yet
  generates a per-frame `frameId` or keeps a `frameId → pending-promise` map, so
  outbound frames still omit the field and replies still carry `frameId: null`
  until a producer lands in a follow-up.

- 82077f1: Phase B of the #1053 fix: widen `cockpit_gate_status` / `cockpit_gate_list`
  MCP schemas to accept an optional `runId` field, and thread it through the
  query client + orchestrator route + cloud gate-query client so a caller that
  supplied `runId` on `cockpit_gate_open` can then re-issue `cockpit_gate_status`
  in the same run and observe `open` (not `absent`).

  - `cockpit_gate_status`: schema widened, `runId` forwarded to the cloud as a
    `runId=<value>` query-string parameter (camelCase); post-call log line emits
    `runIdSource: 'explicit' | 'unset'` on success + failure paths (value never
    logged).
  - `cockpit_gate_list`: schema widened for surface parity; handler drops
    `runId` before calling the client (cloud route 400s any list carrying `runId`).
    No `runIdSource` log line on list.

  Byte-compat: with `runId` omitted, every derived key, id, and outbound URL is
  byte-identical to today (pinned by snapshot + structural tests).

  Requires cloud Phase A (generacy-cloud#892, merge `192fca7c`, deployed
  `2026-07-29T04:07:07Z`). On-call MUST verify Phase A is in prod at merge time.

- 9bfe5af: Atomic `RedisQueueAdapter.release()` and `.requeueForResume()` re-pend
  (#1069).

  Both methods previously performed the read-and-mutate as two Redis
  round trips (`HGET` claim → client-side `MULTI: HDEL + DEL + ZADD`),
  leaving a few-millisecond window in which `RECLAIM_ORPHAN_SCRIPT`
  could interleave, `HDEL` the claim, and `ZADD` its own re-pend
  payload. The subsequent client `MULTI` then fired with a no-op `HDEL`
  but its `ZADD` still added a **second distinct pending member** (Redis
  ZSETs key on the full member string), producing two concurrent worker
  claims — the exact failure sequence #1060/PR #1065 closed for
  `enqueue()`, arriving via `release()` / `requeueForResume()` instead.

  Fix folds both into single Lua scripts (`REQUEUE_FOR_RESUME_SCRIPT`
  and `RELEASE_SCRIPT`), mirroring `RECLAIM_ORPHAN_SCRIPT`'s pattern.
  `release()`'s dead-letter branch is folded into the same script so
  SC-004's "exactly 1 round trip" invariant holds on both retry and
  dead-letter paths. `attemptCount` is read + mutated inside Lua via
  `cjson.decode`/`encode` so passing it as ARGV cannot reintroduce the
  TOCTOU hazard. Scripts return `{code, attemptCount}` tuples so the
  existing `logger.info` "attempt N of maxRetries" diagnostic is
  preserved. Public `QueueManager` interface unchanged (both methods
  retain `Promise<void>` return contract — SC-008 / FR-008).

- 63436bf: Split PR-feedback CLI-timeout disposition off `blocked:stuck-feedback-loop` and allow up to two bounded auto-retries per trigger (#1070). Three new label vocabulary entries in `@generacy-ai/workflow-engine`: `blocked:fixer-timeout` (retry-eligible, monitor auto-dispatches on next poll), `blocked:fixer-timeout-no-progress` (terminal — CLI timed out with zero commits), `blocked:fixer-timeout-repeat` (terminal — auto-retry budget of 2 exhausted). Orchestrator's `PrFeedbackHandler` collapsed `!success || !hasChanges` branch is split into an explicit four-way switch and the historically contradictory `msg: "Successfully pushed changes" success: false` log line is fixed. Retry counter lives on the monitor (`PrFeedbackMonitorService.fixerTimeoutRetryCount`) and travels handler-ward via a new optional `retryAttempt?: number` field on `PrFeedbackMetadata`; resets only when all review threads are fully resolved (Case C). Cockpit `WAITING_PIPELINE_ORDER` gains the two terminal `blocked:fixer-timeout-*` labels ahead of `waiting-for:address-pr-feedback` (mirrors the `blocked:stuck-feedback-loop` precedence), while the retry-eligible `blocked:fixer-timeout` intentionally sorts below the active waiting gate.
- cd811d1: Detect fixer-CLI self-commit cycles in PR-feedback handler by comparing branch HEAD SHA across the CLI invocation, so `blocked:stuck-feedback-loop` no longer lands on cycles that actually pushed a commit (#1073). New `@generacy-ai/workflow-engine` label vocabulary entry `blocked:resolve-failed` for the narrower case where code changes landed but thread reply/resolve failed — separated from `blocked:stuck-feedback-loop` because the two require different operator remediation (check GitHub API responses vs. read fixer transcripts). Orchestrator's `PrFeedbackHandler` disposition dispatcher gains a head-advance check between the CLI spawn and the pre-existing B1/B2/B3 branch; timeout branches (B4/B5/B6 from #1070) are unaffected. Log lines gain a `source: 'cli' | 'handler'` field on both the CLI-self-commit and handler-commit paths, and the CLI-self-commit path carries `preFixSha` + `postFixSha` so the head-advance claim is auditable rather than asserted (clarification Q4 caveat). The CLI-self-commit info line also carries a `handlerCommitted: boolean` field so operators can distinguish CLI-only, handler-only, and mixed (both committed) cycles from a single grep. Cockpit `WAITING_PIPELINE_ORDER` gains `blocked:resolve-failed` ahead of `waiting-for:address-pr-feedback` (mirrors the terminal `blocked:fixer-timeout-*` precedence). No changes to `PrFeedbackMonitorService`, `PrFeedbackMetadata`, `QueueItem`, or the `blocked:*` short-circuit; this is a producer-side fix.

  **Operator-visible narrowing:** `blocked:stuck-feedback-loop` no longer originates from the zero-resolve path (previously reachable in principle but shown to be unreachable in practice; PR #1075 review). The label now only originates from the B1/B2/B3 branch (`!cliSelfCommitted && (!success || !hasChanges)`). A zero-resolve cycle after a real head-advance now always lands `blocked:resolve-failed`.

- c4c3f96: Mint a `frameId` per outbound cockpit frame and correlate `cluster.cockpit.reply` back to it (#1077). The orchestrator's `POST /cockpit/gates` and `POST /cockpit/gates/:id/ack` handlers now mint an `frm_<24-hex>` id at request-accept time (before `tryEmitOrRetain`), so the 202 echoes the id, retained frames carry it into the retain queue, and drain emits it verbatim. A caller-supplied `frameId` on the request body overrides the route mint. `@generacy-ai/cluster-relay` gains a new public `registerPendingFrame(frameId, meta)` method and `PendingFrameMeta` export; the `cluster.cockpit.reply` receive branch settles matching pending entries (info log with `ageMs`), quiet-drops unknown ones (info log naming the `frameId`), and evicts on a 30s TTL (debug log). The map is preserved across transient WebSocket disconnects and cleared on `disconnect()`. `@generacy-ai/generacy`'s `GateOpenWireSchema` / `GateOutcomeWireSchema` gain an optional `frameId` field so callers that hand-supply one pass the tool's self-check.
- 751c8b9: fix(orchestrator): stop `/cockpit/gates` open/ack 401ing under `--gates=ui`. The co-located cockpit MCP POSTs gate open/ack over loopback with no API key by design, but the route was behind the global auth middleware and not exempt, so every remote gate 401'd and the plugin fell back to a local `AskUserQuestion` (fatal for headless UI-driven runs). Exempt `/cockpit/gates[/:id/ack]` from API-key auth **only** for a loopback TCP peer (`socket.remoteAddress`, not the spoofable `request.ip`), so the host-published `0.0.0.0` listener never exposes an unauthenticated, cloud-forwarding gate surface to the network.
- Updated dependencies [7c69dba]
- Updated dependencies [2d1adbc]
- Updated dependencies [ff142d7]
- Updated dependencies [bcbcc6b]
- Updated dependencies [7db8ba2]
- Updated dependencies [68c820c]
- Updated dependencies [403f0c3]
- Updated dependencies [dbb0fbe]
- Updated dependencies [bdbde27]
- Updated dependencies [66cf1d6]
- Updated dependencies [349fdba]
- Updated dependencies [8b8ed56]
- Updated dependencies [069536e]
- Updated dependencies [af5619f]
- Updated dependencies [63436bf]
- Updated dependencies [cd811d1]
- Updated dependencies [c4c3f96]
  - @generacy-ai/cockpit@0.7.0
  - @generacy-ai/cluster-relay@0.5.0
  - @generacy-ai/workflow-engine@0.5.0

## 0.11.0

### Minor Changes

- 472cea0: Gate VS Code tunnel on post-activation restart settling (#1009).

  Freshly activated wizard clusters used to start the VS Code tunnel during the
  brief window before the container's post-activation self-restart, so a
  device-code authorization completed by the user in that window was SIGTERM'd
  away with the process — token never persisted, tunnel stuck.

  `@generacy-ai/orchestrator`: new `PostActivationSettledMonitor` (one-shot
  `fs.watch` on `/var/lib/generacy/post-activation-restart-done`) pushes an
  immediate `sendMetadata()` when the marker appears. `/health` and
  `ClusterMetadataPayload.postActivationReady` compute
  `(NOT activated) OR (marker present)` via a shared sync predicate — matches
  the `codeServerReady` / `controlPlaneReady` push-latency pattern.

  `@generacy-ai/control-plane`: `POST /lifecycle/vscode-tunnel-start` now
  returns a 200 skip response
  (`{ accepted: false, reason: 'post-activation-not-settled', ... }`) when the
  cluster is still in the pre-restart window, and the `bootstrap-complete`
  handler skips its auto-tunnel-start step (d) in the same condition. Steps
  (a) `writeWizardEnvFile`, (b) sentinel write, and (c) `codeServerManager.start()`
  are unchanged — they are what causes the marker to eventually exist.

  `@generacy-ai/cluster-relay`: `ClusterMetadata` + `HealthData` gain
  `postActivationReady?: boolean` and propagate it through `collectMetadata()`
  so cloud-side UI can gate the "Connect with VS Code Desktop" button.

  Local `generacy launch` clusters (no key file) are always reported settled
  (`postActivationReady: true`) — the fix does not gate them.

### Patch Changes

- Updated dependencies [472cea0]
  - @generacy-ai/control-plane@0.8.0
  - @generacy-ai/cluster-relay@0.4.0

## 0.10.1

### Patch Changes

- d15dba7: Adopt existing smee channel on cluster delete→relaunch (#1005).

  `SmeeChannelResolver` gains a new `adopted` tier between `persisted` and
  `provisioned`. When the persisted channel file is missing (e.g. after a
  cluster destroy), the resolver calls an injected discovery callback that
  scans configured repos' GitHub webhooks and reuses any existing Generacy
  smee channel URL — persisting it so the next boot short-circuits at the
  `persisted` tier. `WebhookSetupService._selectExistingHookForUpdate` gains
  a single-hook take-over branch: exactly one stale Generacy smee hook (URL
  neither current nor persisted) is `update-url`-repointed to the current
  channel; zero and ≥2 preserve today's `create` / `foreign` behavior to
  avoid duplicate delivery.

  Internal observability + wiring change only — no public API surface change.

- 47ba255: Run repo label sync fire-and-forget after `server.listen()` instead of blocking boot.

  `LabelSyncService.syncAll` walks dozens of sequential GitHub label create/update
  calls (~30s on a fresh repo creating ~68 labels) and was `await`ed before the
  server started listening. On a wizard cluster's post-activation self-restart —
  where the label monitor first becomes enabled with the repo present — that kept
  the orchestrator, and therefore the relay and the cloud bootstrap UI, unreachable
  for the entire sync. Label sync now runs in the onReady hook (like the existing
  monitors), so the server becomes ready and reconnects the relay immediately;
  labels sync in the background. Cuts ~30s off the onboarding restart window.

- Updated dependencies [47ba255]
  - @generacy-ai/control-plane@0.7.4

## 0.10.0

### Minor Changes

- d8f5388: Cap smee.io SSE reconnect backoff at 30s (was 5min) and add equal jitter, sharing
  the algorithm via a new `@generacy-ai/smee-backoff` package. Reduces real-time
  recovery latency for the orchestrator webhook receiver and the cockpit doorbell
  after a transient smee.io outage.

### Patch Changes

- e4d91d7: Flip monitors to webhook mode after smee receiver connects (#987). On the
  auto-provisioned / persisted smee-channel path, the label / PR-feedback /
  merge-conflict / clarification-answer monitors were stuck at fast adaptive
  poll cadence with `reason=webhooks-not-configured` because `webhooksConfigured`
  was frozen at construction time from the static `config.smee.channelUrl`.
  `startSmeePipeline` now calls a one-way runtime setter on all four monitors
  once the smee receiver reports Connected, and the receiver fans out
  `recordWebhookEvent()` to all four monitors on every parsed inbound event so
  the controller's `webhook-stale → to-fast` safety net remains reachable.
- 890a2e3: Fix ClarificationAnswerMonitorService resuming on its own bot comments (#993).

  The monitor's answer predicate now filters `[bot]`-suffix authors upstream of
  the trust helper, and only accepts a candidate whose `created_at` is strictly
  newer than the latest question-marker comment on the issue. `matchMachineMarker`
  gains a `MACHINE_MARKER_FAMILIES` prefix pass so every `<!-- generacy-stage:*`
  and `<!-- speckit-stage:*` marker (including the previously-missed
  `<!-- speckit-stage:clarification`) is skipped without a code change.

- Updated dependencies [d8f5388]
  - @generacy-ai/smee-backoff@0.2.0

## 0.9.0

### Minor Changes

- d0bafbc: Auto-provision a smee.io channel on orchestrator startup when none is
  configured, persist it to `/var/lib/generacy/smee-channel` (mode 0600), and
  let the existing webhook-setup flow wire the GitHub webhook. Every automated
  provisioning path (local CLI, cloud onboarding, cloud deploy) previously
  shipped an empty `SMEE_CHANNEL_URL`, so every new cluster silently ran
  webhook-less and degraded to polling. The orchestrator's new
  `SmeeChannelResolver` runs asynchronously off the listen path (fire-and-forget)
  with a 4-tier precedence — env/yaml → persisted file → `POST https://smee.io/new`
  (5 s timeout, 2 attempts, 1 s delay) → persist — and fails open on any tier.
  Clusters with a hand-set env URL are unchanged.
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
- 6770cbc: Wire the smee doorbell end-to-end for operator sessions on smee-live clusters.

  The orchestrator's `SmeeChannelResolver` now mirrors the resolved channel URL
  to a shared workspace path so operator devcontainer/tunnel sessions — which
  do not mount the cluster-internal `generacy-data` volume — can discover it,
  and the doorbell's startup `gh` calls survive transient failures via a two-
  tier retry envelope instead of `exit(2)`-ing on the first hiccup.

### Patch Changes

- cbaa48f: Stop the address-pr-feedback flow from completing the `implementation-review` human gate without approval (#941).

  When a fix session exited, the gate was marked `completed:implementation-review`
  server-side regardless of whether the review's findings were actually resolved —
  so request-changes verdicts were effectively advisory. During the snappoll run
  this advanced the gate twice with no operator call and no
  `<!-- generacy-cockpit:manual-advance -->` audit comment, letting a PR with three
  known-blocking findings sail through validate.

  - `PrFeedbackHandler` now re-asserts `waiting-for:implementation-review` on every
    terminal exit (happy path, both blocked-stuck dispositions, and thrown errors)
    via the shared `finally`, idempotently re-adding the label and logging a
    structured error if some other path stripped it. It runs _before_ the
    `agent:in-progress` clear, so the terminal transient state is never
    `{ agent:in-progress present, waiting-for:implementation-review absent }`.
    A fix attempt that does not resolve the findings therefore lands back in
    review rather than past it.
  - `LabelManager` gains a seam guard: writing `completed:<human-gate>` now
    requires an explicit `AllowGateComplete` token and otherwise throws
    `HumanGateCompletionUnauthorizedError`. The union has a single member
    (`cockpit-advance` — the path that also posts the manual-advance audit
    comment), so human gates stay attributable and no server-side path can
    silently complete one.

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

- 9341fd1: Fix clarification options being truncated when an option description wraps (#948).

  `parseClarifications()` extracted the `**Options**:` block by matching a run of
  consecutive `- ` lines, so the first continuation line ended the block. A
  hard-wrapped option description — or one carrying indented sub-bullets — was
  therefore cut off mid-sentence, and every option after it was silently dropped
  before `postClarifications()` rendered and posted the comment. The human
  answering the gate never saw the missing options.

  The block is now delimited the same way `**Context**` and `**Question**` already
  are (to the next `**Field**:` line, `###` heading, or EOF), with continuation
  lines attached to the option above them. Across the 1,440 questions carrying
  options in the repo's shipped `clarifications.md` files, this recovers 17
  dropped options and 6 truncated descriptions.

  Comments already posted are unaffected — the poster dedups on its marker and
  will not repost.

- bb60299: Widen `parseAnswersFromComments` to accept the cockpit `### Q<n>` + `**Answer:** value` dialect, so the deterministic backstop parser stops silently returning `no-answers` on every cockpit-posted clarification comment.
- d4ca687: Fix `updateAdaptivePolling()` dead branch across `LabelMonitorService`, `PrFeedbackMonitorService`, and `MergeConflictMonitorService` — the safety net is now reachable on clusters with no configured webhook feeder (#953).

  The three copy-pasted `updateAdaptivePolling()` implementations all opened with `if (this.state.lastWebhookEvent === null) return`, so the fast-poll compensation only ever engaged for clusters that once had a working webhook and lost it — never for smee-less clusters (currently every new cluster). All three copies now delegate to a shared pure helper (`adaptive-poll-controller.ts`), and each service accepts a construction-time `webhooksConfigured` flag that distinguishes "webhooks configured but quiet" (grace applies) from "no webhook path exists" (engage fast interval when `adaptivePolling: true`).

  Two operator-visible facts ship with this:

  - **`PrMonitorConfigSchema.adaptivePolling` default flips `true → false`.** The old default was inert (dead branch); flipping it now that the branch actually fires prevents silently doubling GitHub API load on every existing cluster. Operators opt in with `PR_MONITOR_ADAPTIVE_POLLING=true`. `MonitorConfigSchema.adaptivePolling` default stays `true` — LabelMonitor's 30s base was tuned assuming a real-time path, so restoring fast polling on smee-less clusters preserves the original design intent.
  - **Smee-less LabelMonitor clusters emit a `to-fast` transition log line on cycle 1** where they previously emitted nothing. The log body carries `reason: 'webhooks-not-configured'`.

- 1b6d362: Surface smee-less startup and webhook-setup opt-out (#954).

  When no smee channel is configured, the orchestrator silently degrades to polling:
  the smee receiver is constructed inside `if (config.smee.channelUrl)` with no
  `else`, so `docker logs … | grep -i smee` returns nothing on a polling-only
  cluster. This adds three observability primitives:

  - A `warn` at label-monitor construction when `config.smee.channelUrl` is unset
    in full mode with an active label monitor and repositories configured. Payload
    states the effective `pollIntervalMs`, `completedCheckInterval = 3` (from
    `LabelMonitorService`), both computed `process:*`/`completed:*` worst-case
    latencies, and remediation pointers (`SMEE_CHANNEL_URL`,
    `orchestrator.smeeChannelUrl`). The block guards on `!isWorkerMode &&
config.labelMonitor && config.repositories.length > 0` — no false-warning in
    worker mode, pre-activation, or deliberate opt-out.
  - An `info` at the webhook-setup guard when `config.smee.channelUrl` IS set but
    `config.webhookSetup.enabled` is false, so an operator inheriting an opt-out
    config gets one observable line rather than silence. `info`, not `warn`:
    deliberate opt-out is not degradation.
  - An additive optional `smeeConfigured: boolean` field on `HealthResponse`
    (200 + 503 schemas), populated from `!!config.smee.channelUrl` at
    `createServer()` construction. Present on all processes — it's a
    configuration statement, not a degradation claim.

- 520b1f1: Fix SmeeChannelResolver.provision() to match smee.io's current GET/307 behavior; provisioning previously failed on POST/302 assumptions and every fresh cluster fell back to polling.
- 405ed96: Fix "Connect with VS Code Desktop" hanging on freshly deployed clusters (#966).

  The `authorization_pending` event from `code tunnel` was silently dropped when the
  orchestrator relay wasn't yet `connected`, so the cloud UI never saw the device code.
  The orchestrator now retains the latest actionable `cluster.vscode-tunnel` event and
  replays it on relay reconnect, `VsCodeTunnelProcessManager.start()` emits a fresh
  `starting` event on user re-trigger while the child is alive, and a distinct 5-minute
  timeout bounds the `authorization_pending` phase.

- 01bbb03: Fail loud on webhook-registration 403 in `WebhookSetupService` (#972).

  When `ensureWebhooks()` gets HTTP 403 (`Resource not accessible by integration`) on
  list/create/update — the systemic missing `admin:repo_hook` scope on the Generacy
  GitHub App — the orchestrator now emits a triple: a structured `warn` log line,
  a `cluster.bootstrap` relay event `{ status: 'failed', reason:
'webhook-registration-forbidden', repo, installationId, missingScope:
'admin:repo_hook' }`, and a cluster status transition to `degraded` (via
  `POST /internal/status`). Also locks the create-time event set to `issues`,
  `pull_request`, `check_run`, `check_suite` (FR-001) and adds an exact
  persisted-URL heal path (FR-004) that PATCHes a hook whose `config.url` matches
  a previously-provisioned smee channel to the current channel URL, and refuses
  to modify foreign smee hooks that match neither current nor persisted URL.

- 73fe178: Same-account plain `Q<n>:` replies on paused clarify issues now auto-resume
  and integrate.

  Both clarification answer surfaces (the monitor's enqueue check and the phase
  loop's integration scanner) previously short-circuited any comment authored
  by the cluster's own GitHub account, silently dropping human-operator answers
  posted through that identity. The identity gate is removed at both sites in
  favor of a broader machine-marker filter (`MACHINE_MARKERS`), delegating
  same-account trust to the existing self-authored branch of the shared
  trust helper. Machine-authored comments (question posts, stage/status
  tracking, audit, marker-relay, bot explainers) are still excluded via the
  marker set.

- Updated dependencies [c7807a3]
- Updated dependencies [679d2e7]
- Updated dependencies [405ed96]
  - @generacy-ai/workflow-engine@0.4.0
  - @generacy-ai/control-plane@0.7.3

## 0.8.0

### Minor Changes

- 5488c4c: Provider-neutral launch intents and a `(provider, kind)` plugin registry (#813).

  - `@generacy-ai/orchestrator`: the agent launch intent types (`phase`,
    `pr-feedback`, `validate-fix`, `merge-conflict`, `conversation-turn`,
    `invoke`) now live in and are owned by `src/launcher/types.ts` — the core
    `LaunchIntent` union no longer imports `ClaudeCodeIntent` from the Claude
    plugin, so the concrete provider no longer leaks into orchestrator core.
    `PhaseIntent`/`PrFeedbackIntent` gain an optional `model` field and
    `LaunchRequest` gains an optional `provider` selector (default
    `'claude-code'`). The launcher registry is re-keyed on `(provider, kind)`,
    keeping duplicate-registration protection per key, and an unknown provider
    produces a typed error. These types are also exposed via the new
    `@generacy-ai/orchestrator/launcher/types` subpath export.
  - `@generacy-ai/orchestrator-types`: `LaunchRequest` and `AgentLaunchPlugin`
    gain the `provider` field mirroring the orchestrator-owned contract.
  - `@generacy-ai/generacy-plugin-claude-code`: `ClaudeCodeLaunchPlugin` declares
    its `provider` namespace. The plugin structurally mirrors the
    orchestrator-owned intent types locally (same pattern as its local
    `LaunchSpec`/`OutputParser`) rather than importing them across the package
    boundary, so the two packages do not form a build-time cycle. No call-site
    behavior change — all sites resolve to the `claude-code` provider and argv
    output is byte-identical.

- 92ca0b4: Agent provider/model config surface threaded to phase spawns (#814).

  Adds an `orchestrator.agents` config block so a repo's `.generacy/config.yaml`
  can select the agent `{ provider, model }` per workflow phase. Ships immediate
  value: per-phase **model** selection for Claude Code, ahead of any new provider.

  - `@generacy-ai/config`: `OrchestratorSettingsSchema` gains an `agents` block
    (`default` / `workflows.<name>.default` / `workflows.<name>.phases.<phase>`,
    each `{ provider?, model? }`).
  - `@generacy-ai/generacy`: mirrors the `agents` block in the CLI-facing config
    schema and `examples/config-*.yaml`, and wires the previously-unconsumed
    `defaults.agent` as the repo-level provider default.
  - `@generacy-ai/orchestrator`: `WorkerConfigSchema` carries the merged `agents`
    block; the repo-override merge and cluster-default env plumbing
    (`WORKER_AGENT_PROVIDER` / `WORKER_AGENT_MODEL`) are extended. New
    `resolveAgentForPhase(config, workflowName, phase)` implements precedence
    (`phases.<phase>` > `workflows.<name>.default` > `agents.default` > repo
    `defaults.agent` > cluster default > built-in `claude-code`), resolving
    provider and model independently. `{ provider, model }` is threaded through
    `CliSpawnOptions` → intent → `LaunchRequest`; provider-aware resume drops the
    session when the next phase resolves to a different provider, and an unknown
    provider fails the phase with a clear message (no silent Claude fallback).
  - `@generacy-ai/generacy-plugin-claude-code`: `ClaudeCodeLaunchPlugin` pushes
    `--model` on `phase`/`pr-feedback` intents when set, mirroring the existing
    conversation-turn path. No-config argv output is unchanged.

### Patch Changes

- 23befe1: Fix fresh wizard clusters never cloning their repo: the post-activation retry replayed `bootstrap-complete` before `GH_TOKEN` was sealed, burning the one-shot clone watcher (#937).

  On a brand-new wizard-provisioned cluster the state is `activated &&
!postActivationComplete` the instant activation completes — so
  `PostActivationRetryService` fired immediately, ~2 minutes before the user
  finished entering credentials, replaying the `bootstrap-complete` lifecycle
  action. The control-plane wrote the post-activation sentinel unconditionally,
  the one-shot clone watcher fired with no token and (correctly) refused, then
  exited — and nothing was left to consume the credentials when they landed.
  This regressed once #838 made the dispatch block reachable on wizard clusters,
  re-opening the race #739 had closed via the `bootstrap-complete` door it left
  ungated.

  - `@generacy-ai/orchestrator`: `checkPostActivationState()` now only sets
    `needsRetry` when the wizard credentials file exists **and** carries a
    non-empty `GH_TOKEN` (mirroring the guard `entrypoint-post-activation.sh`
    applies). On a fresh pre-credentials cluster the retry defers; genuine
    restart-recovery with creds already sealed still fires.
  - `@generacy-ai/control-plane`: defense-in-depth — the `bootstrap-complete`
    lifecycle handler now gates its sentinel write on `hasGitHubToken`, exactly
    like the sibling `prepare-workspace` handler, so a token-less replay can never
    fire the one-shot clone.

- Updated dependencies [5488c4c]
- Updated dependencies [92ca0b4]
- Updated dependencies [23befe1]
  - @generacy-ai/orchestrator-types@0.2.0
  - @generacy-ai/generacy-plugin-claude-code@0.3.0
  - @generacy-ai/config@0.4.0
  - @generacy-ai/control-plane@0.7.2

## 0.7.0

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

- 3af070c: Add the `generacy cockpit resume <issue-ref>` verb to re-arm a failed phase (#891).

  This is the engine-owned re-arm primitive the auto-mode escalation gate's
  "Requeue" action needs — without it, every `agent:error` / `failed:*` escalation
  degraded to Skip and a run with any failed issue could never reach
  `epic-complete`. `resume` performs label surgery per the protocol: it clears
  `agent:error`, `failed:<phase>`, and any stray `phase:<phase>`, then restores the
  `waiting-for:<preceding-gate>` + `completed:<preceding-gate>` + `agent:paused`
  triple of a naturally-paused-then-completed gate (the gate that _precedes_
  `<phase>` in the workflow definition), preserving prior `completed:<earlier-phase>`
  labels so the resolver restarts at `<phase>` rather than from specify. It routes
  through the unified `resolveIssueContext` grammar (bare number or full URL), is
  idempotent (clear no-op when the issue isn't failed), and exits non-zero with
  evidence when the state can't be re-armed (no preceding gate, unknown phase
  suffix, conflicting labels).

  `@generacy-ai/orchestrator` now exports its phase-resolution surface
  (`PhaseResolver`, `GATE_MAPPING`, `WORKFLOW_GATE_MAPPING`, `PHASE_SEQUENCE`,
  `WORKFLOW_PHASE_SEQUENCES`, `getPhaseSequence`, `WorkflowPhase`) so the verb can
  compute the preceding gate from the active workflow definition.

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

- 0ceafb2: Surface a real orchestrator version on `/health` so connected clusters stop reporting `v0.0.0` (#907).

  The `/health` route never emitted a `version` field, so cluster-relay's metadata
  collector fell back to the literal `"0.0.0"` and forwarded that to the cloud
  dashboard for every cluster. A new `resolveOrchestratorVersion()` service resolves
  the build identifier from `ORCHESTRATOR_VERSION` (the canonical build-time env var),
  falling back to the package's `package.json` version, and finally to the sentinel
  `"unknown"` — with the literal `"0.0.0"` treated as "no real version" from either
  source so a stray env var or workspace-default cannot reproduce the symptom. The
  handler now emits `version`, and it is declared on both the Fastify response schema
  and the Zod `HealthResponseSchema` (required `z.string()`) so Fastify no longer
  strips it on serialization.

- e829db2: feat(orchestrator): per-repo validate command overrides via .generacy/config.yaml

  The validate-phase commands (`validateCommand` / `preValidateCommand`) were
  orchestrator-global and monorepo-shaped (`pnpm test && pnpm build`). A single
  orchestrator serves many repos, so a single-package repo with a different shape
  (e.g. an Astro site with no `test` script) failed validate on every issue —
  `pnpm test` exits non-zero before the build runs.

  The target repo's `.generacy/config.yaml` `orchestrator` block can now set
  `validateCommand` / `preValidateCommand`, which are merged onto the global
  worker config per-job before the phase loop runs.

  - `@generacy-ai/config`: `OrchestratorSettingsSchema` gains optional
    `validateCommand` / `preValidateCommand`.
  - `@generacy-ai/orchestrator`: new pure helper `applyRepoValidateOverrides`
    (preserves an explicit empty `preValidateCommand` = skip install); the worker
    loads the repo's orchestrator settings at the existing per-job config hook and
    passes the merged config to the phase loop. Backward-compatible — repos
    without the block keep the global defaults.

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

- b3bad08: Resume the VS Code tunnel and code-server on cluster restart (#824).

  `generacy stop` explicitly stops the VS Code tunnel and code-server, but on the next
  boot neither was ever restarted: the sole auto-start site is the control-plane
  `bootstrap-complete` handler, which the orchestrator only replays when
  `PostActivationRetryService` reports `needsRetry === true`. On a healthy,
  already-activated cluster (`activated && postActivationComplete`) `needsRetry` is
  false, so `bootstrap-complete` never replayed and the tunnel/code-server stayed dead
  until a full re-activation. A new `BootResumeService` now runs in `server.ts`'s
  existing-API-key branch when the cluster is already activated, firing best-effort,
  concurrent `vscode-tunnel-start` and `code-server-start` lifecycle POSTs (both
  managers are idempotent). Failures surface per-service on the `cluster.bootstrap`
  channel without marking the cluster degraded; it runs after the relay bridge is
  initialized so the first `starting` events reach the cloud.

- 1d6c1b3: Fire boot-resume on wizard-provisioned clusters, not just the env-key branch (#834).

  The #824 boot-resume fix only ran in `createServer()`'s existing-API-key branch, but
  wizard-provisioned clusters boot with `config.relay.apiKey` empty (the key is persisted
  to `/var/lib/generacy/cluster-api-key` and reloaded during activation), so they always
  take the `activateInBackground` path — which handled only the `PostActivationRetryService`
  retry case and never constructed `BootResumeService`. Net effect: on every dev cluster
  the VS Code tunnel and code-server stayed down after a `stop`/`start`. The shared
  "check post-activation state → retry (`needsRetry`) or resume (`activated &&
postActivationComplete`)" logic is now hoisted into `runPostActivationBranch`, which both
  the synchronous existing-key branch and `activateInBackground` call, so the two startup
  paths can no longer drift. A regression test drives the `activateInBackground` path with
  `activated && postActivationComplete` state and asserts the resume branch fires.

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

- f18ea20: Fix orchestrator resume dedupe stranding legitimate same-gate re-visits (#849).

  The ~12h resume dedupe TTL was surviving across a pause, so a second resume
  event for the same gate (e.g. the re-review loop after `address-pr-feedback`)
  was deduped away and never enqueued. `LabelManager.onGateHit` now invalidates
  the paired `resume:<gate>` dedupe key immediately after the pause labels land
  on GitHub, via a best-effort worker-mode `PhaseTrackerService.clear` callback.
  The clear is one-shot and only runs once the `waiting-for:<gate>` label is
  confirmed applied, so a dedupe is never cleared for a pause that didn't
  manifest.

- b1fb790: Re-enable the orchestrator and generacy test suites in CI and add a dedicated integration job, surfacing tests that were silently excluded (#871).

  CI's `Test (packages)` step previously filtered out `@generacy-ai/orchestrator` and `@generacy-ai/generacy`, hiding their failures on develop. The filter is removed so both suites run, a new `integration` job runs `test:integration` across packages against a Redis service, and the launcher classes (`AgentLauncher`, `GenericSubprocessPlugin`) are now exported as runtime values from `@generacy-ai/orchestrator` (previously type-only) so cross-package spawn-snapshot parity tests can construct them. The red tests this exposed are fixed: the `health-code-server` test now passes config via the `{ config }` options shape, the `relay-bridge` metadata test mocks `node:fs/promises` so `collectMetadata()` is deterministic under fake timers, and the `setup workspace` no-config test mocks `readdirSync` so the workspace scan reaches the intended `exit(1)`.

- a951c1f: Provision the cluster's acting identity so the #869 cluster-identity trust rule actually fires (#874).

  The #869 trust machinery shipped correctly but was inert: it compared PR-feedback comment authors against a cluster identity that was never provisioned. On a scaffolded cluster with App credentials, `resolveClusterIdentity()` returns nothing (`gh api user` 403s on App installation tokens), so the trust predicate ran its degraded mode permanently and every first-party comment authored by the App bot was classified untrusted. This introduces a distinct **acting login** (the App bot account that authors the cluster's own comments) separate from the assignee-identity chain (whose issues the cluster works), normalizes the `[bot]` suffix so REST-form (`generacy-ai[bot]`) and GraphQL-form (`generacy-ai`) author logins compare equal, has both the local scaffolder and cloud-deploy write it, and makes the degraded mode observable — `clusterIdentity` is included in every `untrustedCommentSkips` warn and a single identity-resolution-failure error is emitted per process start when resolution fails.

- 4f817e0: Fix the clarification answer-scanner treating engine-authored question
  comments as answers (#909). `integrateClarificationAnswers` now filters
  comments carrying a clarification-question marker _before_ the author-trust
  check, so a cluster's own question comment can no longer pass the trust gate
  (under #910 the cluster identity is trusted) and be parsed as `Q<n>:` answers
  — which caused the gate to see all questions as already answered. The four
  engine question-marker dialects are consolidated into a single
  `clarification-markers.ts` (`CLARIFICATION_QUESTION_MARKERS`,
  `commentCarriesQuestionMarker`, `matchClarificationQuestionMarker`) with
  line-anchored, case-sensitive matching so `> `-quoted markers in human answers
  still integrate, and `isQuestionComment` delegates to the same predicate. The
  untrusted-answer explainer now tells authors to re-post answers themselves in
  the `Q1: <answer>` format.
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
- c39e1fa: Fix the orchestrator phase-loop running the pre-phase base-merge twice per
  validate cycle (#914). The second call site (between `install` and `validate`,
  added in #864) re-ran `git reset --hard` + `git clean -fd` and destroyed the
  freshly-installed toolchain, breaking the validate step. The base-merge now
  runs at most once per cycle: a block-scoped `hasBaseMergedThisCycle` guard is
  set after the single pre-`install` merge, the redundant between-install-and-
  validate call site is removed, and the `implement` path is wrapped in the same
  guard (symmetry immunization) so a future edit cannot reintroduce a double
  merge. The guard re-initializes on every loop iteration, preserving the
  existing retry semantics (`i--; continue;`).
- daec0ee: Surface classifier reason in failure evidence so alerts stop lying about exit 0 (#915).

  `CommandExitEvidence` gains an optional `reason?: string` field, populated from
  `result.error.message` when the caller passes an explicit `classifier` argument to
  `PhaseLoop.buildErrorEvidence`. On synthetic post-exit failures (product-diff guard,
  no-progress guard, spawn-error catch, product-diff-error catch), the exit descriptor
  is reworded from the bare `exit <N>` literal to
  `failed post-exit: <classifier> (process exit <N>)` and the reason string appears
  above the output tail in both the stage-comment evidence block and the
  bottom-of-thread failure alert. Backticks are ZWSP-escaped and multi-line reasons
  render as a fenced `text` block capped at 1 KiB with a `…` truncation marker.

  Purely additive: process-failure callsites (`:294` pre-validate install, `:548`
  post-phase process failure) pass `classifier: undefined`, so their evidence shape
  and rendering are byte-identical to pre-#915. Pre-fix serialized `errorEvidence`
  blobs deserialize unchanged (the new field is optional).

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

- ff9da3a: fix(orchestrator): boot-resume never fired on wizard clusters — `await relayBridge.start()` stranded the post-activation dispatch

  The `#834` boot-resume was placed after `await relayBridge.start()` in
  `activateInBackground` (the startup path every wizard-provisioned cluster takes,
  since the relay API key is reloaded from disk rather than present in the process
  env). `RelayBridge.start()` awaits `client.connect()`, which is a long-lived
  reconnect loop that only resolves on disconnect — so on a healthy relay the
  `await` never returns and `runPostActivationBranch()` was unreachable dead code.
  The VS Code tunnel therefore never auto-resumed after a `generacy stop`/`start`.

  Start the relay bridge fire-and-forget (`relayBridge.start().catch(...)`),
  mirroring the synchronous existing-key path, so the post-activation dispatch
  runs. Verified end-to-end on a live cluster: after an orchestrator restart the
  boot-resume fires and the tunnel reconnects with no manual intervention.

  The `#834` regression test could not catch this: its relay-client mock resolved
  `connect()` immediately and its control-plane mock omitted `DockerEngineClient`
  (making `relayBridge` null), so the blocking `start()` path was never exercised.
  The test now keeps `connect()` pending and constructs a non-null bridge, and
  fails if the fix is reverted.

- a7e4333: fix: don't let the clarify phase skip its pause on a misparsed answer (#818)

  The clarify gate could complete without pausing on `waiting-for:clarification`
  when the bot's own question comment (or leaked question-side markup) was parsed
  as if it were a human answer. Hardens clarification answer detection in the
  worker:

  - `isQuestionComment` now also recognizes the variant `### Q<n>:` heading shape
    when a section carries question-side markup (`**Question**:` / `**Context**:` /
    `**Options**:`).
  - `parseAnswersFromComments` anchors the `Q<n>:` opener at line start so mid-prose
    references ("as per Q1: yes") no longer capture as answers, and skips (with a
    `SKIPPED_SUSPICIOUS_ANSWER` warning) any captured answer that still contains
    question-side markup.

- 780b8c8: Fix single-package repos failing validate, and surface phase-failure evidence to
  the issue (#847).

  Two related worker gaps observed when a scaffolded single-package repo hit
  `failed:validate`:

  - **Default `preValidateCommand` hard-failed single-package repos.** The default
    ran `pnpm install && pnpm -r --filter './packages/*' build`; on a repo with no
    `packages/` directory the filter matched zero projects, pnpm exited 1, and the
    phase died with "Pre-validate install failed" before `validateCommand` ever
    ran. The default now degrades — it runs the `--filter './packages/*' build`
    half only when a `pnpm-workspace.yaml` and at least one `packages/*/package.json`
    are present, so single-package repos install and validate normally without
    needing a per-repo `orchestrator` override.

  - **`failed:<phase>` posted no diagnostic to the issue.** A failed phase flipped
    its stage comment to an error state with no command, exit code, or stderr — the
    detail lived only in worker container logs. Failed phases now post a bounded
    failure-evidence block (failing command, exit code, and a stderr tail capped to
    the last 30 lines / 4096 bytes) to the issue so it is visible from GitHub and
    the cockpit.

- 121e84b: Fix the PR feedback loop never firing because `Comment.resolved` was never populated (#861).

  Thread resolution is a GraphQL-only concept — the REST endpoint underlying
  `getPRComments()` never exposed it, so `Comment.resolved` was always `undefined`
  and the preflight / read-pr-feedback / orchestrator feedback loop treated every
  thread as unresolved (or silently skipped it). Adds `getPRReviewThreads()`, which
  fetches review threads with their `isResolved` state via GraphQL, and rewires
  `preflight`, `read-pr-feedback`, and the orchestrator PR-feedback handler to use
  it. `getPRComments()` and `Comment.resolved` are deprecated and slated for removal.

- 9d03505: Fix orchestrator resume dedupe stranding issues by keying on in-flight queue state instead of history (#862).

  The previous dedupe keyed on `(issue, gate)` history via a phase-tracker key, so
  its correctness depended on every pause path routing #849's paired-clear callback,
  on no pre-fix keys surviving under the TTL, and on TTL races never landing wrong —
  which produced a second live stranding after #849 shipped. Replaces it with a
  queue-level idempotency check (`enqueueIfAbsent` keyed on the per-issue queue
  itemKey, cleared when the item completes/fails), which is exactly scoped to the
  real purpose — collapsing webhook/poll double-enqueue of the same occurrence — and
  removes the paired-clear obligations and TTL tuning entirely.

- c0753bb: Fix feature branches never syncing with their base, so validate ran on stale trees and conflicts surfaced only at merge (#864).

  Nothing in the pipeline merged the base branch into a feature branch — not at
  implement start, not before validate — so staleness and conflicts surfaced only
  at merge time, after review and validate had already passed against a tree that
  would not exist post-merge (vacuous green). The worker now performs a base-merge
  of `origin/<base>` into the workspace (committed for implement, ephemeral for
  pre-validate/validate) so validation tests the real post-merge tree; merge
  conflicts fail loud with a merge-conflict evidence block and gate label listing
  the conflicted paths. `cockpit queue` additionally warns when an implement
  phase's plan.md declares a dependency on an issue whose PR is not yet merged.

- 6a817e1: Fix phase-failure evidence being invisible because it was rendered as an in-place edit to an hours-old stage comment (#865).

  The #847 failure-evidence block worked but nobody saw it: `StageCommentManager`
  rendered it by editing the existing stage comment in place — a comment posted when
  the workflow started, mid-thread — which generates no GitHub notification and no
  new activity at the bottom of the thread. On failure the orchestrator now also
  posts a fresh alert comment at the end of the thread so watchers are actually
  notified, rather than relying solely on the buried in-place edit.

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

- 65ce4cf: Migrate the PR-feedback enqueue to in-flight queue-state dedupe, completing #862 (#879).

  The pr-feedback surface still deduped via `PhaseTracker.tryMarkProcessed` (a
  `phase-tracker:<owner>:<repo>:<issue>:address-pr-feedback` SET NX with a ~12–24h
  TTL), so a stale key from a prior handler era — or any crash-shaped gap between
  mark and settle — could silently block the first trusted enqueue after a deploy
  and then spontaneously "heal" at TTL expiry. The enqueue now dedupes against
  in-flight queue state (`enqueueIfAbsent` on the per-issue itemKey, the same
  atomic layer the resume path uses post-#862), which self-clears when the item
  completes/fails/is dropped. The `DEDUP_PHASE` / `tryMarkProcessed` usage and
  #869 FR-006's clear-on-exit settlement obligations are removed — one dedupe
  mechanism across both surfaces, no TTL tuning, and the PhaseTracker machinery
  becomes fully deletable as #862 intended.

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

- 38afb3a: Capture stdout in worker error evidence, not just stderr (#890).

  `buildErrorEvidence` tailed only stderr, but Next.js, vitest, and npm write most
  failure detail to stdout — so a `validate` failure like `next build`'s type error
  surfaced in alerts as `stderr: (empty)`, stranding the auto-mode escalation gate
  with nothing to diagnose. The spawn layer now merges stdout+stderr chunks in
  arrival order into a bounded ring buffer (~8 KiB) when no explicit capture is
  attached, and Claude-CLI phases synthesize the tail from the retained `text`
  chunks. `buildErrorEvidence` renders a single interleaved `output` block (keeping
  the 4 KiB byte bound; `CommandExitEvidence.stderrTail` renamed `outputTail`), and
  collapses the both-empty case to one `(no output on either stream)` line instead
  of a misleading `(empty)` marker.

- 747e6bc: Re-arm the interrupted phase after a merge-conflict resolution and leave labels truthful (#902).

  #898's `MergeConflictHandler` success path (agent-resolved or no-op when the
  branch was already clean) never re-armed the paused phase and left
  `agent:in-progress` and `completed:merge-conflicts` set — a state no detector
  matches, so the issue dead-parked forever. The success path now:

  - returns a terminal `{ outcome: 're-armed', startPhase }` to the dispatcher,
    which (as the single queue authority per #889) completes the handler's own
    claim and enqueues the `continue` item — the handler never touches the queue
    itself, avoiding a self-deadlock against #879's single-in-flight rule;
  - sources `startPhase` from `ResolveMergeConflictsMetadata.phase` threaded in-band
    from the pause site, and fails loud with #889-style evidence if it's missing
    rather than re-deriving from labels;
  - consumes the `completed:merge-conflicts` operator-advance marker and clears
    `agent:in-progress`/`agent:paused` residue so a later pause can't insta-resume.

  Codifies the invariant that every handler terminal outcome maps to exactly one of
  re-armed / gated / failed / done, enforced by a post-exit runtime assertion that
  reads the real label set + queue state (not the handler's return value).

- Updated dependencies [aef8f58]
- Updated dependencies [8b5e483]
- Updated dependencies [a951c1f]
- Updated dependencies [09e6d94]
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
  - @generacy-ai/control-plane@0.7.1
  - @generacy-ai/workflow-engine@0.3.0
  - @generacy-ai/generacy-plugin-claude-code@0.2.0
  - @generacy-ai/config@0.3.0

## 0.6.0

### Minor Changes

- 9990cf4: fix: per-phase worker timeouts so plan/implement aren't killed at 10m

  The orchestrator worker applied a single flat `phaseTimeoutMs` (default 10m) to
  every CLI phase, so the heavier `plan` and `implement` phases were SIGKILL'd at
  the deadline mid-work (the worker never wrote `plan.md`), surfacing as a
  `failed:plan` label ~10m after `phase:plan`.

  `WorkerConfig` now supports `phaseTimeoutOverrides`, a per-phase map that falls
  back to `phaseTimeoutMs` for any phase without an override. `plan` and
  `implement` default to 60m; the fallback for the lighter phases is raised to
  20m. Overrides are
  configurable without code changes via `orchestrator.yaml`
  (`worker.phaseTimeoutOverrides`) or env vars: `WORKER_PHASE_TIMEOUT_MS` for the
  fallback and `WORKER_PHASE_TIMEOUT_<PHASE>_MS` (e.g. `WORKER_PHASE_TIMEOUT_PLAN_MS`)
  per phase.

## 0.5.1

### Patch Changes

- 8d152d0: Fix JIT gh-token provider on wizard-bootstrapped clusters (#777).

  The gh JIT token provider was gated on a `github-app` credential descriptor
  that wizard-bootstrapped clusters never have, so it was always `undefined` and
  every `gh` call fell back to the expired ambient `GH_TOKEN`. The provider is now
  built whenever the control-plane `/git-token` path is available and fetches
  credential-less (passing `credentialId` only when a descriptor exists). When a
  provider is present, `GH_TOKEN` is always set on the `gh` subprocess (never
  `undefined`), so it can no longer inherit the stale ambient token.

- Updated dependencies [8d152d0]
  - @generacy-ai/workflow-engine@0.2.1

## 0.5.0

### Minor Changes

- daed90b: feat: route gh-CLI GitHub API calls through the JIT token provider (#773)

  Completes the JIT credential migration: the gh-CLI GitHub API path no longer
  relies on the static wizard `GH_TOKEN`, which expired after ~1h and caused
  workers and the orchestrator to 401 mid-run. The orchestrator now mints
  short-lived installation tokens on demand via the JIT GitHub token provider
  (`jit-github-token-provider`), with the wizard-creds provider retained as a
  fallback, and the control-plane git-credential helper resolves tokens through
  the shared `jit-git-token-client`.

### Patch Changes

- Updated dependencies [daed90b]
  - @generacy-ai/control-plane@0.7.0

## 0.4.1

### Patch Changes

- Updated dependencies [6b59696]
- Updated dependencies [474f3e3]
  - @generacy-ai/control-plane@0.6.0

## 0.4.0

### Minor Changes

- 223d320: feat: cluster-side backstop for expired/near-expiry GH_TOKEN (#762)

  Detect an expired or near-expiry GitHub token and request a refresh instead of
  silently 401-looping. `workflow-engine` now surfaces `GhAuthError` and
  `parseGhStatusCode` so callers can distinguish auth failures, and the
  `orchestrator` adds a credential-expiry watcher plus GitHub auth-health state
  (exposed on the health route) so the label and PR-feedback monitors drive a
  credential-refresh request rather than repeatedly failing on 401s.

### Patch Changes

- Updated dependencies [3652b0d]
- Updated dependencies [223d320]
  - @generacy-ai/control-plane@0.5.0
  - @generacy-ai/workflow-engine@0.2.0

## 0.3.0

### Minor Changes

- c8bdfa0: Add pre-approved device-code activation for managed cloud clusters.

  The cloud can now bake a single-use, short-TTL RFC 8628 device code into a
  cluster's `.env` (`GENERACY_PRE_APPROVED_DEVICE_CODE`), threaded through the
  launch/deploy/cluster scaffolders via a new optional `preApprovedDeviceCode`
  config field. On first boot, the orchestrator's `activate()` redeems the
  pre-approved code directly — skipping `requestDeviceCode` — and falls back to
  the interactive device-code flow on terminal failure rather than crash-looping.

- 6f74140: feat: per-cluster tunnel name + identity for multi-cluster support (#744)

  Adds cluster/CLI/orchestrator-side support for multiple, user-named clusters
  per project.

  - `deriveTunnelName` is now keyed on the per-cluster UUID (not the projectId),
    so each cluster in a project gets a distinct, ≤20-char, lowercase,
    letter-initial tunnel name. The constraint is documented next to the helper.
  - `generacy launch --name <name>` (and the scaffolder) accept an optional human
    cluster name; when omitted, a default `<sanitized-project>-local-<n>` is
    generated. The name is fixed at creation and persisted into the scaffolded
    cluster identity.
  - The orchestrator cluster identity now carries the cluster UUID and display
    name, surfacing the name in registration so the cloud can show it, while the
    short derived tunnel name stays decoupled from the display name.
  - Deleting/stopping a cluster now unregisters/turns off its dev tunnel so the
    name is freed for reuse.

- dc03887: feat(orchestrator): detect cluster identity split and emit relay event (#750)

  Adds an identity-split detector that compares `process.env.GENERACY_CLUSTER_ID`
  against the persisted `cluster.json.cluster_id` during server startup. On
  mismatch it emits a single `cluster.identity-split` relay event per orchestrator
  process lifetime — surfacing clusters whose injected env identity has diverged
  from their persisted identity.

  The detector is best-effort and non-fatal: it never mutates env, `.env`, or
  `cluster.json`, and drops the event if no relay client is available. The new
  `cluster.identity-split` channel is added to the internal relay-events allowlist,
  and detection runs on both the existing-key and wizard-mode activation paths.

### Patch Changes

- cca7963: fix(orchestrator): fall back to GH_USERNAME for cluster identity (assignee filtering)

  The label-monitor resolves the cluster's GitHub identity to filter issues by
  assignee. It checked `CLUSTER_GITHUB_USERNAME`, then `gh api /user`, then gave
  up ("filtering disabled, all issues processed"). On cloud/wizard clusters the
  credential is a GitHub App installation token (`<app>[bot]`), which can't call
  `/user`, so identity resolution failed and the cluster processed every issue
  instead of only those assigned to the selected account.

  `resolveClusterIdentity` now falls back to `GH_USERNAME` — the human account
  the installation belongs to, already delivered to the cluster by the wizard —
  between the explicit config var and the `gh api /user` attempt. `CLUSTER_GITHUB_USERNAME`
  still takes precedence.

- Updated dependencies [6f74140]
- Updated dependencies [967718e]
- Updated dependencies [30ce711]
  - @generacy-ai/control-plane@0.4.0
  - @generacy-ai/cluster-relay@0.3.0

## 0.2.1

### Patch Changes

- 2cc3abc: Catch stable up after #727 (cluster-side `tier-limit-exceeded` handling per
  [generacy-cloud#700](https://github.com/generacy-ai/generacy-cloud/issues/700))
  and #730 (empty-tier formatter fix per #728) shipped without their own
  changesets. The latter should have been caught by the new gate from #729, but
  slipped through because the PR branch predated the gate's merge by minutes and
  was never rebased — the workflow YAML resolved from the PR's HEAD (old/permissive
  version) rather than from develop's HEAD (new/strict version).

  Per-package summary:

  - `@generacy-ai/activation-client` — **minor** (additive public-API surface):
    new `tier-limit-exceeded` variant on `PollResponseSchema` carrying
    `{ cap, requested, tier }`; new exported `formatTierLimitError` function
    shared between the resolver-side gate and the poll-time reject; empty-tier
    formatter rendering fixed.
  - `@generacy-ai/orchestrator` — **patch**: new `TIER_LIMIT_EXCEEDED`
    `ActivationError` code; activation flow throws on the new poll variant
    with the formatted message.
  - `@generacy-ai/generacy` — **patch**: deploy command's activation poll
    branches on the new variant; `worker-count-resolver` refactored to use
    the shared `formatTierLimitError` instead of an inline string (closes
    the wording-drift between resolver-side and poll-time error messages).

- Updated dependencies [2cc3abc]
  - @generacy-ai/activation-client@0.3.0

## 0.2.0

### Minor Changes

- 007dc5f: Worker-scale architecture: catch `stable` up with `preview` after ~10 feature
  PRs shipped without per-PR changesets. The whole story is around treating
  worker count as host capacity rather than project intent.

  Highlights:

  - `@generacy-ai/control-plane` — Engine API client + worker-scaler refactor
    (no compose-file dependency); merged cluster.yaml / cluster.local.yaml
    read helper; app-config wired to the merged view; `enumerateWorkers`
    and `computeProjectName` exported for orchestrator use (#707, #711, #713).
  - `@generacy-ai/orchestrator` — metadata reports actual running container
    count via Engine API enumeration; Docker container-event subscription
    with reconnect+backoff for sub-10s responsiveness; CWD fix for
    workspace-relative file reads; reads `GENERACY_INITIAL_WORKERS` at boot
    (#715, #717).
  - `@generacy-ai/generacy` (CLI) — `--workers <N>` flag and interactive
    prompt at launch; tier-cap-bounded resolver (`CLI_FALLBACK_TIER_CAP=8`,
    `SUGGESTED_FROM_HOST=2`); no-TTY default with warning; reconcile path
    reads merged config and writes `.env`'s `WORKER_COUNT` ahead of compose
    (#713, #717).
  - `@generacy-ai/activation-client` — device-code poll body carries the
    host-chosen `workers` value so the cloud can set `targetWorkers` at
    activation (#717).
  - `@generacy-ai/config` — new `readMergedClusterConfig` helper providing
    shallow per-top-level-key merge of `cluster.yaml` + `cluster.local.yaml`
    (local wins); the canonical reader used by orchestrator's relay-bridge
    and control-plane's app-config / worker-scaler (#711).
  - `@generacy-ai/cluster-relay` — wire-format rename `workerCount` →
    `workers` to match the cluster.yaml schema flatten (#697 on cloud side).

  Minor across the board because the API surface is additive (new flags,
  new helpers, new fields) but substantial enough that semver-patch would
  undersell the scope.

### Patch Changes

- Updated dependencies [007dc5f]
  - @generacy-ai/control-plane@0.3.0
  - @generacy-ai/activation-client@0.2.0
  - @generacy-ai/config@0.2.0
  - @generacy-ai/cluster-relay@0.2.0

## 0.1.3

### Patch Changes

- d0cdf36: Force a republish of `@generacy-ai/orchestrator` after the release workflow was fixed to actually rewrite `workspace:` dependencies. The previous publish (0.1.2) shipped with `workspace:^` literals in `dependencies` because `pnpm changeset publish` internally shells out to `npm publish`, which doesn't understand the workspace protocol. The fixed workflow uses `pnpm -r publish` (matching what `publish-preview.yml` already does) so the rewrite happens at pack time. This release retires the broken 0.1.2.

## 0.1.2

### Patch Changes

- 8b1a12d: Fix workspace:^ dependency leak in published package. Add prepublishOnly guardrail to all publishable packages to prevent future publishes with unresolved workspace: protocol specifiers.
- Updated dependencies [95f3c52]
  - @generacy-ai/control-plane@0.2.0

## 0.1.1

### Patch Changes

- 6779a85: Bulk patch bump to populate the `stable` npm dist-tag for the 14 packages that were left at 0.1.0 by the previous changeset cycle (which only listed `@generacy-ai/generacy` and `@generacy-ai/cluster-relay`).

  After this changeset is consumed by changesets/action and the resulting version-packages PR merges to main, all 16 public `@generacy-ai/*` packages in this repo will be on `stable` on npm.

- Updated dependencies [6779a85]
  - @generacy-ai/activation-client@0.1.1
  - @generacy-ai/config@0.1.1
  - @generacy-ai/control-plane@0.1.1
  - @generacy-ai/credhelper@0.1.1
  - @generacy-ai/generacy-plugin-claude-code@0.1.1
  - @generacy-ai/workflow-engine@0.1.1

All notable changes to the `@generacy-ai/orchestrator` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Automatic PR ready-for-review marking: When the orchestrator workflow completes successfully (all phases done), the draft PR is now automatically marked as ready for review. This eliminates the need for manual intervention and ensures reviewers are notified immediately upon completion.
  - Added `PrManager.markReadyForReview()` method to convert draft PRs to ready state
  - Integrated with workflow completion flow in `claude-cli-worker.ts`
  - Idempotent operation: safely handles non-draft PRs without errors

### Changed

- Updated workflow completion behavior to transition PRs from draft to ready state automatically

## [0.1.0] - Initial Release

### Added

- Initial release of the orchestrator package
- Multi-phase workflow execution: specify → clarify → plan → tasks → implement → validate
- GitHub integration with draft PR creation and management
- Label-based workflow state tracking
- SSE-based progress reporting
