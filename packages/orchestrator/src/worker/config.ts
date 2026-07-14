import { z } from 'zod';
import type { OrchestratorSettings, AgentsConfig } from '@generacy-ai/config';
import { AgentsConfigSchema } from '@generacy-ai/config';
import type { WorkflowPhase } from './types.js';

/**
 * Built-in provider fallback used by `resolveAgentForPhase` when no tier of
 * the precedence chain (config, repo `defaults.agent`, or env) supplies a
 * provider name.
 */
export const DEFAULT_PROVIDER = 'claude-code';

/**
 * Gate definition schema for pausing workflow at review checkpoints
 */
export const GateDefinitionSchema = z.object({
  /** Phase that triggers gate check */
  phase: z.enum(['specify', 'clarify', 'plan', 'tasks', 'implement', 'validate'] as const satisfies readonly WorkflowPhase[]),
  /** Label to add when gate is active */
  gateLabel: z.string(),
  /** When to activate the gate */
  condition: z.enum(['always', 'on-request', 'on-questions', 'on-failure', 'on-sibling-review', 'on-merge-conflict']),
});

/**
 * Per-phase wall-clock timeout overrides (milliseconds).
 *
 * Each CLI phase is killed (SIGTERM → grace → SIGKILL) once its wall-clock
 * runtime exceeds its timeout. The `plan` and `implement` phases are
 * structurally heavier than the others — `plan` fans out research subagents,
 * `implement` writes code — so they default to a larger budget than the flat
 * `phaseTimeoutMs`. Any phase without an override falls back to `phaseTimeoutMs`.
 *
 * Defined per-field (rather than as a `z.record`) so that overriding one phase
 * via config/env does not drop the defaults for the others — Zod applies the
 * remaining field defaults when the object is present but partial.
 *
 * `validate` is intentionally excluded: that phase runs a shell command via a
 * separate code path with its own timeout, not `phaseTimeoutMs`.
 */
export const PhaseTimeoutOverridesSchema = z
  .object({
    specify: z.number().int().min(60_000).optional(),
    clarify: z.number().int().min(60_000).optional(),
    plan: z.number().int().min(60_000).default(3_600_000),
    tasks: z.number().int().min(60_000).optional(),
    implement: z.number().int().min(60_000).default(3_600_000),
  })
  .default({});
export type PhaseTimeoutOverrides = z.infer<typeof PhaseTimeoutOverridesSchema>;

/**
 * Worker configuration schema
 */
