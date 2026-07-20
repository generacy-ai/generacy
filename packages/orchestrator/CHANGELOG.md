# Changelog

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
