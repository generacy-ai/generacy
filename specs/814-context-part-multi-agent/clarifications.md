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

**Answer**: B — Bind `pr-feedback` to the `implement` phase's resolved `{ provider, model }` (the pr-feedback call site resolves with `phase='implement'`).

**Rationale**: PR feedback revises the code `implement` produced — the agent/model a user configured to write the code is the one they'd expect to address review comments on it, so B matches intent with zero new config surface. A pseudo-phase key (A) pokes a hole in the phase concept (pr-feedback isn't in sequences or timeout overrides, and conflicts with a closed phase-key set — see Q5); C makes a strong implement model silently not apply to its own PR fixes; a dedicated slot (D) can still be layered later as an override with B as its absent-case fallback.

### Q2: Session drop on model change (same provider)
**Context**: FR-011 says drop `sessionId` when the resolved **provider** changes between phases. Same-provider transitions preserve the session id. But same-provider **model** changes (e.g., `specify` on `claude-opus-4-7` → `implement` on `claude-sonnet-4-6`) are the primary user story of this issue (US1). Claude Code session-resume semantics are not obviously safe across model changes within the Claude provider (a session started under Opus may not resume cleanly under Sonnet). The spec does not state which behavior wins.
**Question**: When only the **model** changes between phases (provider unchanged), what should happen to the stored `sessionId`?
**Options**:
- A: Preserve the `sessionId` (only provider changes drop it — literal reading of FR-011). Trust Claude Code to handle in-session model switches.
- B: Drop the `sessionId` on any change to `{ provider, model }` (either dimension). Symmetric with the provider-switch rule; safest against undefined resume behavior.
- C: Preserve `sessionId` on model change but log a warning surfaced in the spawn log for observability.

**Answer**: C — Preserve the `sessionId` on model-only changes (provider unchanged), and log the model transition in the spawn log for observability.

**Rationale**: Claude Code sessions are transcript-based, not model-bound — `--model` is a per-invocation parameter and resuming under a different model is supported (the same mechanism as switching models mid-conversation). Dropping the session (B) would gratuitously discard in-session context for exactly this feature's headline use case (US1) and change today's cross-phase continuity beyond what the feature requires; the log line costs one string and makes model transitions attributable if a provider ever exhibits resume quirks.

### Q3: Partial env-var configuration
**Context**: FR-006 introduces `WORKER_AGENT_PROVIDER` and `WORKER_AGENT_MODEL` as independent env vars. FR-008 says provider and model resolve independently across tiers. But it's unclear how a partially-set env-var pair behaves: e.g., operator sets `WORKER_AGENT_MODEL=claude-opus-4-7` but leaves `WORKER_AGENT_PROVIDER` unset. Under strict independent resolution, model resolves to `claude-opus-4-7` and provider falls through to the built-in `claude-code` — which happens to be correct for Claude models but would silently misroute an Opus id if the built-in default were later changed to another provider.
**Question**: Should the env-var tier require both `WORKER_AGENT_PROVIDER` and `WORKER_AGENT_MODEL` to be set together, or resolve them independently at the env-var tier?
**Options**:
- A: Independent — `WORKER_AGENT_MODEL` alone applies at the env tier; `WORKER_AGENT_PROVIDER` alone applies at the env tier. Matches FR-008 uniformly for all tiers.
- B: Paired at env tier only — if only one is set, config-load fails with a clear Zod-style error. Higher-tier YAML entries may still set them independently.
- C: `WORKER_AGENT_MODEL` alone applies but is scoped to the resolved provider from the next tier up (repo `defaults.agent` → built-in `claude-code`); `WORKER_AGENT_PROVIDER` alone applies with no model (falls back to provider default).

**Answer**: A — Independent; `WORKER_AGENT_MODEL` alone applies at the env tier, and `WORKER_AGENT_PROVIDER` alone applies at the env tier, uniform with FR-008.

