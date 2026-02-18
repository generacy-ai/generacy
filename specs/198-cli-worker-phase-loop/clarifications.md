# Clarifications: Claude CLI Worker with Phase Loop

## Batch 1 — 2026-02-18

### Q1: Single Phase vs Full Loop per Claim
**Context**: The `WorkerHandler` type returns `Promise<void>` for a single invocation, but the issue title says "phase loop". This fundamentally affects architecture — a single-phase handler is simpler and lets the dispatcher re-queue between phases, while a loop handler processes all phases in one claim.
**Question**: Does the worker execute ONE phase per queue claim (dispatcher re-enqueues for the next phase), or does it loop through ALL remaining phases in a single claim until hitting a gate or completion?
**Options**:
- A: Single phase per claim — worker runs one speckit command, completes, dispatcher re-enqueues for next phase
- B: Full loop per claim — worker loops through all phases until a `waiting-for:*` gate or workflow completion
- C: Configurable — support both modes via a config flag

**Answer**: **B — Full loop per claim.** The `WorkerDispatcher` calls `queue.complete()` on handler success, permanently removing the item from the queue. There is no re-enqueue-for-next-phase mechanism. The only re-enqueue path is via `LabelMonitorService` detecting a `completed:*` + `waiting-for:*` label pair (for `continue` commands). The worker loops through all remaining phases until hitting a `waiting-for:*` gate or workflow completion.

### Q2: Validate Phase Behavior
**Context**: FR-2 maps all phases to speckit slash commands except `validate`, which says "(no command — validation is manual or automated test)". The worker needs to know what to do when it reaches this phase.
**Question**: What should the worker do when it reaches the `validate` phase? Should it skip it and mark the workflow complete, run automated tests, or simply set the `waiting-for:manual-validation` label and exit?
**Options**:
- A: Set `waiting-for:manual-validation` label and exit — human validates manually
- B: Run a configurable test command (e.g., `pnpm test && pnpm build`) and auto-complete if passing
- C: Skip validate entirely — mark workflow complete after `implement`

**Answer**: **B — Run configurable test command, auto-complete if passing.** The label-protocol step 11 states "Agent runs verification → PR marked ready for review". Default: run `pnpm test && pnpm build` (or configured equivalent); if passing, mark `completed:validate` and PR ready for review. If tests fail, set `agent:error` with diagnostic output. `waiting-for:manual-validation` is available as a configurable option for workflows requiring human sign-off.

### Q3: Waiting-For Detection Mechanism
**Context**: FR-4 says the worker should stop when a `waiting-for:*` label is detected, but doesn't specify HOW the worker knows to add this label. The Claude CLI output doesn't inherently signal review gates. This needs a clear detection strategy.
**Question**: How does the worker determine that a `waiting-for:*` label should be applied? Is it based on the phase (e.g., always add `waiting-for:clarification` after `clarify` if questions were posted), based on Claude CLI output parsing, or based on a predefined gate configuration?
**Options**:
- A: Predefined phase-to-gate mapping (e.g., clarify → always check if questions pending, then set waiting-for:clarification)
- B: Parse Claude CLI output for a specific signal/marker indicating a gate was hit
- C: Configuration-driven — define which phases have review gates in orchestrator config

**Answer**: **C — Configuration-driven, with predefined defaults per workflow.** Gate mapping varies by workflow (e.g., `speckit-bugfix` skips clarification). Default gates for `speckit-feature`: clarify → `waiting-for:clarification` (always), validate → none (runs tests, only gates on failure). Optional review gates (`waiting-for:spec-review`, `waiting-for:plan-review`, etc.) can be enabled per workflow in config.

### Q4: Concurrent Workers on Same Repository
**Context**: FR-9 describes repository checkout at `{WORKSPACE_DIR}/{owner}/{repo}`, but the dispatcher supports multiple concurrent workers (default: 3). If two workers claim items for the same repo, they'd conflict on the same checkout directory.
**Question**: How should the worker handle concurrent access to the same repository? Should each worker get an isolated checkout, should there be a per-repo lock, or is concurrent same-repo processing not expected?
**Options**:
- A: Per-worker isolated checkout at `{WORKSPACE_DIR}/{workerId}/{owner}/{repo}` — each worker gets its own clone
- B: Per-repo mutex — only one worker per repo at a time, others wait or skip
- C: Assume different repos — concurrent same-repo processing is out of scope for MVP

**Answer**: **A — Per-worker isolated checkout** at `{WORKSPACE_DIR}/{workerId}/{owner}/{repo}`. Each worker gets its own clone to avoid race conditions with concurrent workers on the same repo. Cleanup on worker completion or via periodic pruner.

### Q5: Claude CLI Prompt Construction
**Context**: FR-3 says "the prompt should include the slash command" but the exact prompt template affects behavior significantly. The Claude CLI needs enough context to operate on the correct issue and branch, and may need MCP tool configuration for Agency tools.
**Question**: What should the full Claude CLI prompt template look like? Specifically: should it use `/autodev:start` or `/autodev:continue` (which handle labels/commits/PRs themselves), or directly invoke `/speckit:*` commands (requiring the worker to handle labels/commits)?
**Options**:
- A: Use `/autodev:start` or `/autodev:continue` — let the autodev workflow handle labels, commits, and PRs; worker just spawns and monitors
- B: Use raw `/speckit:*` commands — worker handles all label transitions, commits, and stage comments directly
- C: Use a new `/worker:execute` command designed specifically for orchestrator-driven execution

**Answer**: **B — Use raw `/speckit:*` commands, worker handles all label transitions.** Speckit commands do the AI work (generate artifacts, post comments) while the worker manages the state machine (labels, phase transitions, gates, stage comments). Worker invokes: `claude --headless --output json --print all --max-turns 100 --prompt "/speckit:specify <context>"`. After completion, worker inspects result and drives label transition. This avoids dual-control issues.
