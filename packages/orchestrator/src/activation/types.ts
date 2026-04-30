import { z } from 'zod';
import type { Logger } from 'pino';

// Re-export protocol types from the shared activation client
export {
  DeviceCodeResponseSchema,
  PollResponseSchema,
  type DeviceCodeResponse,
  type PollResponse,
  type HttpClient,
  type HttpResponse,
  type ActivationResult,
} from '@generacy-ai/activation-client';

// --- Persisted Cluster Metadata (orchestrator-specific) ---

export const ClusterJsonSchema = z.object({
  cluster_id: z.string().min(1),
  project_id: z.string().min(1),
  org_id: z.string().min(1),
  cloud_url: z.string().url(),
  activated_at: z.string().datetime(),
});
export type ClusterJson = z.infer<typeof ClusterJsonSchema>;

// --- Activation Options (orchestrator-specific, includes persistence paths) ---

export interface ActivationOptions {
  cloudUrl: string;
  keyFilePath: string;
  clusterJsonPath: string;
  logger: Logger;
  maxCycles?: number;
  maxRetries?: number;
  httpClient?: import('@generacy-ai/activation-client').HttpClient;
}
