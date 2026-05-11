import { z } from 'zod';

// Re-export credential/role schemas from @generacy-ai/credhelper
export {
  CredentialEntrySchema,
  type CredentialEntry,
  RoleConfigSchema,
  type RoleConfig,
  RoleCredentialRefSchema,
  type RoleCredentialRef,
} from '@generacy-ai/credhelper';

// Cluster state enums
export const ClusterStatusSchema = z.enum(['bootstrapping', 'ready', 'degraded', 'error']);
export type ClusterStatus = z.infer<typeof ClusterStatusSchema>;

export const DeploymentModeSchema = z.enum(['local', 'cloud']);
export type DeploymentMode = z.infer<typeof DeploymentModeSchema>;

export const ClusterVariantSchema = z.enum(['cluster-base', 'cluster-microservices']);
export type ClusterVariant = z.infer<typeof ClusterVariantSchema>;

export const ClusterStateSchema = z.object({
  status: ClusterStatusSchema,
  deploymentMode: DeploymentModeSchema,
  variant: ClusterVariantSchema,
  lastSeen: z.string().datetime(),
  statusReason: z.string().max(200).optional(),
});
export type ClusterState = z.infer<typeof ClusterStateSchema>;

export const StatusUpdateSchema = z.object({
  status: ClusterStatusSchema,
  statusReason: z.string().max(200).optional(),
});
export type StatusUpdate = z.infer<typeof StatusUpdateSchema>;

// Lifecycle
export const LifecycleActionSchema = z.enum([
  'bootstrap-complete',
  'clone-peer-repos',
  'code-server-start',
  'code-server-stop',
  'stop',
]);
export type LifecycleAction = z.infer<typeof LifecycleActionSchema>;

export const ClonePeerReposBodySchema = z.object({
  repos: z.array(z.string().url()).min(0),
  token: z.string().optional(),
});
export type ClonePeerReposBody = z.infer<typeof ClonePeerReposBodySchema>;

export const LifecycleResponseSchema = z.object({
  accepted: z.literal(true),
  action: LifecycleActionSchema,
});
export type LifecycleResponse = z.infer<typeof LifecycleResponseSchema>;

// code-server-start returns its own runtime status + socket path so the caller
// (typically the cloud UI proxying through the relay) can connect immediately.
export const CodeServerStartResponseSchema = z.object({
  status: z.enum(['starting', 'running']),
  socket_path: z.string(),
});
export type CodeServerStartResponse = z.infer<typeof CodeServerStartResponseSchema>;

// Credential stub response (wraps entry with runtime status)
export const CredentialStubResponseSchema = z.object({
  id: z.string(),
  type: z.string(),
  backend: z.string(),
  backendKey: z.string(),
  status: z.enum(['active', 'pending', 'error']),
  createdAt: z.string().datetime(),
});
export type CredentialStubResponse = z.infer<typeof CredentialStubResponseSchema>;

// Audit schemas (mirrored from credhelper-daemon for validation)
export const AuditActionSchema = z.enum([
  'session.begin',
  'session.end',
  'credential.mint',
  'credential.resolve',
  'credential.refresh',
  'exposure.render',
  'proxy.docker',
  'proxy.localhost',
]);

export const AuditEntrySchema = z.object({
  timestamp: z.string(),
  action: AuditActionSchema,
  actor: z.object({
    workerId: z.string(),
    sessionId: z.string().optional(),
  }),
  clusterId: z.string(),
  credentialId: z.string().optional(),
  role: z.string().optional(),
  pluginId: z.string().optional(),
  success: z.boolean(),
  errorCode: z.string().optional(),
  exposureKind: z.string().optional(),
  proxy: z.object({
    method: z.string(),
    path: z.string(),
    decision: z.enum(['allow', 'deny']),
  }).optional(),
});

export const AuditBatchSchema = z.object({
  entries: z.array(AuditEntrySchema).max(50),
  droppedSinceLastBatch: z.number().int().min(0),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type AuditBatch = z.infer<typeof AuditBatchSchema>;

// Error response
export const ErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string(),
  details: z.unknown().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
