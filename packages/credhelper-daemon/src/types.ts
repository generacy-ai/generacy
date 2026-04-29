import type * as http from 'node:http';

import type {
  Secret,
  ExposureKind,
  ExposureConfig,
  ExposureOutput,
  CredentialTypePlugin,
  MintContext,
  ResolveContext,
  BeginSessionRequest,
  BeginSessionResponse,
  EndSessionRequest,
  RoleConfig,
  CredentialEntry,
  BackendEntry,
  PluginExposureData,
  DockerRule,
} from '@generacy-ai/credhelper';
import type { BackendClientFactory } from './backends/types.js';

/** Upstream Docker socket info, detected at boot time. */
export interface UpstreamDockerSocket {
  socketPath: string;
  isHost: boolean;
}

/** Main configuration for the daemon. */
export interface DaemonConfig {
  /** @default '/run/generacy-credhelper/control.sock' */
  controlSocketPath: string;
  /** @default '/run/generacy-credhelper/sessions' */
  sessionsDir: string;
  /** @default 1000 */
  workerUid: number;
  /** @default 1000 */
  workerGid: number;
  /** @default 1002 */
  daemonUid: number;
  configLoader: ConfigLoader;
  pluginRegistry: PluginRegistry;
  backendFactory: BackendClientFactory;
  /** @default 30000 */
  sweepIntervalMs: number;
  /** @default true */
  enablePeerCred: boolean;
  /** Detected upstream Docker socket. Set at boot by Daemon.start(). */
  upstreamDockerSocket?: UpstreamDockerSocket;
  /** @default '/var/lib/generacy/scratch' */
  scratchBaseDir?: string;
}

/** Adapter interface for loading configuration objects (for #462). */
export interface ConfigLoader {
  loadRole(roleId: string): Promise<RoleConfig>;
  loadCredential(credentialId: string): Promise<CredentialEntry>;
  loadBackend(backendId: string): Promise<BackendEntry>;
}

/** Adapter interface for resolving credential-type plugins (for #460). */
export interface PluginRegistry {
  getPlugin(credentialType: string): CredentialTypePlugin;
}

/** Compiled internal representation of a DockerRule for efficient matching. */
export interface CompiledDockerRule {
  /** Original rule for error messages */
  original: DockerRule;
  /** HTTP method (uppercased) */
  method: string;
  /** Compiled regex from path template */
  pathRegex: RegExp;
  /** Whether the path template contains {id} */
  hasId: boolean;
  /** Compiled glob matcher for container name, or null if no name filter */
  nameMatcher: ((name: string) => boolean) | null;
}

/** Result of matching a request against the allowlist. */
export type AllowlistMatchResult =
  | { allowed: true; rule: DockerRule; containerId?: string }
  | { allowed: false; reason: string };

/** In-memory cache entry for container ID → name resolution. */
export interface ContainerNameCacheEntry {
  name: string;
  resolvedAt: number;
}

/** Configuration for a single docker proxy instance. */
export interface DockerProxyConfig {
  sessionId: string;
  sessionDir: string;
  rules: DockerRule[];
  upstreamSocket: string;
  /** Whether the upstream is the host Docker socket (DooD, not DinD) */
  upstreamIsHost: boolean;
  /** Per-session scratch directory for bind-mount validation (host-socket mode) */
  scratchDir?: string;
}

/** Interface for the DockerProxy lifecycle object stored in session state. */
export interface DockerProxyHandle {
  stop(): Promise<void>;
}

/** Interface for the LocalhostProxy lifecycle object stored in session state. */
export interface LocalhostProxyHandle {
  stop(): Promise<void>;
}

/** Tracks an active credential session. */
export interface SessionState {
  sessionId: string;
  roleId: string;
  sessionDir: string;
  expiresAt: Date;
  createdAt: Date;
  dataServer: http.Server;
  dataSocketPath: string;
  credentialIds: string[];
  /** Docker socket proxy, if the role uses docker-socket-proxy exposure */
  dockerProxy?: DockerProxyHandle;
  /** Localhost proxy handles, if the role uses localhost-proxy exposure */
  localhostProxies?: LocalhostProxyHandle[];
  /** Per-session scratch directory for bind-mount isolation */
  scratchDir?: string;
}

/** In-memory credential storage entry. */
export interface CredentialCacheEntry {
  value: Secret;
  expiresAt: Date;
  available: boolean;
  credentialType: string;
  mintContext?: MintContext;
}

/** Peer credentials obtained from SO_PEERCRED. */
export interface PeerCredentials {
  pid: number;
  uid: number;
  gid: number;
}

// Re-export imported types for downstream convenience.
export type {
  Secret,
  ExposureKind,
  ExposureConfig,
  ExposureOutput,
  CredentialTypePlugin,
  MintContext,
  ResolveContext,
  BeginSessionRequest,
  BeginSessionResponse,
  EndSessionRequest,
  RoleConfig,
  CredentialEntry,
  BackendEntry,
  PluginExposureData,
  DockerRule,
};
