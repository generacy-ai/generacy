import { z } from 'zod';
import type { Logger } from 'pino';

// --- Device Code Flow Schemas ---

export const DeviceCodeResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  interval: z.number().int().positive(),
  expires_in: z.number().int().positive(),
});
export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponseSchema>;

export const PollRequestSchema = z.object({
  device_code: z.string().min(1),
});
export type PollRequest = z.infer<typeof PollRequestSchema>;

export const PollResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('authorization_pending') }),
  z.object({ status: z.literal('slow_down') }),
  z.object({ status: z.literal('expired') }),
  z.object({
    status: z.literal('approved'),
    cluster_api_key: z.string().min(1),
    cluster_api_key_id: z.string().min(1),
    cluster_id: z.string().min(1),
    project_id: z.string().min(1),
    org_id: z.string().min(1),
  }),
]);
export type PollResponse = z.infer<typeof PollResponseSchema>;

// --- Activation Result ---

export const ActivationResultSchema = z.object({
  apiKey: z.string().min(1),
  clusterApiKeyId: z.string().optional(),
  clusterId: z.string().min(1),
  projectId: z.string().min(1),
  orgId: z.string().min(1),
});
export type ActivationResult = z.infer<typeof ActivationResultSchema>;

// --- Persisted Cluster Metadata ---

export const ClusterJsonSchema = z.object({
  cluster_id: z.string().min(1),
  project_id: z.string().min(1),
  org_id: z.string().min(1),
  cloud_url: z.string().url(),
  activated_at: z.string().datetime(),
});
export type ClusterJson = z.infer<typeof ClusterJsonSchema>;

// --- Injectable HTTP Client ---

export interface HttpResponse<T> {
  status: number;
  data: T;
}

export interface HttpClient {
  post<T>(url: string, body?: unknown): Promise<HttpResponse<T>>;
}

// --- Activation Options ---

export interface ActivationOptions {
  cloudUrl: string;
  keyFilePath: string;
  clusterJsonPath: string;
  logger: Logger;
  maxCycles?: number;
  maxRetries?: number;
  httpClient?: HttpClient;
}
