# Research: per-phase effort + fixer parity (#1095)

## Decision 1 — Effort mechanism on installed Claude CLI (FR-006, SC-009)

**Answer**: The installed Claude Code CLI **v2.1.150** exposes a first-class flag `--effort <level>` whose vocabulary matches the spec's proposed enum **exactly**:

```
--effort <level>    Effort level for the current session (low, medium, high, xhigh, max)
```

Verified at planning time via `claude --help` (2026-08-14). This is FR-006 **branch (a)** — mechanism exists.

**Rationale**: The flag names, argument shape, and vocabulary are byte-identical to what Q2 answer A specified for the schema. No translation table, no vocabulary mapping, no env-var fallback needed. The claude-code launch plugin's `--effort` push is a direct mirror of the existing `--model` push (both take a single string argument).

**Alternatives considered**:
- Environment variable (e.g. `CLAUDE_EFFORT`) — not present in current CLI help output. Rejected.
- Settings file write (`~/.claude/settings.json` or `--settings <file-or-json>`) — the `--effort` flag exists as a direct alternative; settings-file wiring would be more complex and no more capable. Rejected.
- Version-adaptive probe at plugin boot (spawn `claude --help`, grep for `--effort`) — adds startup latency and would fail closed under a headless-CI environment where the CLI's help output could stall. Rejected. Instead: static `hasEffortMechanism()` const in the plugin, flipped by a plugin release when the CLI eventually removes the flag. See Decision 5.

**Consequences**:
- Plugin code: `if (intent.effort) args.push('--effort', intent.effort);` in each of the four builders (`buildPhaseLaunch`, `buildPrFeedbackLaunch`, `buildValidateFixLaunch`, `buildMergeConflictLaunch`).
- Under current CLI, FR-010a-a and FR-010a-b (warnings when mechanism absent) are dead code paths. Still shipped per spec Q3 rationale ("the CLI version can change on cluster restart independently of when validate last ran"). Test coverage stubs `hasEffortMechanism()` to `false` to exercise both warning surfaces.

**Source**: `/home/node/.local/bin/claude --help` at planning time.

---

## Decision 2 — Strict-mode scope (FR-011, SC-006, Q4)

**Answer**: Apply `.strict()` in **`packages/config/src/template-schema.ts`** to exactly three schemas: `AgentEntrySchema` (line 14), `WorkflowAgentEntriesSchema` (line 25), `AgentsConfigSchema` (line 54).

