import { z } from 'zod';

export const BackendAuthSchema = z.object({
  mode: z.string(),
}).passthrough();

export const BackendEntrySchema = z.object({
  id: z.string(),
  type: z.string(),
  endpoint: z.string().url().optional(),
  auth: BackendAuthSchema.optional(),
});

export const BackendsConfigSchema = z.object({
  schemaVersion: z.literal('1'),
  backends: z.array(BackendEntrySchema),
});

export type BackendsConfig = z.infer<typeof BackendsConfigSchema>;
export type BackendEntry = z.infer<typeof BackendEntrySchema>;
export type BackendAuth = z.infer<typeof BackendAuthSchema>;
