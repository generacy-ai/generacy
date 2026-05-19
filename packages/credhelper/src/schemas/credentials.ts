import { z } from 'zod';

export const MintConfigSchema = z.object({
  ttl: z.string(),
  scopeTemplate: z.record(z.unknown()).optional(),
});

export const CredentialEntrySchema = z.object({
  id: z.string(),
  type: z.string(),
  backend: z.string(),
  backendKey: z.string(),
  mint: MintConfigSchema.optional(),
});

export const CredentialsConfigSchema = z.object({
  schemaVersion: z.literal('1'),
  credentials: z.array(CredentialEntrySchema),
});

export type CredentialsConfig = z.infer<typeof CredentialsConfigSchema>;
export type CredentialEntry = z.infer<typeof CredentialEntrySchema>;
export type MintConfig = z.infer<typeof MintConfigSchema>;
