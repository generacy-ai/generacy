import { z } from 'zod';

export const TemplateReposSchema = z.object({
  primary: z.string().min(1),
  dev: z.array(z.string().min(1)).optional().default([]),
  clone: z.array(z.string().min(1)).optional().default([]),
});

export const TemplateConfigSchema = z.object({
  project: z.object({
    org_name: z.string().optional(),
  }).passthrough().optional(),
  repos: TemplateReposSchema,
});

export type TemplateConfig = z.infer<typeof TemplateConfigSchema>;
