import { z } from 'zod';

// --- Device Code Flow Schemas (wire format matches cloud API) ---

export const DeviceCodeResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  interval: z.number().int().positive(),
  expires_in: z.number().int().positive(),
});
export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponseSchema>;

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
    cloud_url: z.string().url(),
  }),
]);
export type PollResponse = z.infer<typeof PollResponseSchema>;

// --- Activation Result ---

export interface ActivationResult {
  apiKey: string;
  clusterApiKeyId?: string;
  clusterId: string;
  projectId: string;
  orgId: string;
  cloudUrl?: string;
}

// --- Configuration ---

export interface ActivationClientOptions {
  cloudUrl: string;
  logger: ActivationLogger;
  maxCycles?: number;
  maxRetries?: number;
}

// --- Injectable interfaces ---

export interface HttpResponse<T> {
  status: number;
  data: T;
}

export interface HttpClient {
  post<T>(url: string, body?: unknown): Promise<HttpResponse<T>>;
}

export interface ActivationLogger {
  info(msg: string): void;
  warn(msg: string): void;
}
