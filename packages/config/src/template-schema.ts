import { z } from 'zod';

export const TemplateReposSchema = z.object({
  primary: z.string().min(1),
  dev: z.array(z.string().min(1)).nullable().transform((v) => v ?? []).optional().default([]),
  clone: z.array(z.string().min(1)).nullable().transform((v) => v ?? []).optional().default([]),
});

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
