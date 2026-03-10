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