**Rationale**: FR-008's independent resolution exists precisely so "set only the model" works, and that's the most common cluster-admin move ("run everything on one model") — pairing (B) would fail it at config load. The misroute concern isn't env-specific: FR-001 makes both fields optional at every tier, so special-casing env buys no safety, and changing the built-in default provider would be a reviewed breaking change on its own. C reintroduces the cross-tier coupling FR-007's precedence chain deliberately avoids.

### Q4: Model ID validation scope
**Context**: SC-005 covers "Invalid `agents` YAML (e.g., non-string `model`) produces a Zod validation error." FR-012 covers unknown **providers**. Neither covers unknown **model** IDs: e.g., `phases.specify.model: claude-opus-99` (typo, non-existent id) or `phases.specify.model: gpt-4o` (mismatched provider — GPT model under `claude-code`). The Assumptions section notes "no translation layer needed" for `--model`, implying model IDs are passed through opaquely. Impact: config-time typos surface as runtime Claude Code errors on the target phase rather than at config load.
**Question**: Should model IDs be validated beyond "must be a string," or passed through opaquely to the provider plugin?
**Options**:
- A: Opaque pass-through — accept any non-empty string. No allowlist. Model errors surface at spawn time via the existing stage-comment error path. (Matches the Assumptions section.)
- B: Provider-plugin-scoped validation — each provider plugin exposes a `validateModel(id): boolean`; `resolveAgentForPhase` invokes it at config-load and fails Zod-style on unknown ids for that provider.
- C: Opaque pass-through, but require kebab-case format (loose sanity check) to catch obvious typos like empty strings or whitespace.

**Answer**: A — Opaque pass-through; accept any non-empty string, with model errors surfacing at spawn time via the existing stage-comment error path.

**Rationale**: Model catalogs change faster than releases and are effectively unbounded for OpenCode (`provider/model` ids), so a per-plugin allowlist (B) is unmaintainable and rejects valid new models the day they ship. A kebab-case check (C) false-positives on real ids — OpenCode ids contain `/` (`anthropic/claude-…`) and several ids contain dots. Zod's non-empty-string guard (SC-005) plus the FR-012 spawn-time error path already catch what's catchable without maintaining a catalog.

### Q5: Custom workflow phase keys
**Context**: FR-001 defines `workflows.<name>.phases.<phase>` where `<phase>` is a per-workflow phase name. The default workflows (`speckit-feature`, `speckit-bugfix`, `speckit-epic`) use the fixed `WorkflowPhase` enum (`specify`, `clarify`, `plan`, `tasks`, `implement`, `validate`). `PhaseTimeoutOverridesSchema` (the structural template per FR-004) is closed over the enum. But workflows in principle can define their own phase names (e.g., a marketplace workflow with `research`/`draft`). The spec doesn't say whether `phases.<phase>` is restricted to the built-in enum or open-set.
**Question**: Should the `agents.workflows.<name>.phases` keys be restricted to the built-in `WorkflowPhase` enum, or accept arbitrary phase names?
**Options**:
- A: Closed set — Zod restricts phase keys to the `WorkflowPhase` enum. Typos are caught at config load. Custom-workflow phases can be added later when custom workflows themselves are supported.
- B: Open set — `phases` is `z.record(z.string(), AgentEntry)`. Unknown phase names are accepted and simply never match at resolve time. Forward-compatible with custom workflows.
- C: Closed set for `speckit-*` workflow names; open set for other workflow names. Best of both, more schema complexity.

**Answer**: A — Closed set; Zod restricts `agents.workflows.<name>.phases` keys to the `WorkflowPhase` enum, matching `PhaseTimeoutOverridesSchema`.

**Rationale**: The open record's failure mode (B) is the worst kind — a typoed key like `implment` validates cleanly and is silently ignored, contradicting the fail-loudly ethos SC-005 and FR-012 establish. Custom workflow phases don't exist in the phase loop today (sequences are hardcoded to the speckit workflows), so the open set buys nothing now; widening a Zod enum later is non-breaking, narrowing isn't. C is schema complexity for the same nonexistent feature.
