# @generacy-ai/generacy

## 0.8.0

### Minor Changes

- f7acfbc: Detect LLM-authored epics with `####` phase headers as a loud warning (#1006).

  `@generacy-ai/cockpit`: `parseEpicBody` now emits a `warnings[]` entry containing
  the stable marker substring `phase headers must be '###'` when an epic body has
  zero-populated phases, non-empty ad-hoc refs, and at least one phase-shaped
  `####` heading (e.g. `#### P1 — …` or `#### Phase 2`). Turns a silent
  `/cockpit:auto` stall into an immediate, actionable signal.

  `@generacy-ai/generacy`: `cockpit status --json` envelope and `cockpit_status`
  MCP tool `data` payload gain an additive `warnings: string[]` field, verbatim
  from `parsed.warnings` (empty array on clean bodies). Non-breaking: existing
  consumers that read only `scope` and `rows` continue to work.

### Patch Changes

- Updated dependencies [d15dba7]
- Updated dependencies [f7acfbc]
- Updated dependencies [47ba255]
  - @generacy-ai/orchestrator@0.10.1
  - @generacy-ai/cockpit@0.6.0

## 0.7.0

### Minor Changes

- 31ce4d3: `cockpit doorbell` now emits each event as a full NDJSON line instead of the bare
  event-type discriminator (#985). The wire shape mirrors `cockpit watch` and
  carries `{ type, repo, kind, number, event, to, labels, url, … }` at minimum, so
  `/cockpit:auto` can dispatch without re-querying GitHub per wake — removing the
  ~5000 pts/hr GraphQL rate-limit amplifier. The smee path also populates `to`
  locally via `classifyIssue` (zero added `gh` calls) and stamps an optional
  `checks: 'green' | 'red'` verdict on `pr-checks` / `completed:validate` events
  using the periodic poll's cached `PrSnapshot.checksRollup`.
- d8f5388: Cap smee.io SSE reconnect backoff at 30s (was 5min) and add equal jitter, sharing
  the algorithm via a new `@generacy-ai/smee-backoff` package. Reduces real-time
  recovery latency for the orchestrator webhook receiver and the cockpit doorbell
  after a transient smee.io outage.

### Patch Changes

- ca865c3: Add a `webhook-config` stage to the `/cockpit:auto` doorbell channel discovery that reads the smee.io URL directly from the registered repo webhook via `gh api /repos/{owner}/{repo}/hooks`, removing the `COCKPIT_DOORBELL_SMEE_URL` workaround for operator sessions that do not share the cluster's filesystem.
- 887242f: fix: cockpit_context now finds clarification comments after `waiting-for:clarification` label re-application

  `findClarificationComment` used to anchor on the most-recent `labeled` timeline event, which failed whenever requeue / boot-resume / cluster-restart re-applied the label without re-posting questions. It now positively identifies clarification-question comments via the shared `CLARIFICATION_QUESTION_MARKERS` registry (marker-first), falling back to the label-timeline heuristic with a deprecation warn when no marker-carrying comment exists. Resolves #995.

- 7f9abdf: Runtime demotion in the cockpit doorbell is now a non-terminal live bridge that
  keeps the sensor stdout stream open across smee.io outages and quiet windows
  (#997, `workflow:speckit-bugfix`).
- aeef996: Raise the cockpit MCP event-bus retention window and registry idle-TTL defaults
  from 10 min to 120 min, expressed as a single shared exported constant
  (`DEFAULT_QUIET_HORIZON_MS`) in
  `packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts` so the two
  horizons cannot silently desync (FR-001 / FR-002 / FR-003, #999). Fixes
  `resetFrom:"discarded"` / `"expired"` cursor recoveries during long quiet
  implementation phases of `/cockpit:auto`. Env-var override surface
  (`COCKPIT_MCP_BUS_IDLE_TTL_MS`, `COCKPIT_MCP_EVENT_RETENTION_MS`) and
  constructor/options seams unchanged; `retentionCount = 10_000` unchanged.
- Updated dependencies [e4d91d7]
- Updated dependencies [d8f5388]
- Updated dependencies [890a2e3]
  - @generacy-ai/orchestrator@0.10.0
  - @generacy-ai/smee-backoff@0.2.0

## 0.6.0

### Minor Changes

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
- bd43b04: Add `generacy cockpit doorbell <epic-ref>` — a wake-sensor CLI verb for
  `/cockpit:auto` (agency#431). The verb spawns as a background sensor,
  constructs its own in-process refcounted `EpicEventBus` via `acquireEpicBus`,
  and emits one newline-terminated stdout line per bus event (the event `type`
  word: `issue-transition`, `phase-complete`, `epic-complete`) plus an initial
  out-of-band `armed` line. Three arming forms: `doorbell <epic-ref>`,
  `doorbell <tracking-ref> --tracking`, `doorbell --new "<title>"`. Optional
  `--exit-on-epic-complete` mirrors `cockpit watch`. Unblocks auto-drive wake
  latency, which was silently degrading to the 5-min `ScheduleWakeup` heartbeat
  because the skill's arm-command was returning `error: unknown command
'doorbell'`.
- 6770cbc: Wire the smee doorbell end-to-end for operator sessions on smee-live clusters.

  The orchestrator's `SmeeChannelResolver` now mirrors the resolved channel URL
  to a shared workspace path so operator devcontainer/tunnel sessions — which
  do not mount the cluster-internal `generacy-data` volume — can discover it,
  and the doorbell's startup `gh` calls survive transient failures via a two-
  tier retry envelope instead of `exit(2)`-ing on the first hiccup.

### Patch Changes

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

- 4c1ff4d: Add defensive content guard to `findClarificationComment` so stage-status
  tables never surface as the clarification batch (#962).

  The finder previously selected the first at-or-after `waiting-for:clarification`
  comment purely by timing, with no body check. #960's symptom (a
  `<!-- generacy-stage:planning -->` status table returned as the clarification
  batch) was only latent because #958 stopped the engine from self-answering
  inside the at-or-after window. The guard rejects candidates whose body carries
  one of six stage-status prefixes (`<!-- generacy-stage:{planning,specification,
implementation}` and the legacy `<!-- speckit-stage:*` twins) at column 0,
  unless the same body also carries a `<!-- generacy-stage:clarification*` override
  marker. Rejected candidates are skipped and scanning continues; the finder
  returns `null` only when every at-or-after candidate is rejected.

- 55844a0: Reduce cockpit's GraphQL point spend during `/cockpit:auto` runs so a single
  shared-token operator doesn't exhaust GitHub's 5k/hr GraphQL bucket. Five
  coordinated fixes at the cockpit CLI + `GhCliWrapper` layer:

  - New `GhResponseCache` — 20s TTL read-through cache with in-flight coalescing
    wired into the four hot-path GraphQL methods (`getPullRequestCheckRuns`,
    `getIssue`, `resolveIssueToPR`, `getPullRequest`). Opt-in via
    `new GhCliWrapper(runner, logger, { cache })`.
  - New `RateLimitScheduler` — probes `gh api rate_limit` and widens the poll
    interval on a hysteresis ladder (`< 20% → 2× base`, `< 5% → 4× base`,
    ceiling `5 min`). Honours `retry-after` when present.
  - New `derivePrChecksNeeded()` gate on `runOnePoll` — skips
    `getPullRequestCheckRuns` for terminal-green PRs until head-SHA changes,
    labels change, or a 20-cycle safety re-fetch fires.
  - `resolveEpic` is now refreshed only every 10th cycle in both the CLI watch
    loop and the MCP event-bus loop (was every cycle).
  - `PauseState.skipNextCycle` prevents the immediate-post-catch-up double poll
    after a paused event bus resumes.

  New public exports on `@generacy-ai/cockpit`: `createGhResponseCache`,
  `GhCacheOptions`, `GhResponseCache`, `createRateLimitScheduler`,
  `RateLimitSchedulerOptions`, `RateLimitScheduler`, `RateLimitProbeResult`,
  `GhCliWrapperOptions`, plus a new optional `headRefOid?: string` field on
  `PullRequestSummary`. Bare `new GhCliWrapper(runner)` retains pre-#970
  behavior exactly.

- ffe6d31: `cockpit doorbell` swaps its wake source to a smee.io SSE consumer when a
  cluster smee channel is configured, keeping the existing 30s event-bus poll
  loop as a safety-net fallback (#978). No CLI surface changes and no public
  schemas move (Q1=A preserved): `CockpitEventSchema` enum is unchanged and
  `armed\n` still writes immediately after argument validation. Real-time-first
  on smee-live clusters drops label-to-wake latency from ~25s to ≤ ~3s p95;
  poll-only clusters see no behavior change.
- 80cbd26: fix(cockpit): treat GitHub rate-limit errors as retriable in the doorbell startup-retry classifier

  `classifyGhError` did not recognize GitHub rate-limit errors — the GraphQL primary limit surfaces as plain text (`API rate limit already exceeded …`) with no `HTTP 429` marker, and the secondary/abuse limit arrives as `HTTP 403` — so both fell through to `permanent`, causing `generacy cockpit doorbell` to `exit(3)` instead of retrying. Because rate-limiting is the dominant transient `gh` failure on a shared token, a rate-limited `acquireEpicBus`/`resolveEpic` would kill the wake sensor mid-run and drop `/cockpit:auto` to the 5-minute heartbeat. Primary, secondary, and abuse-detection rate-limit messages are now classified retriable, matched before the permanent 401/403 rules so a 403 secondary limit is no longer mistaken for a scope error.

- Updated dependencies [cbaa48f]
- Updated dependencies [c7807a3]
- Updated dependencies [f26480e]
- Updated dependencies [9341fd1]
- Updated dependencies [bb60299]
- Updated dependencies [d0bafbc]
- Updated dependencies [d4ca687]
- Updated dependencies [1b6d362]
- Updated dependencies [679d2e7]
- Updated dependencies [520b1f1]
- Updated dependencies [405ed96]
- Updated dependencies [55844a0]
- Updated dependencies [01bbb03]
- Updated dependencies [73fe178]
- Updated dependencies [6770cbc]
  - @generacy-ai/orchestrator@0.9.0
  - @generacy-ai/workflow-engine@0.4.0
  - @generacy-ai/cockpit@0.5.0

## 0.5.0

### Minor Changes

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

- Updated dependencies [5488c4c]
- Updated dependencies [92ca0b4]
- Updated dependencies [0b3d72c]
- Updated dependencies [23befe1]
  - @generacy-ai/orchestrator@0.8.0
  - @generacy-ai/orchestrator-types@0.2.0
  - @generacy-ai/config@0.4.0
  - @generacy-ai/cockpit@0.4.0

## 0.4.0

### Minor Changes

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

- Add the `generacy cockpit manifest <init|sync>` verb (#790).

  `manifest init` parses the epic issue body into the per-epic manifest at
  `.generacy/epics/<slug>.yaml` (deriving the slug, extracting the plan, and
  laying out the phase entries); `manifest sync` reconciles an existing manifest
  against the epic body by diffing phases and applying the resulting change set.
  Both subverbs share testing seams (`runner` / `gh` / `stdout` / `stderr` /
  `cwd`) and surface error paths through `CockpitExit`.

- b2ac48d: Add the `generacy cockpit queue <phase>` verb (#791).

  `queue` resolves a phase (by tier or name) across the epic manifests in
  `.generacy/epics/*.yaml`, groups the phase's issues to a single target repo,
  classifies each issue's eligibility, and — confirm-gated — assigns every
  eligible issue to the cluster account and applies its derived
  `process:speckit-feature` / `process:speckit-bugfix` workflow label. Ineligible
  issues (closed, cross-repo, no phase, not found) are reported as skips in the
  preview.

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
- 1296043: Wire the `@generacy-ai/claude-plugin-cockpit` commands into Claude Code during
  `generacy setup build` (#816). The setup build now resolves the cockpit
  commands directory using the same 4-tier lookup as speckit (local workspace →
  shared packages volume → npm global) and copies its `*.md` command files into
  `~/.claude/commands/cockpit/`, so the `/cockpit:*` commands are available
  alongside `/speckit:*`. When the plugin package is not installed, the build logs
  a warning listing the paths checked instead of failing.
- 2fb1529: Fix the cockpit CLI argument-contract drift found during the v1 integration
  smoke test (#822). `cockpit status` and `cockpit watch` now take a positional
  `<epic-ref>` argument matching `cockpit queue`, replacing the required
  `--epic <ownerRepoIssue>` flag (pre-1.0, no compat shim). All three verbs route
  their ref through `resolveIssueContext` first, so a bare issue number
  (`cockpit status 1`) now resolves its `owner/repo` from the cwd git origin — the
  natural `/cockpit:status <ref>` plugin invocation — alongside the existing
  `owner/repo#N` and full-URL forms. Invalid refs fail loud (exit 2) with a
  message enumerating every accepted form.
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

- eb1b9a2: Emit synthetic `phase-complete` / `epic-complete` events from `cockpit watch` (#885).

  `cockpit watch` now derives two NDJSON events from the snapshot diff it already
  computes: `phase-complete` fires once each time the last open issue in a phase
  transitions to closed (state-dominates-labels per #873; `not_planned` counts as
  done, and a reopen→regress→re-complete fires it again), and `epic-complete` fires
  when every phase is complete. `(no phase)` issues are excluded from
  `phase-complete` but counted toward `epic-complete`. A startup sweep emits
  already-complete phases with `initial: true`. The new `--exit-on-epic-complete`
  flag makes watch emit `epic-complete` and exit 0 — the termination edge auto mode
  needs (default behavior unchanged). The event contract is documented in the
  package README.

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

- 23e9612: Add a `generacy cockpit mcp` server that exposes the cockpit verbs as MCP tools
  (#917). The new stdio MCP server registers `cockpit_advance`, `cockpit_context`,
  `cockpit_merge`, `cockpit_queue`, `cockpit_resume`, `cockpit_status`, and
  `cockpit_await_events`, mirroring the CLI surface so an agent can drive an epic
  over MCP with the same ref-input parsing, schemas, and exit semantics. It ships
  an event-bus (with a per-process registry) backing `cockpit_await_events` for
  streaming state transitions, keeps stdout clean for the JSON-RPC transport, and
  refuses to start under a worker cluster role.

  Also teaches the cluster scaffolder to emit `GENERACY_CLUSTER_ROLE`
  (`orchestrator` / `worker`) into the scaffolded docker-compose so the role the
  MCP server checks is present on freshly scaffolded clusters.

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

- 3823a1d: Render phase grouping in `cockpit status` (#828).

  `cockpit status <epic-ref>` previously iterated the flat deduped ref set and
  emitted every child under a single `epic owner/repo#N` header, discarding the
  phase structure that `resolveEpic` already returns. Rows are now grouped under
  their epic-body `### <phase>` headings (a `— P1 — Foundation —` separator row per
  phase), matching the command catalog and mirroring the queue-round mental model
  used when driving an epic. Phase membership is included in each `--json` envelope
  row, a child appearing under multiple phases renders once per phase, and any ref
  under no phase falls into an implicit trailing `— (no phase) —` group.

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

- 82e9ec9: Keep `generacy cockpit watch` alive across poll intervals (#836).

  The watch loop's `sleep()` unref'd its inter-poll timer, so once the first poll's
  async I/O settled and the loop awaited the 30s sleep, nothing referenced kept the Node
  event loop alive — the process drained and exited 0 mid-sleep, never surviving even one
  interval and never emitting a transition line. The `timer.unref?.()` is removed: the
  abort listener already guarantees prompt loop exit on SIGINT/SIGTERM/external abort, so
  nothing hangs at shutdown. An embedder that needs an unref'd timer must gate it behind an
  explicit `WatchDeps` flag the CLI never sets. A subprocess regression test spawns the real
  CLI and asserts the watcher is still alive after more than one interval.

- 1e3e773: Emit initial actionable-state lines on `generacy cockpit watch` startup (#839).

  The watch loop's first poll was a silent baseline — it recorded the current
  snapshot and emitted nothing, so any issue already sitting in an actionable state
  (`waiting-for:*`, `completed:validate`, `failed:*`, `needs:intervention`,
  `agent:error`, or a PR with failing checks) at the moment the watch started was
  never surfaced. A developer running the documented queue → watch order would start
  a watcher that stayed silent about every gate already waiting on them. The first
  poll now runs a startup sweep that emits one NDJSON line per actionable snapshot,
  each marked `initial: true`; non-actionable snapshots stay silent at baseline, and
  polls 2..N keep the existing baseline-on-absent-key behavior. Actionability is
  computed from raw `Snapshot.labels[]` rather than the classifier's tier-collapsed
  `state`, so an issue carrying both a `completed:*` and a `waiting-for:*` label is
  still surfaced. `initial` lines need no consumer-side dedupe — the plugin is
  stateless per line — so re-surfacing pending items on a watch restart is by design.

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

- 96cf908: Fix `cockpit advance`/`context` rejecting bare issue numbers with stale error copy (#850).

  `cockpit advance <ref>` and `cockpit context <ref>` called `parseIssueRef`
  directly instead of the shared `resolveIssueContext` wrapper, so they violated
  the unified issue-ref grammar: bare numbers were rejected and the rejection
  message pointed at the removed `cockpit.repos` config. Both verbs now route
  through `resolveIssueContext`; the bare-number gate moves out of `parseIssueRef`
  (narrowed to a strict qualified-forms-only parser, marked `@internal`) into
  `resolveIssueContext`, and the error copy no longer references `cockpit.repos`.
  A new ESLint `no-restricted-imports` rule blocks direct `parseIssueRef` imports
  from cockpit command files, pointing callers at `resolveIssueContext`.

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

- a951c1f: Provision the cluster's acting identity so the #869 cluster-identity trust rule actually fires (#874).

  The #869 trust machinery shipped correctly but was inert: it compared PR-feedback comment authors against a cluster identity that was never provisioned. On a scaffolded cluster with App credentials, `resolveClusterIdentity()` returns nothing (`gh api user` 403s on App installation tokens), so the trust predicate ran its degraded mode permanently and every first-party comment authored by the App bot was classified untrusted. This introduces a distinct **acting login** (the App bot account that authors the cluster's own comments) separate from the assignee-identity chain (whose issues the cluster works), normalizes the `[bot]` suffix so REST-form (`generacy-ai[bot]`) and GraphQL-form (`generacy-ai`) author logins compare equal, has both the local scaffolder and cloud-deploy write it, and makes the degraded mode observable — `clusterIdentity` is included in every `untrustedCommentSkips` warn and a single identity-resolution-failure error is emitted per process start when resolution fails.

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

- 5d44675: Harden the `cockpit mcp` event-bus against server restarts and between-call
  teardown (#924).

  - Cursor tokens now embed a per-process nonce and a per-bus nonce. A cursor
    minted by a previous server instance (restart) or an evicted bus classifies
    as `discarded` and silently resets to head (`resetFrom: "discarded"`) instead
    of being misread as `never-issued`; on any reset the tool issues a fresh
    nonce-carrying cursor rather than echoing the stale token.
  - The bus registry decouples bus lifetime from call lifetime: `release()` at
    refcount 0 pauses the poller and arms an idle-TTL timer instead of tearing
    the bus down, and the next `acquire()` resumes it and runs a catch-up poll so
    events between calls aren't lost. A soft cap evicts the least-recently-active
    bus on overflow. Tunable via `COCKPIT_MCP_BUS_IDLE_TTL_MS` (default 600000)
    and `COCKPIT_MCP_BUS_MAX` (default 100).

- ffd6bb1: Fix `resolveEpicIssues` dropping cross-repo epic children (#801).

  `resolveEpicIssues` now returns repo-qualified child refs (`{ repo, number }[]`)
  instead of a bare `number[]`, preserving each child's repo — including cross-repo
  entries declared in the manifest (`phases[].issues` / `phases[].repos` as
  `owner/repo#n`). `cockpit status` and `cockpit watch` fetch and classify each
  child in its own repo, and the label-graph fallback searches the configured
  `cockpit.repos` for `epic-parent` references rather than only the epic's own repo.
  This makes `status`/`watch --epic` work for cross-repo epics (e.g. a
  `tetrad-development` epic whose children live in `generacy` and `agency`).

- 2c31a13: Fix `cockpit advance` stranding every issue it advances (#845).

  `advance` previously added `completed:<gate>` and then removed
  `waiting-for:<gate>`. But the orchestrator's poll-path resume detection requires
  the label _pair_: a `completed:*` label whose matching `waiting-for:*` is absent
  is treated as inconsistent and produces no resume event, so poll-only clusters
  (fresh local deploys without webhook delivery) never resume advanced issues —
  they sit at `{completed:<gate>, agent:in-progress, agent:paused}` indefinitely.

  `advance` now posts the manual-advance marker and adds `completed:<gate>` only;
  it no longer removes `waiting-for:<gate>`. Clearing `waiting-for:*`,
  `completed:*`, and `agent:paused` on resume is owned by the worker, which already
  does it. The idempotence and gate-mismatch checks are unchanged, and the
  manual-advance comment wording is updated to reflect that `waiting-for:<gate>` is
  left in place for the worker to clear on resume.

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

- 30c5368: Add a uniform `type` discriminator to every `cockpit watch` NDJSON line (#887).

  The stream interleaved two disjoint schemas — per-issue transitions (keyed on
  `event`, no `type`) and #885's synthetic aggregates (`type: 'phase-complete' |
'epic-complete'`, no `event`) — so any consumer keying on a field present in only
  one shape silently dropped the other (a `grep '"type"'` reader dropped 16 of 17
  lines during the auto-mode smoke test). Per-issue lines now carry
  `"type":"issue-transition"` in addition to all pre-existing fields (`event`
  untouched), the aggregates keep their `type` values, and `CockpitEventSchema`
  becomes a single `z.discriminatedUnion('type', …)`. The change is additive and
  backward-compatible; the full stream grammar is documented in one table in the
  package README.

- Updated dependencies [19e6344]
- Updated dependencies [4af02da]
- Updated dependencies
- Updated dependencies
- Updated dependencies [ae01213]
- Updated dependencies [c909706]
- Updated dependencies [8e08521]
- Updated dependencies [bfe4c87]
- Updated dependencies [b3bad08]
- Updated dependencies [b36c339]
- Updated dependencies [4bb30e1]
- Updated dependencies [1d6c1b3]
- Updated dependencies [1832dbf]
- Updated dependencies [8b5e483]
- Updated dependencies [f18ea20]
- Updated dependencies [9143b62]
- Updated dependencies [c65ec3c]
- Updated dependencies [591059b]
- Updated dependencies [5cdc0bb]
- Updated dependencies [b1fb790]
- Updated dependencies [cf03bb9]
- Updated dependencies [a951c1f]
- Updated dependencies [de0a6bd]
- Updated dependencies [3af070c]
- Updated dependencies [f5b162a]
- Updated dependencies [186a92a]
- Updated dependencies [0d15fa9]
- Updated dependencies [0ceafb2]
- Updated dependencies [4f817e0]
- Updated dependencies [a179720]
- Updated dependencies [bdbee42]
- Updated dependencies [c39e1fa]
- Updated dependencies [daec0ee]
- Updated dependencies [3d718e5]
- Updated dependencies [d27b61e]
- Updated dependencies [368f133]
- Updated dependencies [ff9da3a]
- Updated dependencies [e829db2]
- Updated dependencies [ffd6bb1]
- Updated dependencies [a7e4333]
- Updated dependencies [2d3b73f]
- Updated dependencies [780b8c8]
- Updated dependencies [121e84b]
- Updated dependencies [9d03505]
- Updated dependencies [c0753bb]
- Updated dependencies [6a817e1]
- Updated dependencies [33c9f11]
- Updated dependencies [65ce4cf]
- Updated dependencies [af34d75]
- Updated dependencies [242b950]
- Updated dependencies [38afb3a]
- Updated dependencies [747e6bc]
- Updated dependencies [59615ab]
  - @generacy-ai/cockpit@0.3.0
  - @generacy-ai/orchestrator@0.7.0
  - @generacy-ai/workflow-engine@0.3.0
  - @generacy-ai/config@0.3.0

## 0.3.4

### Patch Changes

- Updated dependencies [8d152d0]
  - @generacy-ai/workflow-engine@0.2.1

## 0.3.3

### Patch Changes

- 9e96a17: Share the `git-token-proxy` socket volume between orchestrator and workers in scaffolded clusters.

  cluster-base#61 introduced a git-token proxy: the orchestrator binds
  `/run/generacy-git-token/control.sock` and workers connect to it to mint JIT
  git installation tokens. The shared volume was added to the cluster-base
  devcontainer compose but not to the scaffolder, so generated local/cloud
  clusters left workers with their own empty `/run/generacy-git-token` —
  `CONTROL_SOCKET_UNREACHABLE`, and worker git operations (clone, commit, push)
  fail. Add `git-token-proxy:/run/generacy-git-token` (rw — Unix socket connect
  needs write) to both services and declare the named volume, mirroring the
  canonical cluster-base compose.

## 0.3.2

### Patch Changes

- Updated dependencies [223d320]
  - @generacy-ai/workflow-engine@0.2.0

## 0.3.1

### Patch Changes

- 0a0f1ac: Share the `.claude` directory volume between orchestrator and workers in scaffolded clusters.

  The generated compose mounted only `~/.claude.json` (a file) and no shared
  `/home/node/.claude` directory volume, so workers never inherited the
  orchestrator's Claude auth, speckit slash-commands, or conversation history.
  Every spec-kit phase launched an unauthenticated Claude CLI, exited "Not logged
  in" in <1s, and the phase runner committed an empty phase — producing PRs with
  phase commits but no real artifacts.

  Align the generated compose with the canonical cluster-base layout: add a shared
  `claude-config:/home/node/.claude` volume on both services, stop mounting
  `workspace` on the worker (per-job checkouts are container-local), and mount
  `shared-packages` read-only on the worker. Only the `.claude` directory is
  volume-mounted — never the `.claude.json` file path (preserving the #737 fix).

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

### Patch Changes

- e429d7f: Fix docker-compose scaffolding for `claudeConfigMode: 'volume'` (deploy/cloud). Previously a named volume was mounted onto the `/home/node/.claude.json` file path, which Docker rejects with "is not a directory". The scaffolder now writes a `claude.json` file next to the compose file and binds it (`./claude.json:/home/node/.claude.json`), chowning it to `1000:1000` (best-effort). `deploy` likewise ensures `claude.json` exists on the remote VM owned by `1000:1000` before `compose up`.

## 0.2.2

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

## 0.2.1

### Patch Changes

- Updated dependencies [e69ed75]
  - @generacy-ai/workflow-engine@0.1.2

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
  - @generacy-ai/activation-client@0.2.0
  - @generacy-ai/config@0.2.0

## 0.1.4

### Patch Changes

- e645ad7: Propagate `repos.primaryBranch` from the cloud LaunchConfig into the scaffolded `.generacy/.env` file. Previously the Zod schema silently stripped the field, so `generacy launch` and `generacy deploy` always wrote a `.env` without `REPO_BRANCH=`. The orchestrator container then fell back to `${REPO_BRANCH:-main}` and `git clone --branch main` aborted for any project whose default branch isn't `main`.

## 0.1.3

### Patch Changes

- Updated dependencies [6779a85]
  - @generacy-ai/activation-client@0.1.1
  - @generacy-ai/config@0.1.1
  - @generacy-ai/orchestrator@0.1.1
  - @generacy-ai/workflow-engine@0.1.1

## 0.1.2

### Patch Changes

- da4825e: Initial `stable` dist-tag release. Publishes current main under the `stable` channel so the orchestrator's `npm install @generacy-ai/<pkg>@stable` resolves.

## 0.1.1

### Patch Changes

- 28428ae: Initial `stable` dist-tag release. Publishes current main under the `stable` channel so the orchestrator's `npm install @generacy-ai/<pkg>@stable` resolves.
