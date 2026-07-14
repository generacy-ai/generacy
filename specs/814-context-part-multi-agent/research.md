# Research: Config Surface + Per-Phase Model Threading

Each section links a design question to the clarification that resolved it (see `clarifications.md`).

## D-1: Where the `agents` schema lives (source of truth)

**Decision**: `OrchestratorSettingsSchema.agents` in `packages/config/src/template-schema.ts`. This is the block loaded from the target repo's `.generacy/config.yaml` by the orchestrator (via `tryLoadOrchestratorSettings`). `packages/generacy/src/config/schema.ts` gets a **mirror** for the CLI-facing validation surface — same shape, same Zod primitives.

**Rationale**:
- The `orchestrator` block already flows from target repo → worker via `applyRepoValidateOverrides` (`packages/orchestrator/src/worker/config.ts:106`). Piggy-backing on that path keeps the merge story linear.
- The CLI-facing schema (`packages/generacy`) validates the same file for `generacy init` / templating flows and needs the same field to accept it. Two schemas, one shape — not two independent shapes.
- Placing the schema in `packages/orchestrator-types` was ruled out in #813 D-8: that package is subset-by-design.

**Alternatives considered**:
- Single schema in `packages/generacy` only — rejected: orchestrator would then need to import from `packages/generacy` (CLI package), inverting the dependency direction.
- Single schema in `packages/orchestrator/src/worker/config.ts` — rejected: repo-facing config validation lives in `packages/config`; skipping it means `generacy init` can't validate `agents`.

## D-2: Schema shape — `AgentEntry` + `AgentsConfigSchema`

**Decision**:

```ts
const AgentEntrySchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

const WorkflowAgentEntriesSchema = z.object({
  default: AgentEntrySchema.optional(),
  phases: z
    .object({
      specify: AgentEntrySchema.optional(),
      clarify: AgentEntrySchema.optional(),
      plan: AgentEntrySchema.optional(),
      tasks: AgentEntrySchema.optional(),
      implement: AgentEntrySchema.optional(),
      validate: AgentEntrySchema.optional(),
    })
    .optional(),
});

const AgentsConfigSchema = z.object({
  default: AgentEntrySchema.optional(),
  workflows: z.record(z.string(), WorkflowAgentEntriesSchema).optional(),
});
```

**Rationale**:
- Both `provider` and `model` are `.optional()` on `AgentEntrySchema` — matches FR-008's independent resolution (Q3→A). Neither implies the other.
- `phases` fields are **enumerated per-field** rather than `z.record(WorkflowPhase, …)` because `PhaseTimeoutOverridesSchema` set the precedent — enumerating per-field is what makes "partial phase overrides don't drop sibling defaults" work if we later add defaults. And Q5→A demands a closed set: typoed keys like `implment` fail Zod validation instead of validating cleanly and being silently ignored.
- `validate` is included in the enum (unlike `PhaseTimeoutOverridesSchema` which excludes it) — the validate phase runs a shell command, not a CLI phase, so a `phases.validate.model` value would never apply. But the closed enum is the `WorkflowPhase` set; including `validate` and having it be a no-op is less surprising than a partial enum. Documented in `quickstart.md`.
- `workflows` remains `z.record(z.string(), …)` because workflow **names** (`speckit-feature`, `speckit-bugfix`, `speckit-epic`) are extensible and not enumerable at config-load time — only the **phase keys** within a workflow are enumerable.

**Alternatives considered**:
- `z.record(WorkflowPhase, AgentEntry)` for `phases` — rejected: doesn't match the `PhaseTimeoutOverridesSchema` structural precedent, and Zod's `z.record` with a `z.enum` key does not reject *unknown* keys strictly (values pass through unchecked at some Zod versions). Enumerating per-field is unambiguous.
- Open set for `phases` — rejected explicitly by Q5→A. The silent-typo failure mode is the worst kind.

**Reference**: Q5 answer A, Q1/Q3 (independent provider/model).

## D-3: Merge helper — extend `applyRepoValidateOverrides` or add a sibling?

