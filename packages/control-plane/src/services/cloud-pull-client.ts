import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { CloudPullResponseSchema } from '../schemas.js';
import { GitHelperError } from '../types/git-token.js';
import type { CloudPullResponse } from '../types/git-token.js';
import type { ClusterApiKeyReader } from './cluster-api-key.js';

const DEFAULT_CLOUD_PATH = '/api/clusters/git-installation-token';

export interface CloudPullClient {
  pull(credentialId: string): Promise<CloudPullResponse>;
}

export interface CreateCloudPullClientOptions {
  apiKeyReader: ClusterApiKeyReader;
  /** Override the API URL env var name (default `GENERACY_API_URL`). Test-only knob. */
  apiUrlEnv?: string;
  /** Override the cloud endpoint path. Defaults to `/api/clusters/git-installation-token`. */
  cloudPath?: string;
  /** Log sink. Defaults to `console`. */
  logger?: { info: (obj: Record<string, unknown>) => void; warn: (obj: Record<string, unknown>) => void };
}

interface HttpOutcome {
  status: number;
  body: string;
}

function postJson(url: URL, body: string, headers: Record<string, string>): Promise<HttpOutcome> {
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(body).toString() },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export function createCloudPullClient(options: CreateCloudPullClientOptions): CloudPullClient {
  const envName = options.apiUrlEnv ?? 'GENERACY_API_URL';
  const cloudPath = options.cloudPath ?? DEFAULT_CLOUD_PATH;
  const logger = options.logger ?? {
    info: (obj) => console.log(JSON.stringify(obj)),
    warn: (obj) => console.warn(JSON.stringify(obj)),
  };

  return {
    async pull(credentialId: string): Promise<CloudPullResponse> {
      const start = Date.now();

      const apiUrlRaw = process.env[envName];
      if (!apiUrlRaw) {
        throw new GitHelperError(
          'CLOUD_UNREACHABLE',
          `${envName} is not set — cannot reach cloud on-demand pull endpoint`,
        );
      }

      // Resolve API key first so a missing key short-circuits with the right code.
      const apiKey = await options.apiKeyReader.read();

      let url: URL;
      try {
        url = new URL(cloudPath, apiUrlRaw);
      } catch (err) {
        throw new GitHelperError(
          'CLOUD_UNREACHABLE',
          `Invalid ${envName}: ${(err as Error).message}`,
        );
      }

      const headers: Record<string, string> = {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      };

      let outcome: HttpOutcome;
      try {
        outcome = await postJson(url, JSON.stringify({ credentialId }), headers);
      } catch (err) {
        const cause = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
        logger.warn({
          event: 'git-token-cloud-pull',
          result: 'error',
          errorCode: 'CLOUD_UNREACHABLE',
          durationMs: Date.now() - start,
        });
        throw new GitHelperError(
          'CLOUD_UNREACHABLE',
          `Cloud on-demand pull endpoint unreachable (${cause})`,
          { cause },
        );
      }

      if (outcome.status === 401 || outcome.status === 403) {
        logger.warn({
          event: 'git-token-cloud-pull',
          result: 'error',
          errorCode: 'CLOUD_AUTH_REJECTED',
          httpStatus: outcome.status,
          durationMs: Date.now() - start,
        });
        throw new GitHelperError(
          'CLOUD_AUTH_REJECTED',
          `Cloud rejected cluster API key (HTTP ${outcome.status})`,
          { httpStatus: outcome.status },
        );
      }
      if (outcome.status >= 400 && outcome.status < 500) {
        logger.warn({
          event: 'git-token-cloud-pull',
          result: 'error',
          errorCode: 'CLOUD_REQUEST_INVALID',
          httpStatus: outcome.status,
          durationMs: Date.now() - start,
        });
        throw new GitHelperError(
          'CLOUD_REQUEST_INVALID',
          `Cloud returned ${outcome.status} for git-token request`,
          { httpStatus: outcome.status },
        );
      }
      if (outcome.status >= 500) {
        logger.warn({
          event: 'git-token-cloud-pull',
          result: 'error',
          errorCode: 'CLOUD_UPSTREAM_ERROR',
          httpStatus: outcome.status,
          durationMs: Date.now() - start,
        });
        throw new GitHelperError(
          'CLOUD_UPSTREAM_ERROR',
          `Cloud upstream error (HTTP ${outcome.status})`,
          { httpStatus: outcome.status },
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(outcome.body);
      } catch {
        logger.warn({
          event: 'git-token-cloud-pull',
          result: 'error',
          errorCode: 'CLOUD_RESPONSE_INVALID',
          httpStatus: outcome.status,
          durationMs: Date.now() - start,
        });
        throw new GitHelperError(
          'CLOUD_RESPONSE_INVALID',
          'Cloud returned a non-JSON body',
        );
      }
      const result = CloudPullResponseSchema.safeParse(parsed);
      if (!result.success) {
        logger.warn({
          event: 'git-token-cloud-pull',
          result: 'error',
          errorCode: 'CLOUD_RESPONSE_INVALID',
          httpStatus: outcome.status,
          durationMs: Date.now() - start,
        });
        throw new GitHelperError(
          'CLOUD_RESPONSE_INVALID',
          'Cloud response did not match expected schema',
          { issues: result.error.issues },
        );
      }
      const expiresAtMs = Date.parse(result.data.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        logger.warn({
          event: 'git-token-cloud-pull',
          result: 'error',
          errorCode: 'CLOUD_RESPONSE_INVALID',
          httpStatus: outcome.status,
          durationMs: Date.now() - start,
        });
        throw new GitHelperError(
          'CLOUD_RESPONSE_INVALID',
          'Cloud returned an already-past expiresAt',
        );
      }

      logger.info({
        event: 'git-token-cloud-pull',
        result: 'ok',
        httpStatus: outcome.status,
        durationMs: Date.now() - start,
      });

      return { token: result.data.token, expiresAt: result.data.expiresAt };
    },
  };
}
