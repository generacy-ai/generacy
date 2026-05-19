import { z } from 'zod';

export const PluginPinSchema = z.object({
  sha256: z.string(),
});

export const TrustedPluginsSchema = z.object({
  schemaVersion: z.literal('1'),
  plugins: z.record(PluginPinSchema),
});

export type TrustedPluginsConfig = z.infer<typeof TrustedPluginsSchema>;
export type PluginPin = z.infer<typeof PluginPinSchema>;
