/**
 * Cloud API client for `generacy launch`.
 *
 * Fetches the launch configuration for a given claim code from the
 * Generacy cloud API. Supports stub mode via `GENERACY_LAUNCH_STUB=1`
 * for local development without a real cloud backend.
 */
import http from 'node:http';
import https from 'node:https';
import { LaunchConfigSchema, type LaunchConfig } from './types.js';
import { CloudError, redactClaimUrl, sanitizeBody } from './cloud-error.js';

/**
 * Hardcoded fixture returned when `GENERACY_LAUNCH_STUB=1` is set.
 */
const STUB_LAUNCH_CONFIG: LaunchConfig = {
  projectId: 'proj_stub001',
  projectName: 'stub-project',
  variant: 'cluster-base',
  cloudUrl: 'http://localhost:3000',
  clusterId: 'cluster_stub001',
  imageTag: 'ghcr.io/generacy-ai/cluster-base:dev',
  orgId: 'org_stub001',
  repos: { primary: 'generacy-ai/example-project' },
};

/**
 * Fetch a launch configuration from the Generacy cloud API.
 *
 * Sends a GET request to `{cloudUrl}/api/clusters/launch-config?claim={claimCode}`
 * and validates the response against {@link LaunchConfigSchema}.
 *
 * When the environment variable `GENERACY_LAUNCH_STUB` is set to `"1"`, the
 * function returns a hardcoded fixture without making any HTTP request.
 *
 * @param cloudUrl  - Base URL of the Generacy cloud (e.g. `https://api.generacy.ai`).
 * @param claimCode - Claim code issued by the cloud dashboard.
 * @returns The validated launch configuration.
 *
 * @throws {CloudError} Status-code-specific message on 4xx responses.
 * @throws {Error} "Could not reach Generacy cloud" on network errors.
 * @throws {Error} "Invalid response from cloud" on malformed JSON or schema validation failure.
 */
export async function fetchLaunchConfig(
  cloudUrl: string,
  claimCode: string,
): Promise<LaunchConfig> {
  // ── Stub mode ───────────────────────────────────────────────────────
  if (process.env['GENERACY_LAUNCH_STUB'] === '1') {
    return STUB_LAUNCH_CONFIG;
  }

  // ── Build URL ───────────────────────────────────────────────────────
  const url = new URL('/api/clusters/launch-config', cloudUrl);
  url.searchParams.set('claim', claimCode);

  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  // ── Send GET request ────────────────────────────────────────────────
  const raw = await new Promise<{ status: number; body: string; retryAfter?: string }>((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const retryAfterHeader = res.headers['retry-after'];
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            retryAfter: typeof retryAfterHeader === 'string' ? retryAfterHeader : undefined,
          });
        });
      },
    );

    req.on('error', () => {
      reject(new Error('Could not reach Generacy cloud'));
    });

    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error('Could not reach Generacy cloud'));
    });

    req.end();
  });

  // ── Handle 4xx ──────────────────────────────────────────────────────
  if (raw.status >= 400 && raw.status < 500) {
    const redactedUrl = redactClaimUrl(url.toString());

    // Best-effort JSON parse for RFC 7807 fields
    let detail: string | undefined;
    let problemType: string | undefined;
    try {
      const body = JSON.parse(raw.body);
      if (typeof body.detail === 'string') detail = body.detail;
      if (typeof body.type === 'string') problemType = body.type;
    } catch {
      // Not JSON — fall through to sanitizeBody fallback
    }

    const detailOrBody = detail ?? (raw.body ? sanitizeBody(raw.body) : undefined);

    let message: string;
    switch (raw.status) {
      case 400:
        message = detail
          ? `The cloud rejected the claim format (${raw.status}: ${detail} from ${redactedUrl}). Generate a fresh claim from your project page.`
          : `The cloud rejected the claim format (${raw.status} from ${redactedUrl}). Generate a fresh claim from your project page.`;
        break;
      case 401:
      case 403:
        message = `The cloud rejected this request as unauthenticated (${raw.status} from ${redactedUrl}). The claim endpoint should be public — this likely means the cloud is misconfigured. Report this with the URL above.`;
        break;
      case 404:
        message = `The claim was not found at ${redactedUrl}. Did you mint the claim in a different environment? Set GENERACY_CLOUD_URL to the cloud where the claim was minted.`;
        break;
      case 410:
        message = 'Claim has been consumed or expired (one-time-use, 10-min TTL). Generate a fresh claim from your project page.';
        break;
      case 429:
        message = raw.retryAfter
          ? `Rate-limited by the cloud (Retry-After: ${raw.retryAfter}). Wait and retry.`
          : 'Rate-limited by the cloud. Wait and retry.';
        break;
      default:
        message = detailOrBody
          ? `Cloud returned ${raw.status} (${detailOrBody} from ${redactedUrl}). Report this if it persists.`
          : `Cloud returned ${raw.status} from ${redactedUrl}. Report this if it persists.`;
        break;
    }

    throw new CloudError({
      statusCode: raw.status,
      url: redactedUrl,
      message,
      detail,
      retryAfter: raw.retryAfter,
      problemType,
    });
  }

  // ── Handle other non-2xx ────────────────────────────────────────────
  if (raw.status < 200 || raw.status >= 300) {
    throw new Error('Could not reach Generacy cloud');
  }

  // ── Parse JSON ──────────────────────────────────────────────────────
  let data: unknown;
  try {
    data = JSON.parse(raw.body);
  } catch {
    throw new Error('Invalid response from cloud');
  }

  // ── Validate schema ─────────────────────────────────────────────────
  const result = LaunchConfigSchema.safeParse(data);
  if (!result.success) {
    throw new Error('Invalid response from cloud');
  }

  return result.data;
}
