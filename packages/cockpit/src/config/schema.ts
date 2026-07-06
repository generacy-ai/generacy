import { z } from 'zod';

const OWNER_REPO_REGEX = /^[^/]+\/[^/]+$/;

export const CockpitConfigSchema = z.object({
  owner: z.string().min(1).optional(),
  repos: z.array(z.string().regex(OWNER_REPO_REGEX, 'must be owner/repo')).default([]),
});

export type CockpitConfig = z.infer<typeof CockpitConfigSchema>;

export type CockpitConfigSource = 'cockpit-block' | 'monitored-repos-env' | 'defaults';

export interface LoadedCockpitConfig {
  config: CockpitConfig;
  source: CockpitConfigSource;
  warnings: string[];
}
