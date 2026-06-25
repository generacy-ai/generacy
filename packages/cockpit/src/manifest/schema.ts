import { z } from 'zod';

const OWNER_REPO_REGEX = /^[^/]+\/[^/]+$/;
const ISSUE_REF_REGEX = /^[^/]+\/[^/]+#\d+$/;

export const EpicEntrySchema = z.object({
  repo: z.string().regex(OWNER_REPO_REGEX, 'must be owner/repo'),
  issue: z.number().int().positive(),
  slug: z.string().min(1),
  plan: z.string().min(1),
});

export const PhaseEntrySchema = z.object({
  name: z.string().min(1),
  tier: z.string().min(1).optional(),
  repos: z.array(z.string().regex(OWNER_REPO_REGEX, 'must be owner/repo')).default([]),
  issues: z.array(z.string().regex(ISSUE_REF_REGEX, 'must be owner/repo#n')).default([]),
});

export const EpicManifestSchema = z.object({
  epic: EpicEntrySchema,
  autonomy: z.record(z.unknown()).default({}),
  phases: z.array(PhaseEntrySchema).default([]),
});

export type EpicManifest = z.infer<typeof EpicManifestSchema>;
export type EpicEntry = z.infer<typeof EpicEntrySchema>;
export type PhaseEntry = z.infer<typeof PhaseEntrySchema>;