**Decision**: Add a sibling `applyRepoAgentOverrides(config: WorkerConfig, settings: OrchestratorSettings | null | undefined): WorkerConfig`. Do **not** stuff the merge inside `applyRepoValidateOverrides`.

**Rationale**:
- `applyRepoValidateOverrides` has two-field scope (`validateCommand`, `preValidateCommand`) and returns the original config unchanged for cheap reference-equality "no override" detection. Widening it to an N-field merge would obscure that.
- A named sibling keeps the merge story greppable — `applyRepo*Overrides` is the pattern.
- Call site in `claude-cli-worker.ts:479` becomes: `const effectiveConfig = applyRepoAgentOverrides(applyRepoValidateOverrides(this.config, orchSettings), orchSettings)`. Both merges pure-function, order-independent.

**Rejected alternative**: A single `applyRepoOverrides` that handles all repo-overridable fields. That's a bigger refactor for no gain here.

## D-4: Env-var tier — precedence and independence

**Decision**: `WORKER_AGENT_PROVIDER` and `WORKER_AGENT_MODEL` set the **cluster default** (bottom-except-built-in tier of the precedence chain). Each resolves independently — neither implies the other (Q3→A).

Loader wiring in `packages/orchestrator/src/config/loader.ts` around line 245 (right after credential-role env plumbing):

```ts
const agentProvider = process.env['WORKER_AGENT_PROVIDER'] ?? process.env[`${ENV_PREFIX}WORKER_AGENT_PROVIDER`];
const agentModel = process.env['WORKER_AGENT_MODEL'] ?? process.env[`${ENV_PREFIX}WORKER_AGENT_MODEL`];
if (agentProvider || agentModel) {
  if (!config.worker) config.worker = {};
  const worker = config.worker as Record<string, unknown>;
  if (!worker.agents) worker.agents = {};
  const agents = worker.agents as Record<string, unknown>;
  if (!agents.default) agents.default = {};
  const def = agents.default as Record<string, unknown>;
  if (agentProvider) def.provider = agentProvider;
  if (agentModel) def.model = agentModel;
}
```

**Rationale**:
- Matches every other `WORKER_*` env var in this file (workspace dir, phase timeouts, credential role).
- Independent write — no paired-value guard, matches Q3→A ("either may be set alone").
- Written into `config.worker.agents.default` because that's the cluster-default tier of the resolver chain. Repo-config `agents.default` on the target repo overrides this via `applyRepoAgentOverrides` (D-3).

## D-5: Resolver — precedence and independence

**Decision**: `resolveAgentForPhase(config, workflowName, phase)` returns `{ provider: string; model?: string }`. Provider always defined (falls back to `DEFAULT_PROVIDER` — `'claude-code'`). Model optional.

Two independent walks — one for provider, one for model — over the same tier list:

1. `agents.workflows.<workflowName>.phases.<phase>` — if this tier has the field, use it.
2. `agents.workflows.<workflowName>.default` — otherwise, this tier.
3. `agents.default` — otherwise, this tier.
4. Repo `defaults.agent` — otherwise, this tier (**provider only**; `defaults.agent` is a single string, not an `AgentEntry`).
5. Cluster default (env) — merged into `agents.default` by loader (D-4), so structurally this collapses into tier 3.
6. Built-in `DEFAULT_PROVIDER = 'claude-code'` — only reached by the provider walk; the model walk terminates at tier 5 returning `undefined`.

Implementation (pseudo):

```ts
export function resolveAgentForPhase(
  config: WorkerConfig,
  workflowName: string,
  phase: WorkflowPhase,
): { provider: string; model?: string } {
  const tiers: (AgentEntry | undefined)[] = [
    config.agents?.workflows?.[workflowName]?.phases?.[phase],
    config.agents?.workflows?.[workflowName]?.default,
    config.agents?.default,
  ];
  const providerFromTiers = tiers.find((t) => t?.provider !== undefined)?.provider;
  const provider = providerFromTiers ?? config.defaultsAgent ?? DEFAULT_PROVIDER;
  const model = tiers.find((t) => t?.model !== undefined)?.model;
  return model ? { provider, model } : { provider };
}
```

