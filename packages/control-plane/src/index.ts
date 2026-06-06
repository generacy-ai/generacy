// Types
export type { ActorContext } from './context.js';
export type { ServerConfig, RouteHandler, ClusterStateStore } from './types.js';

// Schemas
export {
  ClusterStatusSchema,
  DeploymentModeSchema,
  ClusterVariantSchema,
  ClusterStateSchema,
  StatusUpdateSchema,
  LifecycleActionSchema,
  LifecycleResponseSchema,
  ClonePeerReposBodySchema,
  CodeServerStartResponseSchema,
  CredentialStubResponseSchema,
  ErrorResponseSchema,
  CredentialEntrySchema,
  RoleConfigSchema,
  RoleCredentialRefSchema,
  type ClusterStatus,
  type DeploymentMode,
  type ClusterVariant,
  type ClusterState,
  type StatusUpdate,
  type LifecycleAction,
  type LifecycleResponse,
  type ClonePeerReposBody,
  type CodeServerStartResponse,
  type CredentialStubResponse,
  type ErrorResponse,
  type CredentialEntry,
  type RoleConfig,
  type RoleCredentialRef,
} from './schemas.js';

// State
export {
  initClusterState,
  updateClusterStatus,
  getClusterState,
} from './state.js';

// Services
export {
  CodeServerProcessManager,
  getCodeServerManager,
  setCodeServerManager,
  loadOptionsFromEnv,
  DEFAULT_CODE_SERVER_BIN,
  DEFAULT_CODE_SERVER_SOCKET,
  DEFAULT_IDLE_TIMEOUT_MS,
  type CodeServerManager,
  type CodeServerManagerOptions,
  type CodeServerStartResult,
  type CodeServerStatus,
} from './services/code-server-manager.js';

export {
  TunnelHandler,
  type RelayMessageSender,
} from './services/tunnel-handler.js';

export {
  createJitGitTokenClient,
  JitTokenError,
  type JitGitTokenClient,
  type JitGitTokenClientOptions,
  type JitGitTokenResponse,
  type JitTokenErrorCode,
} from './services/jit-git-token-client.js';

// Errors
export {
  ControlPlaneError,
  sendError,
  type ControlPlaneErrorCode,
  type ControlPlaneErrorResponse,
} from './errors.js';

// Server
export { ControlPlaneServer } from './server.js';

// Docker Engine & worker enumeration (#714)
export {
  DockerEngineClient,
  type DockerEngineClientOptions,
  type ListContainersOptions,
  type CreateContainerResponse,
  type StreamContainerEventsOptions,
} from './services/docker-engine-client.js';
export {
  type EngineEvent,
  DockerEngineError,
  DockerDaemonUnavailableError,
} from './services/docker-engine-types.js';
export {
  type WorkerReplica,
  computeProjectName,
  enumerateWorkers,
} from './services/worker-enumeration.js';
