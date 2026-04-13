import path from 'node:path';

import { CredhelperError } from './errors.js';
import { mkdirSafe, writeFileSafe } from './util/fs.js';

/**
 * Renders credential exposure files into a session directory.
 * Supports env, git-credential-helper, and gcloud-external-account.
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
   * Write git credential helper: a git/config file and a git/credential-helper
   * script that queries the data socket via curl.
   */
  async renderGitCredentialHelper(
    sessionDir: string,
    dataSocketPath: string,
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
   * at the data socket.
   */
  async renderGcloudExternalAccount(
    sessionDir: string,
    dataSocketPath: string,
    credentialId: string,
  ): Promise<void> {
    const gcpDir = path.join(sessionDir, 'gcp');
    await mkdirSafe(gcpDir, 0o750);

    const externalAccount = {
      type: 'external_account',
      audience: '//iam.googleapis.com/projects/0/locations/global/workloadIdentityPools/pool/providers/provider',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      token_url: 'https://sts.googleapis.com/v1/token',
      credential_source: {
        url: `http://localhost/credential/${credentialId}`,
        format: {
          type: 'json',
          subject_token_field_name: 'value',
        },
        // The client library will connect via the Unix socket
        // This URL is resolved over the data socket
      },
      service_account_impersonation_url: undefined,
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
