# Clarifications — #814 Multi-agent phase 1b

## Batch 1 — 2026-07-13

### Q1: pr-feedback resolution
**Context**: FR-010 says `ClaudeCodeLaunchPlugin` pushes `--model <model>` on `phase` **and `pr-feedback`** intents, but `pr-feedback` is not a `WorkflowPhase` — it's a separate intent kind triggered by comment/review events (see `packages/orchestrator/src/worker/pr-feedback-handler.ts`). The spec's resolver signature `resolveAgentForPhase(config, workflowName, phase)` has no obvious way to name pr-feedback in the precedence chain. Without a rule, pr-feedback either silently uses the built-in default or requires a new config key.
**Question**: How should `resolveAgentForPhase` resolve `{ provider, model }` for `pr-feedback` intents?
**Options**:
- A: Treat `pr-feedback` as a pseudo-phase — allow `workflows.<name>.phases.pr-feedback` alongside the real workflow phases; fall through the normal chain otherwise.
- B: Bind `pr-feedback` to the `implement` phase's resolved `{ provider, model }` (rationale: pr-feedback reviews changes produced by `implement`).
- C: Bind `pr-feedback` only to `workflows.<name>.default` and `agents.default`/env/built-in — no per-phase override for pr-feedback.
- D: Add a separate top-level `orchestrator.agents.prFeedback: { provider?, model? }` slot with its own precedence.

**Answer**: *Pending*

### Q2: Session drop on model change (same provider)
**Context**: FR-011 says drop `sessionId` when the resolved **provider** changes between phases. Same-provider transitions preserve the session id. But same-provider **model** changes (e.g., `specify` on `claude-opus-4-7` → `implement` on `claude-sonnet-4-6`) are the primary user story of this issue (US1). Claude Code session-resume semantics are not obviously safe across model changes within the Claude provider (a session started under Opus may not resume cleanly under Sonnet). The spec does not state which behavior wins.
**Question**: When only the **model** changes between phases (provider unchanged), what should happen to the stored `sessionId`?
**Options**:
- A: Preserve the `sessionId` (only provider changes drop it — literal reading of FR-011). Trust Claude Code to handle in-session model switches.
- B: Drop the `sessionId` on any change to `{ provider, model }` (either dimension). Symmetric with the provider-switch rule; safest against undefined resume behavior.
- C: Preserve `sessionId` on model change but log a warning surfaced in the spawn log for observability.

**Answer**: *Pending*

### Q3: Partial env-var configuration
**Context**: FR-006 introduces `WORKER_AGENT_PROVIDER` and `WORKER_AGENT_MODEL` as independent env vars. FR-008 says provider and model resolve independently across tiers. But it's unclear how a partially-set env-var pair behaves: e.g., operator sets `WORKER_AGENT_MODEL=claude-opus-4-7` but leaves `WORKER_AGENT_PROVIDER` unset. Under strict independent resolution, model resolves to `claude-opus-4-7` and provider falls through to the built-in `claude-code` — which happens to be correct for Claude models but would silently misroute an Opus id if the built-in default were later changed to another provider.
**Question**: Should the env-var tier require both `WORKER_AGENT_PROVIDER` and `WORKER_AGENT_MODEL` to be set together, or resolve them independently at the env-var tier?
**Options**:
- A: Independent — `WORKER_AGENT_MODEL` alone applies at the env tier; `WORKER_AGENT_PROVIDER` alone applies at the env tier. Matches FR-008 uniformly for all tiers.
- B: Paired at env tier only — if only one is set, config-load fails with a clear Zod-style error. Higher-tier YAML entries may still set them independently.
- C: `WORKER_AGENT_MODEL` alone applies but is scoped to the resolved provider from the next tier up (repo `defaults.agent` → built-in `claude-code`); `WORKER_AGENT_PROVIDER` alone applies with no model (falls back to provider default).

**Answer**: *Pending*

### Q4: Model ID validation scope
**Context**: SC-005 covers "Invalid `agents` YAML (e.g., non-string `model`) produces a Zod validation error." FR-012 covers unknown **providers**. Neither covers unknown **model** IDs: e.g., `phases.specify.model: claude-opus-99` (typo, non-existent id) or `phases.specify.model: gpt-4o` (mismatched provider — GPT model under `claude-code`). The Assumptions section notes "no translation layer needed" for `--model`, implying model IDs are passed through opaquely. Impact: config-time typos surface as runtime Claude Code errors on the target phase rather than at config load.
**Question**: Should model IDs be validated beyond "must be a string," or passed through opaquely to the provider plugin?
**Options**:
- A: Opaque pass-through — accept any non-empty string. No allowlist. Model errors surface at spawn time via the existing stage-comment error path. (Matches the Assumptions section.)
- B: Provider-plugin-scoped validation — each provider plugin exposes a `validateModel(id): boolean`; `resolveAgentForPhase` invokes it at config-load and fails Zod-style on unknown ids for that provider.
- C: Opaque pass-through, but require kebab-case format (loose sanity check) to catch obvious typos like empty strings or whitespace.

**Answer**: *Pending*

### Q5: Custom workflow phase keys
**Context**: FR-001 defines `workflows.<name>.phases.<phase>` where `<phase>` is a per-workflow phase name. The default workflows (`speckit-feature`, `speckit-bugfix`, `speckit-epic`) use the fixed `WorkflowPhase` enum (`specify`, `clarify`, `plan`, `tasks`, `implement`, `validate`). `PhaseTimeoutOverridesSchema` (the structural template per FR-004) is closed over the enum. But workflows in principle can define their own phase names (e.g., a marketplace workflow with `research`/`draft`). The spec doesn't say whether `phases.<phase>` is restricted to the built-in enum or open-set.
**Question**: Should the `agents.workflows.<name>.phases` keys be restricted to the built-in `WorkflowPhase` enum, or accept arbitrary phase names?
**Options**:
- A: Closed set — Zod restricts phase keys to the `WorkflowPhase` enum. Typos are caught at config load. Custom-workflow phases can be added later when custom workflows themselves are supported.
- B: Open set — `phases` is `z.record(z.string(), AgentEntry)`. Unknown phase names are accepted and simply never match at resolve time. Forward-compatible with custom workflows.
- C: Closed set for `speckit-*` workflow names; open set for other workflow names. Best of both, more schema complexity.

**Answer**: *Pending*
