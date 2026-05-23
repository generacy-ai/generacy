import { z } from 'zod';

export const ClusterYamlSchema = z
  .object({
    channel: z.enum(['preview', 'stable']).optional(),
    workers: z.number().int().min(1).optional(),
    variant: z.enum(['cluster-base', 'cluster-microservices']).optional(),
    appConfig: z.unknown().optional(),
  })
  .passthrough();

export type ClusterYamlData = z.infer<typeof ClusterYamlSchema>;

export const ClusterLocalYamlSchema = z
  .object({
    workers: z.number().int().min(1).optional(),
  })
  .passthrough();

export type ClusterLocalYamlData = z.infer<typeof ClusterLocalYamlSchema>;
