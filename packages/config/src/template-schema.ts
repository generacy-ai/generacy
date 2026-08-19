import { z } from 'zod';

export const TemplateReposSchema = z.object({
  primary: z.string().min(1),
  dev: z.array(z.string().min(1)).nullable().transform((v) => v ?? []).optional().default([]),
  clone: z.array(z.string().min(1)).nullable().transform((v) => v ?? []).optional().default([]),
});

/**
 * Reasoning effort levels understood by the Claude CLI (v2.1.150). Matches the
 * `--effort <level>` flag vocabulary verbatim. Consumers that lack an effort
 * mechanism silently drop the field at spawn time (with a warning).
 */
export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof EffortSchema>;

/**
 * A single agent selector: `{ provider?, model?, effort? }`. All fields are
 * optional and resolve independently — a phase override may set only `model`
 * and let `provider` fall through from a lower precedence tier.
 */
export const AgentEntrySchema = z
  .object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    effort: EffortSchema.optional(),
  })
  .strict();
export type AgentEntry = z.infer<typeof AgentEntrySchema>;

/**
 * Per-workflow agent overrides. `phases` keys are enumerated per-field over the
 * closed `WorkflowPhase` set — Zod rejects unknown keys (e.g. `implment`,
 * `pr-feedback`) at parse time.
 */
export const WorkflowAgentEntriesSchema = z
  .object({
    default: AgentEntrySchema.optional(),
    phases: z
      .object({
        specify: AgentEntrySchema.optional(),
        clarify: AgentEntrySchema.optional(),
        plan: AgentEntrySchema.optional(),
        tasks: AgentEntrySchema.optional(),
        implement: AgentEntrySchema.optional(),
        review: AgentEntrySchema.optional(),
        validate: AgentEntrySchema.optional(),
        remediate: AgentEntrySchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WorkflowAgentEntries = z.infer<typeof WorkflowAgentEntriesSchema>;

/**
 * Agents configuration block under `orchestrator.agents`. Structure:
 * ```
 * agents:
 *   default: { provider?, model?, effort? }
 *   workflows:
 *     <name>:
 *       default: { provider?, model?, effort? }
 *       phases:
 *         implement: { provider?, model?, effort? }
 * ```
 * Workflow names are extensible (`speckit-feature`, `speckit-bugfix`, …); phase
 * keys are closed to the `WorkflowPhase` enum. `workflows` stays a `z.record`
 * because arbitrary workflow names are legal by design.
 */
export const AgentsConfigSchema = z
  .object({
    default: AgentEntrySchema.optional(),
    workflows: z.record(z.string(), WorkflowAgentEntriesSchema).optional(),
  })
  .strict();
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

/**
 * Per-workflow review-phase tuning under `orchestrator.workflows.<name>.review`.
 * All fields optional and resolve independently — a workflow may override only
 * `blockingSeverity` and inherit `profile`/`failThenPass` from the built-in
 * default. `.strict()` rejects unknown keys at parse time.
 */
export const WorkflowReviewSchema = z
  .object({
    profile: z.enum(['standard', 'verification']).optional(),
    blockingSeverity: z.enum(['critical', 'major', 'minor']).optional(),
    failThenPass: z.boolean().optional(),
  })
  .strict();
export type WorkflowReview = z.infer<typeof WorkflowReviewSchema>;

/**
 * Per-workflow orchestrator overrides under `orchestrator.workflows.<name>`.
 * Lets a target repo vary `validateCommand` / `preValidateCommand` /
 * `maxRemediations` / `review` per workflow (e.g. `speckit-feature` vs
 * `speckit-bugfix`). All fields optional; `.strict()` rejects unknown keys.
 */
export const WorkflowOverrideSchema = z
  .object({
    validateCommand: z.string().optional(),
    preValidateCommand: z.string().optional(),
    maxRemediations: z.number().int().min(0).optional(),
    review: WorkflowReviewSchema.optional(),
  })
  .strict();
export type WorkflowOverride = z.infer<typeof WorkflowOverrideSchema>;

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
  /**
   * Per-workflow overrides for `validateCommand` / `preValidateCommand` /
   * `maxRemediations` / `review`. Keyed by workflow name (`speckit-feature`,
   * `speckit-bugfix`, …). Resolved workflow-level > repo-level > cluster default
   * by `resolveWorkflowOverrides` in the orchestrator. See `WorkflowOverrideSchema`.
   */
  workflows: z.record(z.string(), WorkflowOverrideSchema).optional(),
});

export const TemplateConfigSchema = z.object({
  /**
   * Target branch for every workspace repo. Omit for "no preference" — setup
   * then leaves existing checkouts on their current branch and clones new repos
   * on the remote default.
   */
  branch: z.string().min(1).optional(),
  project: z.object({
    org_name: z.string().optional(),
  }).passthrough().optional(),
  repos: TemplateReposSchema,
  orchestrator: OrchestratorSettingsSchema.optional(),
});

export type TemplateConfig = z.infer<typeof TemplateConfigSchema>;
export type OrchestratorSettings = z.infer<typeof OrchestratorSettingsSchema>;