**Rationale**:
- The env tier folds into tier 3 via the loader (D-4), so the resolver's tier list is a clean three-entry array. This keeps the function short and testable.
- `config.defaultsAgent` (repo `defaults.agent` from `.generacy/config.yaml`) is threaded into `WorkerConfig` by the same merge pass (D-3) as a top-level field on `WorkerConfig`, not nested inside `agents.default.provider`, because `defaults.agent` semantically **only sets provider**, not model. Folding it into tier 3 would either lose that distinction or require a synthetic empty-model check.
- Provider always resolves (built-in fallback); model may legitimately be `undefined` and the intent's `--model` push is a no-op in that case (matches the "no argv change when unconfigured" invariant).

**Alternatives considered**:
- Fold `defaults.agent` into tier 3 as a synthetic `AgentEntry` — rejected: leaks the "provider-only" semantics into `AgentEntry` shape.
- Single walk with a merged tier list — rejected: coupling provider/model resolution contradicts Q3→A (independent).

**Reference**: Q3 answer A, spec Scope §4.

## D-6: pr-feedback resolution site

**Decision**: `PrFeedbackHandler.spawnClaudeForFeedback` (`packages/orchestrator/src/worker/pr-feedback-handler.ts:464`) calls `resolveAgentForPhase(this.config, item.workflowName, 'implement')` and threads the result into `LaunchRequest.provider` + `PrFeedbackIntent.model`.

**Rationale**:
- Q1→B: pr-feedback binds to `implement`'s resolved `{ provider, model }`. Rationale from the clarification: pr-feedback revises the code `implement` produced, so the agent/model configured for that code is what the operator expects to address review comments on it.
- Zero new config surface. A dedicated `agents.prFeedback` slot can be layered later with `implement` as its absent-case fallback.
- The call site already has `item.workflowName`.

**Alternatives considered**:
- Pseudo-phase `pr-feedback` in the `phases` enum — rejected explicitly by Q5→A (closed set over `WorkflowPhase`); pr-feedback isn't a `WorkflowPhase`.
- `workflows.<name>.default`-only for pr-feedback — rejected: a strong `implement` model would silently not apply to its own PR fixes.

**Reference**: Q1 answer B.

## D-7: Session-drop policy on cross-phase transitions

**Decision**: The phase loop tracks `currentProvider: string | undefined` in the same scope as `currentSessionId`. Between phases:

1. Resolve `{ provider: nextProvider, model: nextModel } = resolveAgentForPhase(config, workflowName, nextPhase)`.
2. If `currentProvider !== undefined && currentProvider !== nextProvider`, drop `currentSessionId` (**and** clear `currentProvider`, so the fresh session gets rebuilt cleanly on the next iteration).
3. Otherwise (`currentProvider === undefined` — first phase — or `currentProvider === nextProvider`), preserve `currentSessionId` and emit `agent.model.transition prev=<currentModel> next=<nextModel>` when the model actually changed.

Where to hook it: `phase-loop.ts` at the same site as step 3b (`if (result.sessionId) currentSessionId = result.sessionId;` around line 411). Add a pre-spawn resolver call in the phase iteration around line 344 that decides drop-vs-preserve based on `currentProvider !== nextProvider`, then updates `currentProvider = nextProvider` for the spawn.

