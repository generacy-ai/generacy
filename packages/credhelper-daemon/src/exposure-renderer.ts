import path from 'node:path';
import { appendFile, chmod, writeFile, rename, unlink } from 'node:fs/promises';

import type { PluginExposureData, ProxyRule } from '@generacy-ai/credhelper';
import { CredhelperError } from './errors.js';
import { mkdirSafe, writeFileSafe, chownSafe } from './util/fs.js';
import { DockerProxy } from './docker-proxy.js';
import { LocalhostProxy } from './exposure/localhost-proxy.js';
import { isPathDenied } from './file-path-denylist.js';
import type { DockerRule, DockerProxyHandle, LocalhostProxyHandle } from './types.js';

/**
 * Renders credential exposure files into a session directory.
 * Accepts PluginExposureData from plugins and wraps with session infrastructure.
 */
export class ExposureRenderer {
  /** Create the session directory tree with correct modes. */
  async renderSessionDir(sessionDir: string): Promise<void> {
    await mkdirSafe(sessionDir, 0o750);
  }

  /** Append KEY=VALUE lines to the session env file, mode 0640. */
  async renderEnv(
    sessionDir: string,
    entries: Array<{ key: string; value: string }>,
  ): Promise<void> {
    const content = entries.map((e) => `${e.key}=${e.value}\n`).join('');
    const envPath = path.join(sessionDir, 'env');
    await appendFile(envPath, content, { mode: 0o640 });
    await chmod(envPath, 0o640);
  }

  /**
   * Dispatch PluginExposureData from a plugin to the appropriate renderer.
   * This is the primary entry point for rendering plugin exposure output.
   */
  async renderPluginExposure(
    sessionDir: string,
    dataSocketPath: string,
    credentialId: string,
    data: PluginExposureData,
  ): Promise<void> {
    switch (data.kind) {
      case 'env':
        await this.renderEnv(sessionDir, data.entries);
        break;
      case 'git-credential-helper':
        await this.renderGitCredentialHelper(sessionDir, dataSocketPath, data);
        break;
      case 'gcloud-external-account':
        await this.renderGcloudExternalAccount(sessionDir, dataSocketPath, credentialId, data);
        break;
      case 'localhost-proxy':
        // localhost-proxy is handled directly by SessionManager, which
        // calls renderLocalhostProxy with the role's proxy config.
        break;
      case 'file':
        await this.renderFileExposure(data.path, data.data, data.mode);
        break;
    }
  }

  /** Paths of files written by renderFileExposure, tracked for cleanup. */
  private readonly sessionFilePaths = new Map<string, string[]>();

  /** Track a file written by renderFileExposure for session cleanup. */
  trackFileForSession(sessionId: string, filePath: string): void {
    const existing = this.sessionFilePaths.get(sessionId) ?? [];
    existing.push(filePath);
    this.sessionFilePaths.set(sessionId, existing);
  }

