import http from 'node:http';
import https from 'node:https';
import { DeployError } from './types.js';
import { getLogger } from '../../utils/logger.js';

const INITIAL_INTERVAL_MS = 3000;
const MAX_INTERVAL_MS = 15000;
const BACKOFF_FACTOR = 1.5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchClusterStatus(
  cloudUrl: string,
  clusterId: string,
  apiKey: string,
): Promise<string> {
  const url = new URL(`/api/clusters/${clusterId}/status`, cloudUrl);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise<string>((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { status?: string };
            resolve(data.status ?? 'unknown');
          } catch {
            resolve('unknown');
          }
        });
      },
    );

    req.on('error', () => reject(new Error('Cloud status check failed')));
    req.setTimeout(10_000, () => {
      req.destroy();
      reject(new Error('Cloud status check timed out'));
    });
    req.end();
  });
}

/**
 * Poll cloud cluster status until 'connected' or timeout.
 */
export async function pollClusterStatus(
  cloudUrl: string,
  clusterId: string,
  apiKey: string,
  timeoutMs: number,
): Promise<void> {
  const logger = getLogger();
  const deadline = Date.now() + timeoutMs;
  let interval = INITIAL_INTERVAL_MS;

  while (Date.now() < deadline) {
    await sleep(interval);

    try {
      const status = await fetchClusterStatus(cloudUrl, clusterId, apiKey);
      logger.info(`Cluster status: ${status}`);

      if (status === 'connected') {
        return;
      }
    } catch (error) {
      logger.warn(`Status check failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    interval = Math.min(interval * BACKOFF_FACTOR, MAX_INTERVAL_MS);
  }

  throw new DeployError(
    `Cluster did not register within ${Math.round(timeoutMs / 1000)}s. ` +
    `Check status with: generacy status --cluster=${clusterId}`,
    'REGISTRATION_TIMEOUT',
  );
}