**Rationale**:
- Q2→C: "Preserve `sessionId` on model change but log the model transition." Claude Code sessions are transcript-based, not model-bound — `--model` is a per-invocation parameter.
- Provider-switch drop follows FR-011 literally.
- Tracking `currentProvider` (a small addition to the closure's scope in `executeLoop`) is simpler than mining `result.provider` back out of the previous phase result — the resolver is the single source of truth.
- The `agent.model.transition` log line is a single `logger.info` at the spawn site (`cli-spawner.ts`) or the resolver-adjacent site in `phase-loop.ts`. Preference: emit from `cli-spawner.spawnPhase` when the caller passes both `model` and (a new option) `previousModel: string | undefined`. Alternative: emit from phase-loop where the model comparison naturally exists. **Choice**: emit from phase-loop right after the resolver call, where `previousModel` and `nextModel` are both in scope. Keeps `cli-spawner` mechanical.

**Reference**: Q2 answer C, spec Scope §7 ("cross-phase context lives in the spec artifacts by design").

## D-8: Threading `provider` and `model` from spawn options to argv

**Decision**: 
- `CliSpawnOptions` (`worker/types.ts:199`) gains two optional fields: `provider?: string; model?: string`.
- `CliSpawner.spawnPhase` copies `options.provider` into `LaunchRequest.provider` and `options.model` into `PhaseIntent.model`.
- `ClaudeCodeLaunchPlugin.buildPhaseLaunch` and `buildPrFeedbackLaunch` conditionally push `'--model', intent.model` after the existing `--verbose` (and after `--resume <sessionId>` for phase, to match the current arg order convention that `--resume` sits between the flags and the prompt payload).

The **exact position** of `--model` in the argv matters for snapshot stability. Choose position: **immediately after `--verbose`, before the `sessionId` `--resume` pair or the prompt payload.** This mirrors `buildConversationTurnLaunch`, which pushes `--model` after `--verbose` and before `--dangerously-skip-permissions`.

**Rationale**:
- Consistency with the existing conversation-turn behavior — same relative position.
- No mutation of intent shape beyond what #813 already provisioned (`PhaseIntent.model` + `PrFeedbackIntent.model` fields already exist from D-2 above / #813 data-model.md).
- pr-feedback plugin call currently pushes the prompt at index 4 (after `--verbose`); the `--model` insertion goes at index 4 too so the prompt is pushed after it. Snapshot tests must cover this exact ordering.

## D-9: Documentation surface — which example configs get the block?

**Decision**: Only `packages/generacy/examples/config-full.yaml` gets the `agents` example. `config-minimal.yaml` and `config-single-repo.yaml` remain untouched — the block is genuinely optional. `config-multi-repo.yaml` gets a single-line comment pointing to `config-full.yaml`.

**Rationale**:
- The `full` example is the reference; the others are onboarding shortcuts. Adding `agents` to every example implies it's required.
- The quickstart in `specs/814-*/quickstart.md` (this artifact set) is where the block is actually documented in depth.

## D-10: Test scaffolding — fake provider for the switch test

**Decision**: The provider-switch test in `packages/orchestrator/src/worker/__tests__/phase-loop-provider-switch.test.ts` reuses the same fake-plugin harness that #813 established (`packages/orchestrator/src/launcher/__tests__/multi-provider.test.ts`) — a minimal `AgentLaunchPlugin` under provider `'test-agent'` claiming `'phase'` kind. Registering it beside `ClaudeCodeLaunchPlugin` in a test-only launcher lets the phase loop dispatch to either provider based on `resolveAgentForPhase`'s output.

**Rationale**:
- Zero new fixture infrastructure — the harness exists.
- Isolates the phase-loop's session-drop logic from any real subprocess spawning.

## Key References

- `packages/config/src/template-schema.ts:9-27` — current `OrchestratorSettingsSchema` (where `agents` lands)
- `packages/generacy/src/config/schema.ts:109-128` — CLI-facing mirror
- `packages/orchestrator/src/worker/config.ts:33-42, 106-138` — `PhaseTimeoutOverridesSchema` structural precedent + `resolvePhaseTimeoutMs` sibling
- `packages/orchestrator/src/worker/phase-loop.ts:340-416` — spawn site + `currentSessionId` handling
- `packages/orchestrator/src/worker/cli-spawner.ts:47-83` — `spawnPhase` — where `provider` + `model` thread through
- `packages/orchestrator/src/worker/pr-feedback-handler.ts:464-495` — pr-feedback spawn site (Q1→B target)
- `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts:80-116, 164-189` — where `--model` gets pushed (phase, pr-feedback, conversation-turn — the last for the argv position precedent)
- `packages/orchestrator/src/config/loader.ts:220-255` — worker env-var plumbing (where `WORKER_AGENT_*` lands)
- #813 data-model.md — `PhaseIntent.model` and `PrFeedbackIntent.model` already exist
- Multi-agent provider plan (Codex + OpenCode): Phase 1 issue 2 of 3.
