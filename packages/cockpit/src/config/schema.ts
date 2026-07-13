import { z } from 'zod';

export const CockpitConfigSchema = z.object({
  owner: z.string().min(1).optional(),
  assignee: z.string().min(1).optional(),
});

export type CockpitConfig = z.infer<typeof CockpitConfigSchema>;

export type CockpitConfigSource = 'cockpit-block' | 'defaults';

export interface LoadedCockpitConfig {
  config: CockpitConfig;
  source: CockpitConfigSource;
  warnings: string[];
}