  /** Clean up all session-scoped files written by renderFileExposure. */
  async cleanupSessionFiles(sessionId: string): Promise<void> {
    const paths = this.sessionFilePaths.get(sessionId);
    if (!paths) return;
    for (const p of paths) {
      try {
        await unlink(p);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`[credhelper] Failed to clean session file ${p}:`, (err as Error).message);
        }
      }
    }
    this.sessionFilePaths.delete(sessionId);
  }

  /**
   * Write a credential blob to an absolute path with denylist validation.
   * Uses atomic temp+rename. Default mode 0o640.
   */
  async renderFileExposure(
    targetPath: string,
    data: Buffer,
    mode?: number,
  ): Promise<void> {
    const absPath = path.resolve(targetPath);

    if (isPathDenied(absPath)) {
      throw new CredhelperError(
        'INVALID_REQUEST',
        `File exposure path '${absPath}' is in a restricted system directory`,
        { path: absPath },
      );
    }

    const fileMode = mode ?? 0o640;
    const parentDir = path.dirname(absPath);
    await mkdirSafe(parentDir, 0o750);

    // Atomic write: temp + rename
    const tmpPath = `${absPath}.tmp.${process.pid}`;
    await writeFile(tmpPath, data, { mode: fileMode });
    await chmod(tmpPath, fileMode);
    await chownSafe(tmpPath, 1002, 1000); // credhelper:node
    await rename(tmpPath, absPath);
  }

  /**
   * Write git credential helper: a git/config file and a git/credential-helper
   * script that queries the data socket via curl.
   * Accepts plugin data with host, protocol, username, password.
   */
  async renderGitCredentialHelper(
    sessionDir: string,
    dataSocketPath: string,
    pluginData?: { host: string; protocol: string; username: string; password: string },
  ): Promise<void> {
    const gitDir = path.join(sessionDir, 'git');
    await mkdirSafe(gitDir, 0o750);

    const helperScriptPath = path.join(gitDir, 'credential-helper');
    const helperScript = `#!/bin/sh
# Git credential helper — queries the credhelper data socket for fresh tokens
exec curl --silent --fail --unix-socket "${dataSocketPath}" "http://localhost/credential/git-token"
`;

    const gitConfig = `[credential]
\thelper = !${helperScriptPath}
`;

    await writeFileSafe(path.join(gitDir, 'config'), gitConfig, 0o640);
    await writeFileSafe(helperScriptPath, helperScript, 0o750);
  }

  /**
   * Write gcloud external account JSON with credential_source.url pointing
   * at the data socket. Uses plugin data for audience, token URL, etc.
   */
  async renderGcloudExternalAccount(
    sessionDir: string,
    dataSocketPath: string,
    credentialId: string,
    pluginData?: { audience: string; subjectTokenType: string; tokenUrl: string; serviceAccountImpersonationUrl?: string },
  ): Promise<void> {
    const gcpDir = path.join(sessionDir, 'gcp');
    await mkdirSafe(gcpDir, 0o750);

    const externalAccount = {
      type: 'external_account',
      audience: pluginData?.audience ?? '//iam.googleapis.com/projects/0/locations/global/workloadIdentityPools/pool/providers/provider',
      subject_token_type: pluginData?.subjectTokenType ?? 'urn:ietf:params:oauth:token-type:access_token',
      token_url: pluginData?.tokenUrl ?? 'https://sts.googleapis.com/v1/token',
      credential_source: {
        url: `http://localhost/credential/${credentialId}`,
        format: {
          type: 'json',
          subject_token_field_name: 'value',
        },
      },
      service_account_impersonation_url: pluginData?.serviceAccountImpersonationUrl,
    };

    // Remove undefined fields
    const cleaned = JSON.parse(JSON.stringify(externalAccount)) as object;

    await writeFileSafe(
      path.join(gcpDir, 'external-account.json'),
      JSON.stringify(cleaned, null, 2) + '\n',
      0o640,
    );
  }

  /**
   * Create and start a localhost reverse proxy for a credential.
   * Writes proxy config JSON for debugging/introspection, then starts the proxy.
   * Returns the proxy handle for session state tracking.
   */
  async renderLocalhostProxy(
    sessionDir: string,
    data: { upstream: string; headers: Record<string, string> },
    allowlist: ProxyRule[],
    port: number,
  ): Promise<LocalhostProxyHandle> {
    const proxyDir = path.join(sessionDir, 'proxy');
    await mkdirSafe(proxyDir, 0o750);

    // Write config for debugging/introspection (no secrets in allowlist)
    const proxyConfig = {
      upstream: data.upstream,
      port,
      allowlist,
    };

    await writeFileSafe(
      path.join(proxyDir, 'config.json'),
      JSON.stringify(proxyConfig, null, 2) + '\n',
      0o640,
    );

    const proxy = new LocalhostProxy({
      port,
      upstream: data.upstream,
      headers: data.headers,
      allowlist,
    });
    await proxy.start();
    return proxy;
  }

  /**
   * Create and start a per-session Docker socket proxy.
   * Returns the DockerProxy instance for session state tracking.
   */
  async renderDockerSocketProxy(
    sessionDir: string,
    rules: DockerRule[],
    upstreamSocket: string,
    upstreamIsHost: boolean,
    sessionId: string,
    scratchDir?: string,
  ): Promise<{ proxy: DockerProxyHandle; socketPath: string }> {
    const proxy = new DockerProxy({
      sessionId,
      sessionDir,
      rules,
      upstreamSocket,
      upstreamIsHost,
      scratchDir,
    });
    const socketPath = await proxy.start();
    return { proxy, socketPath };
  }
}
