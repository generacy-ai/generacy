# Clarifications

## Batch 1 — 2026-07-27

### Q1: Dispatch gate — process vs. resume events
**Context**: FR-005 mandates a "phase job whose target issue is closed MUST be dropped at dispatch". `LabelMonitorService.processLabelEvent()` enqueues two distinct event types: `type === 'process'` (new work from a `process:*` trigger) and `type === 'resume'` (gate release from `completed:*` + matching `waiting-for:*`). The observed repro (`chore(speckit): complete validate phase for #879`) came from a resume event, not a fresh process event — so a process-only gate would miss the field failure mode.

**Question**: Should the closed-issue drop apply to both `process` and `resume` events, or only `process`?
**Options**:
- A: Both `process` and `resume` — any enqueue on a closed issue is dropped. Log field `dropped: 'issue-closed'` on either path. Matches the observed repro.
- B: Only `process` — resume events legitimately fire on closed issues (e.g., late-arriving gate labels after squash-merge race).
- C: Both, but treat resume-on-closed as an error state (raise `agent:error` label) rather than a silent info-log drop.

**Answer**: *Pending*

### Q2: Pre-push gate behavior for branches that never had a PR
**Context**: FR-002 requires verifying "the PR is still open" before every push in `pr-feedback-handler.ts` and `pr-manager.ts` (`commitPushAndEnsurePr`). But `PrManager` creates the PR *after* the first push on a workflow's very first phase — during that first push, no PR yet exists to check. If the gate is naive ("no open PR ⇒ refuse") it will block every workflow's first push and produce a false-positive refusal on every fresh issue.

**Question**: How does the FR-002 PR-open check behave when no PR yet exists for the current branch?
**Options**:
- A: Skip the PR-open sub-check when `findPRForBranch(currentBranch)` returns null; the branch-existence sub-check still runs. First-push scenario is a legitimate "no PR yet" case (`PrManager.prNumber === undefined`).
- B: Refuse all pushes to branches without an open PR; force PR creation to happen before the first push (invert the current create-PR-after-first-push order).
- C: Skip both sub-checks when `PrManager.prNumber === undefined` in-process (i.e., the current worker session has never created a PR); once a PR has been created in-session, both sub-checks are mandatory for all subsequent pushes.

**Answer**: *Pending*

### Q3: Job disposition after push refusal
**Context**: FR-003 says the job "MUST exit without opening a new PR" and emit one `warn`-or-above log line. But the spec is silent on the issue-label state after the refusal. `agent:in-progress` is currently cleared via a shared `finally` block (per the #926 pattern in `pr-feedback-handler.ts`). Operators need to know whether a resurrection-refusal is visible on the issue afterward, or silent to everything except the log.

**Question**: After FR-002 refuses a push, what label state does the worker leave on the target issue?
**Options**:
- A: Clear `agent:in-progress` only; do not add `agent:error` or `failed:*`. Rationale: the issue is closed (in the observed case), so error labels on a closed issue create noise for operators who filter by open issues.
- B: Clear `agent:in-progress` AND add `agent:error` with a comment naming the refused push. Rationale: makes the refusal visible on the issue timeline for post-incident audit.
- C: Clear `agent:in-progress` AND add `failed:<phase>` where `<phase>` is the current phase. Rationale: aligns with existing `#849` re-arm mechanics — a subsequent `/cockpit:resume` can pick up if the closure was accidental.

**Answer**: *Pending*

### Q4: Structured log event name and fields for FR-003 refusal
**Context**: SC-002 asserts "every refusal emits exactly one `warn`-or-above line" but does not lock the event name or structured field shape. Downstream monitors (`packages/orchestrator/src/services/label-monitor-service.ts` telemetry patterns; potential future cluster.orchestrator relay events) benefit from a stable, greppable event name. Test assertions in the SC-002 unit test also need to key on exact field names.

**Question**: What structured log event name and field set should the refusal log line carry?
**Options**:
- A: `event: 'push-refused'` with fields `{ reason: 'pr-merged' | 'pr-closed' | 'branch-missing', prNumber, branch, owner, repo, issueNumber }`. Neutral name, reusable for other future push-refusal paths.
- B: `event: 'branch-resurrection-prevented'` with the same field set. Descriptive name that self-documents the intent.
- C: No dedicated event name; use `logger.warn({ prNumber, branch, reason }, 'Refusing to push to <reason> branch')`. Rationale: existing worker code (e.g., `label-monitor-service.ts:361`) uses inline warn strings without a dedicated `event:` field.

**Answer**: *Pending*

### Q5: Mid-phase re-check for the merge-during-run race
**Context**: The Comment posted 2026-07-27 identifies the race window as *gate-advance → worker-pickup → merge* — a merge can land while the worker is inside a phase run (checkout already done, phase step running, push not yet issued). FR-002 currently gates only "before `commitAndPushChanges`" — that is post-run, pre-push. If the merge lands during a long-running phase, the pre-push check catches it (good). If the phase is a no-op (`hasChanges: false`), no push happens, so no gate fires — the phase silently completes on a merged issue.

**Question**: Should FR-002's PR/branch existence check also run mid-phase (before or during phase step execution), or is pre-push-only sufficient?
**Options**:
- A: Pre-push only. Rationale: no push ⇒ no resurrection outcome. A no-op phase on a merged issue produces no branch mutation; the `agent:in-progress` label eventually clears via `finally` (#926). Cheapest, no new failure modes.
- B: Pre-push AND once at phase start (immediately after `switchBranch`). Rationale: catches the case where a phase does substantial work then fails before push — the worker still logs the refused-push warn and exits without wasted CLI cycles for the *next* phase in the loop.
- C: Pre-push AND before every commit within a phase (not just pre-push). Rationale: tightest window, but adds N GitHub API calls per phase (one per commit). Overkill for the observed repro.

**Answer**: *Pending*
