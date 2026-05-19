import { z } from 'zod';

export const ClusterEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  cloudUrl: z.string().url(),
  lastSeen: z.string().datetime(),
});

export const ClusterRegistrySchema = z.object({
  version: z.literal(1),
  clusters: z.array(ClusterEntrySchema),
});

export type ClusterEntry = z.infer<typeof ClusterEntrySchema>;
export type ClusterRegistry = z.infer<typeof ClusterRegistrySchema>;
