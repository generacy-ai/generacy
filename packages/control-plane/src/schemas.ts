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
});
export type ClusterState = z.infer<typeof ClusterStateSchema>;

// Lifecycle
export const LifecycleActionSchema = z.enum([
  'clone-peer-repos',
  'code-server-start',
  'code-server-stop',
]);
export type LifecycleAction = z.infer<typeof LifecycleActionSchema>;

export const LifecycleResponseSchema = z.object({
  accepted: z.literal(true),
  action: LifecycleActionSchema,
});
export type LifecycleResponse = z.infer<typeof LifecycleResponseSchema>;

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

// Error response
export const ErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string(),
  details: z.unknown().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
