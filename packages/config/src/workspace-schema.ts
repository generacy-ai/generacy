import { z } from 'zod';

export const WorkspaceRepoSchema = z.object({
  name: z.string().min(1),
  monitor: z.boolean().default(true),
});

export type WorkspaceRepo = z.infer<typeof WorkspaceRepoSchema>;

export const WorkspaceConfigSchema = z.object({
  org: z.string().min(1),
  branch: z.string().min(1).default('develop'),
  repos: z.array(WorkspaceRepoSchema).min(1),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
