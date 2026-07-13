import { z } from 'zod';

export const TemplateReposSchema = z.object({
  primary: z.string().min(1),
  dev: z.array(z.string().min(1)).nullable().transform((v) => v ?? []).optional().default([]),
  clone: z.array(z.string().min(1)).nullable().transform((v) => v ?? []).optional().default([]),
});

/**
 * A single agent selector: `{ provider?, model? }`. Both fields are optional and
 * resolve independently — a phase override may set only `model` and let
 * `provider` fall through from a lower precedence tier.
 */
export const AgentEntrySchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
export type AgentEntry = z.infer<typeof AgentEntrySchema>;

/**
 * Per-workflow agent overrides. `phases` keys are enumerated per-field over the
 * closed `WorkflowPhase` set — Zod rejects unknown keys (e.g. `implment`,
 * `pr-feedback`) at parse time.
 */
export const WorkflowAgentEntriesSchema = z.object({
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
export type WorkflowAgentEntries = z.infer<typeof WorkflowAgentEntriesSchema>;

/**
 * Agents configuration block under `orchestrator.agents`. Structure:
 * ```
 * agents:
 *   default: { provider?, model? }
 *   workflows:
 *     <name>:
 *       default: { provider?, model? }
 *       phases:
 *         implement: { provider?, model? }
 * ```
 * Workflow names are extensible (`speckit-feature`, `speckit-bugfix`, …); phase
 * keys are closed to the `WorkflowPhase` enum.
 */
export const AgentsConfigSchema = z.object({
  default: AgentEntrySchema.optional(),
  workflows: z.record(z.string(), WorkflowAgentEntriesSchema).optional(),
});
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

export const OrchestratorSettingsSchema = z.object({
  labelMonitor: z.boolean().optional(),
  webhookSetup: z.boolean().optional(),
  smeeChannelUrl: z.string().url().optional(),
  /**
   * Per-repo override for the validate-phase command. When set, it replaces the
   * orchestrator's global `validateCommand` for jobs in this repo. The global
   * default (`pnpm test && pnpm build`) assumes a `test` script and a monorepo;
   * single-package repos (e.g. an Astro site with only a `build` script) set
   * this to `pnpm build` so the validate phase doesn't fail on a missing script.
   */
  validateCommand: z.string().optional(),
  /**
   * Per-repo override for the pre-validate install command. Empty string skips
   * the install step. When set, it replaces the orchestrator's global
   * `preValidateCommand` for jobs in this repo.
   */
  preValidateCommand: z.string().optional(),
  /**
   * Per-repo `{ provider, model }` selection for speckit workflow phases and
   * pr-feedback (bound to `implement`). See `AgentsConfigSchema`.
   */
  agents: AgentsConfigSchema.optional(),
});

export const TemplateConfigSchema = z.object({
  project: z.object({
    org_name: z.string().optional(),
  }).passthrough().optional(),
  repos: TemplateReposSchema,
  orchestrator: OrchestratorSettingsSchema.optional(),
});

export type TemplateConfig = z.infer<typeof TemplateConfigSchema>;
export type OrchestratorSettings = z.infer<typeof OrchestratorSettingsSchema>;
