import path from 'node:path';

import type { PluginExposureData } from '@generacy-ai/credhelper';
import { CredhelperError } from './errors.js';
import { mkdirSafe, writeFileSafe } from './util/fs.js';

/**
 * Renders credential exposure files into a session directory.
 * Accepts PluginExposureData from plugins and wraps with session infrastructure.
 * Phase 3 exposure types (localhost-proxy, docker-socket-proxy) throw NOT_IMPLEMENTED.
 */
export class ExposureRenderer {
  /** Create the session directory tree with correct modes. */
  async renderSessionDir(sessionDir: string): Promise<void> {
    await mkdirSafe(sessionDir, 0o750);
  }

  /** Write a sourceable env file with KEY=VALUE lines, mode 0640. */
  async renderEnv(
    sessionDir: string,
    entries: Array<{ key: string; value: string }>,
  ): Promise<void> {
    const content = entries.map((e) => `${e.key}=${e.value}\n`).join('');
    await writeFileSafe(path.join(sessionDir, 'env'), content, 0o640);
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
        this.renderLocalhostProxy();
        break;
    }
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

  /** Phase 3 stub — localhost proxy is not yet implemented. */
  renderLocalhostProxy(): never {
    throw new CredhelperError(
      'NOT_IMPLEMENTED',
      'localhost-proxy exposure is not yet implemented (Phase 3)',
    );
  }

  /** Phase 3 stub — Docker socket proxy is not yet implemented. */
  renderDockerSocketProxy(): never {
    throw new CredhelperError(
      'NOT_IMPLEMENTED',
      'docker-socket-proxy exposure is not yet implemented (Phase 3)',
    );
  }
}
