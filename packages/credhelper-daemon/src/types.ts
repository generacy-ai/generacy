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
} from '@generacy-ai/credhelper';

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
  /** @default 30000 */
  sweepIntervalMs: number;
  /** @default true */
  enablePeerCred: boolean;
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
};