**Rationale**: The CLI schema (`packages/generacy/src/config/schema.ts:2-14`) re-exports these three schemas from `@generacy-ai/config`. Adding `.strict()` in one place stricts BOTH loaders (CLI-side `generacy validate` AND cluster-side `applyRepoAgentOverrides` in `packages/orchestrator/src/worker/config.ts`). Every other `z.object` in either schema retains its current default-strip mode, so no config that validates today becomes an error (Q4's "zero blast radius" invariant).

**Alternatives considered**:
- Apply `.strict()` at both `packages/generacy/src/config/schema.ts` (CLI-side) AND leave `packages/config` schemas strip-mode (cluster-side) — creates a mode split where `generacy validate` rejects a typo that `applyRepoAgentOverrides` silently strips. Rejected as inconsistent. Preferred: single source of truth.
- Apply `.strict()` to the entire CLI schema (Q4 option B) — explicitly rejected by clarification (breaks existing configs).
- Apply top-level `.strict()` only on `AgentsConfigSchema` (Q4 option C) — nested typos inside `phases.*` or entry-level (`efort`, `modle`) would still strip silently. Rejected as insufficient.

**Consequences**:
- Test fixture `invalid-agents-typo.yaml` (e.g. `defualt:` under `agents:`) → rejected by `generacy validate` AND by the orchestrator's config loader.
- Test fixture `valid-outside-block-typo.yaml` (typo at root or under `defaults:`) → still accepted (silently stripped) — asserted by SC-006 sibling test.

---

## Decision 3 — Shared resolution helper vs. per-handler inline call

**Answer**: Call `resolveAgentForPhase` directly from each of the three fixer handlers. **Do NOT extract a new shared helper.**

**Rationale**: `resolveAgentForPhase` (`packages/orchestrator/src/worker/config.ts:280-295`) is already the shared helper. It is a pure function taking `(config, workflowName, phase)` and returning `{ provider, model, effort? }` — everything a handler needs. Wrapping it in a per-handler helper would add indirection without simplifying anything. `pr-feedback-handler.ts:860` is one line; validate-fix and merge-conflict will each be one line too.

**Alternatives considered**:
- Extract a `resolveAgentForImplement(config, workflowName)` bound helper — trivially thin, adds a new export. Rejected: over-abstraction, one caller per handler.
- Extract a `HandlerContext.resolveAgent()` method — requires refactoring the handler-context object. Rejected: out-of-scope, no cross-cutting value.

**Consequences**: Three call sites (`pr-feedback-handler.ts:860`, `validate-fix-handler.ts` new call, `merge-conflict-handler.ts` new call) all invoke `resolveAgentForPhase(this.config, workflowName, 'implement')`. Grep-visible; easy to keep in sync.

---

## Decision 4 — `validate-fix-handler` workflowName plumbing

**Answer**: Extend the handler method signature (not the constructor) to accept `workflowName`, threaded from the phase-loop caller.

**Rationale**: The constructor at `validate-fix-handler.ts:56-62` currently takes `config, agentLauncher, phaseTracker, logger, emitEvent?`. Adding `workflowName` there would tie the handler to a single workflow at construction time, but a single orchestrator process may run jobs across `speckit-feature` and `speckit-bugfix` (both use the `implement` phase). The workflow is a **per-invocation** input, not a per-handler-instance one.

The phase-loop already has `item.workflowName` in scope when it invokes the validate-fix path (Explore-2 traces it via `ClaudeCliWorker.handle()`). Threading the string down one more level is the minimal change.

**Alternatives considered**:
- Read `workflowName` from a passed-through `WorkerContext` object — heavier refactor for one string field. Rejected as over-scoped.
- Default `workflowName` to `"unknown"` if unset — legal per Q1 (`resolveAgentForPhase("unknown", "implement")` degrades cleanly), but wastefully drops signal that the caller has. Rejected. Prefer explicit threading.

**Consequences**: `validate-fix-handler`'s public method (e.g. `runValidateFix`) gains a `workflowName: string` parameter. Callers already have this in `item.workflowName`. No shape change for internal state.

---

## Decision 5 — Plugin capability probe (FR-010a wiring)

**Answer**: Plugin exposes `static hasEffortMechanism(): boolean` (or a plain exported const `HAS_EFFORT_MECHANISM = true`). Under CLI v2.1.150 → `true`. A future plugin release flips it to `false` if the CLI removes the flag.

**Rationale**: Simple, synchronous, cheap. No spawn probe, no `--help` scrape at boot, no per-request check. The plugin owner (this repo) knows what CLI version their bundled `Dockerfile` installs; if that pin ever moves to a CLI without `--effort`, they flip the const. Both warning surfaces (validate-time in `packages/generacy/src/cli/commands/validate.ts`, spawn-time in the orchestrator worker) consult the same source.

**Alternatives considered**:
- Boot-time probe (spawn `claude --help`, grep for `--effort`) — adds latency, brittle in CI. Rejected.
- Version comparison against a hard-coded threshold — couples the plugin to CLI version semantics it doesn't own. Rejected.
- Skip the warnings entirely (defer to when the CLI actually removes the flag) — explicitly rejected by spec FR-010a and clarification Q3.

**Consequences**:
- The plugin's `hasEffortMechanism()` is a public API — bump `packages/generacy-plugin-claude-code` **minor**.
- The CLI validate command imports (or dependency-injects) a per-provider capability registry to consult `hasEffortMechanism()`. Simplest wiring today: dedicated small helper `packages/generacy/src/config/effort-mechanism-probe.ts` that imports the plugin's const. Grep-visible; easy to extend when a second provider is added.
- Under the current CLI, both warning paths are dead — the exact class of "wire it but don't fire it" the spec calls for.

---

## Decision 6 — Validate command warnings channel

**Answer**: Extend `loadConfig` (or add sibling `loadConfigWithWarnings`) to return `{ config, warnings: string[] }`. `generacy validate` prints warnings after `displayConfigSummary` in text mode, or in a `warnings: []` array field in JSON output. Exit code stays 0 on warnings-only.

**Rationale**: `packages/generacy/src/cli/commands/validate.ts` today has no warnings channel — the `displayConfigSummary` helper (lines 58-104) prints only positive info; errors are printed by `formatValidationErrors` (lines 24-53). Adding a warnings channel is a small, focused change with no external API break (loadConfig's existing shape is preserved as a delegating wrapper if needed for backward compat).

**Alternatives considered**:
- Log warnings via the shared pino logger instead of stdout — inconsistent with validate's existing UX (config summary goes to stdout via `logger.info`). Rejected.
- Return a separate `WarningsError` sentinel — overloads the error path with non-error semantics. Rejected.
- Add warnings as a schema-level side effect via a `.refine()` on `AgentEntrySchema` — Zod refinements can only emit errors, not warnings. Rejected on technical grounds.

**Consequences**:
- `loadConfig` return type widens. Existing callers that only need `config` continue to work if the loader still exports a config-only shape. Alternative: introduce `loadConfigWithWarnings` alongside; keep `loadConfig` unchanged (recommended for backward compat).
- New warning message format: `"orchestrator.agents...effort — set to '${value}' but provider '${provider}' has no CLI mechanism for effort in this release. The field will be dropped at spawn time."`
- JSON output gains `warnings: string[]` field.

---

## Decision 7 — Test fixture strategy

**Answer**: Four new YAML fixtures under `packages/generacy/src/config/__tests__/fixtures/`:

1. `valid-with-agents-effort.yaml` — SC-002 shape (fable/xhigh for plan, opus/high for implement). Positive test.
2. `invalid-effort-enum.yaml` — `effort: super` — SC-005 rejection test.
3. `invalid-agents-typo.yaml` — `defualt:` under `agents:` (or `efort:` inside a phase entry) — SC-006 rejection test.
4. `valid-outside-block-typo.yaml` — typo at root or under `defaults:` — SC-006 sibling acceptance test (proves zero blast radius outside the block).

Existing fixtures (`valid-full.yaml`, `valid-with-orchestrator.yaml`) require **no change** — they don't declare an `agents` block.

**Rationale**: Fixture-driven tests match the existing pattern in `packages/generacy/src/config/__tests__/loader.test.ts`. Each fixture is a minimal, readable YAML snippet that exercises exactly one behavior. Grep-visible.

---

## Decision 8 — Snapshot (golden-file) strategy for SC-004

**Answer**: Use Vitest inline snapshots in `packages/generacy-plugin-claude-code/src/launch/__tests__/claude-code-launch-plugin.test.ts` — one `toMatchInlineSnapshot()` per intent kind (phase, pr-feedback, validate-fix, merge-conflict) with `model`/`effort` unset. The snapshot captures the full `LaunchSpec.args` array.

**Rationale**: Inline snapshots ship the expected argv in the test source, so a byte-diff is grep-visible in `git diff` if a future change accidentally injects `--effort` or `--model` when unset. External snapshot files hide the expected values behind a filename — worse for review of a byte-identical claim.

**Alternatives considered**:
- External snapshot files under `__snapshots__/` — harder to review, easier to auto-update accidentally. Rejected.
- Explicit `expect(args).toEqual([...])` with hand-listed values — no worse than inline snapshots, more verbose. Acceptable fallback.

---

## Sources & References

- `packages/config/src/template-schema.ts` — `AgentEntrySchema` (line 14), `WorkflowAgentEntriesSchema` (line 25), `AgentsConfigSchema` (line 54)
- `packages/orchestrator/src/worker/config.ts` — `mergeAgentEntry` (lines 165-179), `mergeAgentsConfig` (lines 189-243), `applyRepoAgentOverrides` (lines 254-263), `resolveAgentForPhase` (lines 280-295)
- `packages/orchestrator/src/worker/pr-feedback-handler.ts:860` — reference implementation for `resolveAgentForPhase` call
- `packages/orchestrator/src/launcher/types.ts` — `PhaseIntent` (line 31), `PrFeedbackIntent` (line 46), `ValidateFixIntent` (line 61), `MergeConflictIntent` (line 75)
- `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts` — `buildPhaseLaunch` (line 80), `buildPrFeedbackLaunch` (line 106), `buildValidateFixLaunch` (line 127), `buildMergeConflictLaunch` (line 146)
- `packages/generacy/src/cli/commands/validate.ts` — validate handler (line 109), `formatValidationErrors` (line 24), `displayConfigSummary` (line 58)
- `packages/generacy/src/config/schema.ts:2-14` — re-export of `AgentsConfigSchema` from `@generacy-ai/config`
- `claude --help` (v2.1.150, invoked at planning time) — `--effort <level>` flag spec
- Spec `specs/1095-context-per-phase-agent/spec.md` — clarifications Q1–Q4
