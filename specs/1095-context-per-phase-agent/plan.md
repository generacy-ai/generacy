# Implementation Plan: Per-phase agent effort configuration and fixer model/effort parity

**Feature**: Add optional `effort` to `AgentEntrySchema`, plumb `{model, effort}` through the two fixer paths that ignore agent config today (`validate-fix-handler`, `merge-conflict-handler`), and wire the `agents` block through `generacy validate` + user docs.
**Branch**: `1095-context-per-phase-agent`
**Status**: Complete

## Summary

Three tightly-scoped, additive changes closing three named gaps in the existing per-phase agent selector (#814/#815):

1. **Schema**: add optional `effort: low | medium | high | xhigh | max` to `AgentEntrySchema` (`packages/config/src/template-schema.ts`). Resolves via the same independent-field precedence chain as `model` in `resolveAgentForPhase`.
2. **Fixer parity**: `validate-fix-handler` and `merge-conflict-handler` gain `resolveAgentForPhase(config, workflowName, 'implement')` calls matching `pr-feedback-handler`'s reference implementation. Their intents (`ValidateFixIntent`, `MergeConflictIntent`) gain `provider`/`model`/`effort` fields. The claude-code launch plugin's `buildValidateFixLaunch` and `buildMergeConflictLaunch` builders gain the same `--model` + `--effort` argv branches as `buildPhaseLaunch`/`buildPrFeedbackLaunch`.
3. **Effort mechanism**: verified against installed `claude` CLI **v2.1.150** — `--effort <level>` is a first-class flag whose vocabulary (`low, medium, high, xhigh, max`) matches the spec's enum **verbatim**. FR-006 branch (a): mechanism exists; no env-var or settings-write path needed. Plugin appends `--effort ${intent.effort}` conditionally, alongside `--model`.

Behavior-preserving: any repo with no `agents` block, or with `agents` set but `effort` unset, produces byte-identical argv + env across all four spawn paths (SC-004).

## Technical Context

**Languages / frameworks**: TypeScript (ESM, Node ≥22), Zod for schema validation, Vitest for tests.

**Affected packages**:
- `packages/config` — `AgentEntrySchema` + strict-mode extension (minor bump).
- `packages/orchestrator` — `resolveAgentForPhase` extension, `CliSpawnOptions` widening, intent-type widening, two fixer-handler edits (patch bump).
- `packages/generacy-plugin-claude-code` — `--effort` argv path in 4 builders + `hasEffortMechanism()` capability probe (minor bump).
- `packages/generacy` — CLI schema re-export test coverage + docs + example config + validate-command warnings channel (minor bump).

**No new dependencies**. Zod already a direct dep of every affected package. `claude --effort` is stock CLI, no npm-side install required.

**Non-affected surfaces** (out of scope, load-bearing invariants):
- `pr-feedback-handler` resolution logic — reference implementation, do NOT modify.
- `resolveAgentForPhase` provider tier walk — unchanged; `effort` is added as a **fourth** independent field walk (provider, model, effort — each independent).
- `.generacy/config.yaml` runtime semantics for any field outside the `agents` block.
- Every other object in `packages/generacy/src/config/schema.ts` — stays strip-mode `z.object` (FR-011 / Q4).

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo. Skipping the formal constitution check. The change adheres to house rules recorded in `/workspaces/generacy/CLAUDE.md`:

- **Changeset gate**: PR modifies `packages/*/src/` non-test files; a newly-added `.changeset/1095-context-per-phase-agent.md` is required. Bump levels below.
- **Bump levels** (per CLAUDE.md's changeset rules): `@generacy-ai/config` **minor** (new optional field on public schema), `@generacy-ai/orchestrator` **patch** (internal field plumbing, no new exports), `@generacy-ai/generacy-plugin-claude-code` **minor** (new spawn flag + `hasEffortMechanism()` public API), `@generacy-ai/generacy` **minor** (docs + example + validate warnings channel).
- **Test-only exemption**: not applicable — production code changes ship in every affected package.
- **No new label vocabulary in `workflow-engine`** — no `workflow-engine` change, so the "new label vocabulary → minor" rule doesn't apply.

## Project Structure — files touched

```
packages/config/src/
  template-schema.ts               # + effort field on AgentEntrySchema
                                   # + .strict() on AgentEntrySchema,
                                   #   WorkflowAgentEntriesSchema, AgentsConfigSchema
                                   #   (D-2: applies to both CLI-side and cluster-side loaders
                                   #    because CLI schema re-exports these three)

packages/orchestrator/src/
  worker/config.ts                 # extend mergeAgentEntry (field-by-field effort merge)
                                   # extend resolveAgentForPhase return type + walk
  worker/types.ts                  # + effort? on CliSpawnOptions
  worker/phase-loop.ts             # unpack + thread effort → CliSpawnOptions
  worker/pr-feedback-handler.ts    # unpack + thread effort → PrFeedbackIntent
  worker/validate-fix-handler.ts   # + resolveAgentForPhase call + thread {provider,model,effort}
                                   # (D-3a: plumb workflowName from caller signature)
  worker/merge-conflict-handler.ts # + resolveAgentForPhase call + thread {provider,model,effort}
                                   # (D-3b: item.workflowName already available)
  worker/cli-spawner.ts            # forward effort into PhaseIntent
  launcher/types.ts                # + provider?, model?, effort? on ValidateFixIntent
                                   #   & MergeConflictIntent
                                   # + effort? on PhaseIntent & PrFeedbackIntent

packages/generacy-plugin-claude-code/src/launch/
  claude-code-launch-plugin.ts     # + --effort push in 4 builders
                                   # + static hasEffortMechanism(): boolean

packages/generacy/src/
  config/schema.ts                 # no code change — re-exports newly-strict schemas from
                                   # @generacy-ai/config; effort field flows through transparently
  cli/commands/validate.ts         # + warnings channel: print warnings after success
                                   #   (currently only errors surface)
  config/loader.ts                 # + warning-collection wrapper around validateConfig
                                   #   (probes plugin.hasEffortMechanism() when effort is set)

packages/generacy/examples/
  config-full.yaml                 # + effort field on the existing agents block example

docs/docs/getting-started/
  configuration.md                 # + new "Orchestrator Agent Selection" subsection
                                   #   after line 107 (before ## .generacy/generacy.env)

.changeset/
  1095-context-per-phase-agent.md  # new file; 4 package bumps (see Bump levels above)

# Test files
packages/config/tests/                                              # NEW dir if not present
  template-schema.test.ts                                           # + effort field acceptance/rejection
                                                                    # + strict-mode rejection tests
packages/orchestrator/src/worker/__tests__/
  resolve-agent-for-phase.test.ts                                   # + SC-002 test: fable/xhigh + opus/high
  validate-fix-handler.test.ts                                      # + SC-003: intent carries model/effort
  merge-conflict-handler.test.ts                                    # + SC-003: intent carries model/effort
packages/generacy-plugin-claude-code/src/launch/__tests__/
  claude-code-launch-plugin.test.ts                                 # + SC-004 argv snapshots for 4 kinds
                                                                    # + --effort append tests for 4 kinds
packages/generacy/src/config/__tests__/
  loader.test.ts                                                    # + SC-005 (effort: super rejection)
                                                                    # + SC-006 in/out-of-block typo tests
  __tests__/fixtures/                                               # + valid-with-agents-effort.yaml
                                                                    # + invalid-effort-enum.yaml
                                                                    # + invalid-agents-typo.yaml
                                                                    # + valid-outside-block-typo.yaml
packages/generacy/src/cli/__tests__/
  validate.test.ts                                                  # + SC-005a warnings-channel assertion
```

## Key Technical Decisions (see research.md for full detail)

- **D-1 (FR-006 answer)**: `claude` CLI v2.1.150 exposes `--effort <level>` with vocabulary `low, medium, high, xhigh, max` — exact match to the spec's enum. Plugin appends `--effort ${intent.effort}` conditionally. No env var, no settings write. Verified via `claude --help` at planning time.
- **D-2 (strict-mode wiring)**: Q4 answer A ("apply `.strict()` only to the `orchestrator.agents` sub-tree") satisfied by adding `.strict()` in three places in `packages/config/src/template-schema.ts` — `AgentEntrySchema`, `WorkflowAgentEntriesSchema`, `AgentsConfigSchema`. The CLI schema re-exports these three, so a single edit stricts both `generacy validate` AND the cluster-side `applyRepoAgentOverrides` loader. Zero blast radius outside the block (every other `z.object` in either schema stays default-strip).
- **D-3 (fixer parity plumbing)**: `pr-feedback-handler` calls `resolveAgentForPhase(config, workflowName, 'implement')` at `worker/pr-feedback-handler.ts:860`. `merge-conflict-handler` already receives `item.workflowName` (Explore-2 confirmed) — mirror inline. `validate-fix-handler` does NOT receive `workflowName` today (constructor at `worker/validate-fix-handler.ts:56-62` only takes `config`, `agentLauncher`, `phaseTracker`, `logger`, `emitEvent?`) — extend the handler method signature (not constructor) to accept `workflowName`, threaded from the phase-loop caller. Q1 fallback: `workflowName === "unknown"` naturally degrades through `agents.default` tiers to CLI ambient default.
- **D-4 (intent widening)**: Add `provider?`, `model?`, `effort?` to `ValidateFixIntent` + `MergeConflictIntent` (matching `PrFeedbackIntent`). Add `effort?` to `PhaseIntent` + `PrFeedbackIntent`. `ConversationTurnIntent` and `InvokeIntent` deliberately untouched — out of scope for this issue.
- **D-5 (FR-010a warnings)**: Plugin exposes public static `hasEffortMechanism(): boolean` (returns `true` under CLI v2.1.150; would flip to `false` if a future release removes the flag). Both validate-time and spawn-time warning paths consult this method. Under current CLI both warning branches are dead code (mechanism exists) — this is expected and required per Q3, since CLI version can change on cluster restart independently of when validate last ran.
- **D-6 (validate warnings channel)**: `generacy validate` today prints only errors (`packages/generacy/src/cli/commands/validate.ts:189-193`). Extend `loadConfig`'s return to a `{ config, warnings }` shape (or a sibling helper `loadConfigWithWarnings`). Warnings surface in text output after `displayConfigSummary` (or in the `warnings: []` field of JSON output). Exit code stays 0 on warnings-only; only errors exit 1.
- **D-7 (byte-identical baseline)**: SC-004 is the ship gate. Enforce via golden argv snapshots in `packages/generacy-plugin-claude-code/src/launch/__tests__/claude-code-launch-plugin.test.ts` — one snapshot per intent kind (phase, pr-feedback, validate-fix, merge-conflict) with `model`/`effort` unset. Byte-for-byte diff against pre-change captures required for merge.

## Suggested Next Step

Run `/speckit:tasks` to generate the ordered task list from this plan + spec.md.