export const WorkerConfigSchema = z.object({
  /** Fallback timeout per phase in milliseconds (used when no per-phase override applies) */
  phaseTimeoutMs: z.number().int().min(60_000).default(1_200_000),
  /** Per-phase timeout overrides keyed by phase name */
  phaseTimeoutOverrides: PhaseTimeoutOverridesSchema,
  /** Base directory for repo checkouts */
  workspaceDir: z.string().default('/tmp/orchestrator-workspaces'),
  /** Grace period for shutdown in milliseconds */
  shutdownGracePeriodMs: z.number().int().min(1000).default(5000),
  /** Command to run during the validate phase */
  validateCommand: z.string().default('pnpm test && pnpm build'),
  /** Command to run before validation to install dependencies (empty string to skip) */
  preValidateCommand: z
    .string()
    .default(
      "pnpm install && if [ -f pnpm-workspace.yaml ] && ls packages/*/package.json >/dev/null 2>&1; then pnpm -r --filter './packages/*' build; fi",
    ),
  /** Maximum retries for implement phase when partial progress is detected */
  maxImplementRetries: z.number().int().min(0).max(5).default(2),
  /** Credential role from .generacy/config.yaml defaults.role — when set, credentials are populated on launch requests */
  credentialRole: z.string().optional(),
  /**
   * Per-workflow-phase `{ provider, model }` selection. See `AgentsConfigSchema`
   * for the shape. Repo-level overrides from `.generacy/config.yaml` are merged
   * onto this via `applyRepoAgentOverrides`.
   */
  agents: AgentsConfigSchema.optional(),
  /**
   * Repo-level default provider from `.generacy/config.yaml` `defaults.agent`.
   * Provider-only — `defaults.agent` is a single string, not an `AgentEntry`.
   * Consumed by `resolveAgentForPhase` as the tier below `agents.default`.
   */
  defaultsAgent: z.string().min(1).optional(),
  /** Gate definitions keyed by issue label */
  gates: z.record(z.string(), z.array(GateDefinitionSchema)).default({
    'speckit-feature': [
      { phase: 'clarify', gateLabel: 'waiting-for:clarification', condition: 'on-questions' },
      { phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'always' },
      { phase: 'implement', gateLabel: 'waiting-for:sibling-review', condition: 'on-sibling-review' },
      { phase: 'implement', gateLabel: 'waiting-for:merge-conflicts', condition: 'on-merge-conflict' },
      { phase: 'validate', gateLabel: 'waiting-for:merge-conflicts', condition: 'on-merge-conflict' },
    ],
    'speckit-bugfix': [
      { phase: 'clarify', gateLabel: 'waiting-for:clarification', condition: 'on-questions' },
      { phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'on-request' },
      { phase: 'implement', gateLabel: 'waiting-for:merge-conflicts', condition: 'on-merge-conflict' },
      { phase: 'validate', gateLabel: 'waiting-for:merge-conflicts', condition: 'on-merge-conflict' },
    ],
    'speckit-epic': [
      { phase: 'clarify', gateLabel: 'waiting-for:clarification', condition: 'on-questions' },
      { phase: 'tasks', gateLabel: 'waiting-for:tasks-review', condition: 'always' },
    ],
  }),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

/**
 * Merge per-repo validate-command overrides onto the global worker config.
 *
 * The target repo's `.generacy/config.yaml` `orchestrator` block may set
 * `validateCommand` / `preValidateCommand`. The global defaults are
 * monorepo-shaped (`pnpm test && pnpm build`); single-package repos (e.g. an
 * Astro site with only a `build` script) override them so the validate phase
 * doesn't fail on a missing `test` script before it can reach the build.
 *
 * Only those two fields are overridable per-repo. An explicit empty
 * `preValidateCommand` is preserved (it means "skip the install step"). Returns
 * the original config object unchanged when there are no applicable overrides,
 * so callers can cheaply detect "no override" via reference equality.
 */
export function applyRepoValidateOverrides(
  config: WorkerConfig,
  settings: OrchestratorSettings | null | undefined,
): WorkerConfig {
  if (
    settings == null ||
    (settings.validateCommand === undefined && settings.preValidateCommand === undefined)
  ) {
    return config;
  }
  return {
    ...config,
    ...(settings.validateCommand !== undefined
      ? { validateCommand: settings.validateCommand }
      : {}),
    ...(settings.preValidateCommand !== undefined
      ? { preValidateCommand: settings.preValidateCommand }
      : {}),
  };
}

/**
 * Resolve the wall-clock timeout (ms) for a CLI phase: the per-phase override
 * if one is configured, otherwise the flat `phaseTimeoutMs` fallback.
 */
export function resolvePhaseTimeoutMs(
  config: WorkerConfig,
  phase: Exclude<WorkflowPhase, 'validate'>,
): number {
  // Optional-chained: configs built by hand (tests, direct construction) bypass
  // Zod and may omit phaseTimeoutOverrides entirely.
  return config.phaseTimeoutOverrides?.[phase] ?? config.phaseTimeoutMs;
}

/**
 * Field-by-field merge of two `AgentEntry` objects. Target-repo values overlay
 * cluster-default values; missing fields on the target preserve the cluster
 * default (`{ provider: 'X' }` on target keeps cluster's `model`).
 */
function mergeAgentEntry(
  base: AgentsConfig['default'] | undefined,
  override: AgentsConfig['default'] | undefined,
): AgentsConfig['default'] | undefined {
  if (base === undefined) return override;
  if (override === undefined) return base;
  return {
    ...(base.provider !== undefined || override.provider !== undefined
      ? { provider: override.provider ?? base.provider }
      : {}),
    ...(base.model !== undefined || override.model !== undefined
      ? { model: override.model ?? base.model }
      : {}),
  };
}

/**
 * Deep merge two `AgentsConfig` values. Merge semantics:
 * - `agents.default`: field-by-field on `{ provider, model }`.
 * - `agents.workflows.<name>.default`: same field-by-field merge.
 * - `agents.workflows.<name>.phases.<phase>`: same field-by-field merge.
 * - Workflow names present only on the target pass through untouched; workflow
 *   names present only on the base survive when the target adds new ones.
 */
function mergeAgentsConfig(
  base: AgentsConfig | undefined,
  override: AgentsConfig | undefined,
): AgentsConfig | undefined {
  if (base === undefined) return override;
  if (override === undefined) return base;

  const merged: AgentsConfig = {};

  const mergedDefault = mergeAgentEntry(base.default, override.default);
  if (mergedDefault !== undefined) merged.default = mergedDefault;

  const baseWorkflows = base.workflows ?? {};
  const overrideWorkflows = override.workflows ?? {};
  const workflowNames = new Set([
    ...Object.keys(baseWorkflows),
    ...Object.keys(overrideWorkflows),
  ]);
  if (workflowNames.size > 0) {
    const workflows: Record<string, AgentsConfig['workflows'] extends infer W ? W extends Record<string, infer V> ? V : never : never> = {};
    for (const name of workflowNames) {
      const b = baseWorkflows[name];
      const o = overrideWorkflows[name];
      if (b === undefined && o !== undefined) {
        workflows[name] = o;
        continue;
      }
      if (o === undefined && b !== undefined) {
        workflows[name] = b;
        continue;
      }
      // Both defined — merge default + phases field-by-field
      const mergedWorkflowDefault = mergeAgentEntry(b?.default, o?.default);
      const phaseKeys = ['specify', 'clarify', 'plan', 'tasks', 'implement', 'validate'] as const;
      const mergedPhases: Record<string, AgentsConfig['default']> = {};
      let anyPhase = false;
      for (const phase of phaseKeys) {
        const bp = b?.phases?.[phase];
        const op = o?.phases?.[phase];
        const mp = mergeAgentEntry(bp, op);
        if (mp !== undefined) {
          mergedPhases[phase] = mp;
          anyPhase = true;
        }
      }
      const entry: NonNullable<AgentsConfig['workflows']>[string] = {};
      if (mergedWorkflowDefault !== undefined) entry.default = mergedWorkflowDefault;
      if (anyPhase) entry.phases = mergedPhases as NonNullable<AgentsConfig['workflows']>[string]['phases'];
      workflows[name] = entry;
    }
    merged.workflows = workflows;
  }

  return merged;
}

/**
 * Sibling of `applyRepoValidateOverrides` — merges the target repo's
 * `orchestrator.agents` block onto the cluster-default `agents` block on
 * `WorkerConfig`. Field-by-field so partial `{ provider }`-only or
 * `{ model }`-only overrides preserve missing sibling fields from the base.
 *
 * Returns the original config unchanged when `settings.agents` is absent so
 * callers can cheaply detect "no override" via reference equality.
 */
export function applyRepoAgentOverrides(
  config: WorkerConfig,
  settings: OrchestratorSettings | null | undefined,
): WorkerConfig {
  if (settings == null || settings.agents === undefined) {
    return config;
  }
  const merged = mergeAgentsConfig(config.agents, settings.agents);
  return { ...config, agents: merged };
}

/**
 * Resolve `{ provider, model }` for a phase within a workflow. Provider and
 * model resolve INDEPENDENTLY over the same tier list — a phase override may
 * set only `model` while `provider` falls through from a lower tier.
 *
 * Precedence:
 *   1. `config.agents.workflows[workflowName].phases[phase]`
 *   2. `config.agents.workflows[workflowName].default`
 *   3. `config.agents.default`  (cluster env folds into this tier via loader)
 *   4. `config.defaultsAgent`   (**provider only** — `defaults.agent` is a bare string)
 *   5. Built-in `DEFAULT_PROVIDER = 'claude-code'` (**provider only**)
 *
 * The `model` walk terminates at tier 3 returning `undefined` (no built-in
 * model default). The `provider` walk always returns a value.
 */
export function resolveAgentForPhase(
  config: WorkerConfig,
  workflowName: string,
  phase: WorkflowPhase,
): { provider: string; model?: string } {
  const workflowEntry = config.agents?.workflows?.[workflowName];
  const tiers: (AgentsConfig['default'] | undefined)[] = [
    workflowEntry?.phases?.[phase],
    workflowEntry?.default,
    config.agents?.default,
  ];
  const providerFromTiers = tiers.find((t) => t?.provider !== undefined)?.provider;
  const provider = providerFromTiers ?? config.defaultsAgent ?? DEFAULT_PROVIDER;
  const model = tiers.find((t) => t?.model !== undefined)?.model;
  return model !== undefined ? { provider, model } : { provider };
}
