import type { HttpClient, PollResponse, ActivationLogger } from './types.js';
import { pollDeviceCode } from './client.js';

const SLOW_DOWN_INCREMENT_MS = 5_000;
const MAX_INTERVAL_MS = 60_000;

export interface PollOptions {
  cloudUrl: string;
  deviceCode: string;
  interval: number; // seconds
  expiresIn: number; // seconds
  httpClient: HttpClient;
  logger: ActivationLogger;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll for device code approval. Handles `slow_down` and `expired` statuses.
 * Returns the final PollResponse (either 'approved' or 'expired').
 */
export async function pollForApproval(options: PollOptions): Promise<PollResponse> {
  const { cloudUrl, deviceCode, expiresIn, httpClient, logger } = options;

  let intervalMs = options.interval * 1000;
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    if (Date.now() >= deadline) {
      return { status: 'expired' };
    }

    const response = await pollDeviceCode(cloudUrl, deviceCode, httpClient);

    switch (response.status) {
      case 'approved':
        return response;
      case 'expired':
        return response;
      case 'slow_down':
        intervalMs = Math.min(intervalMs + SLOW_DOWN_INCREMENT_MS, MAX_INTERVAL_MS);
        logger.info(`Poll interval increased to ${intervalMs / 1000}s`);
        break;
      case 'authorization_pending':
        // Continue polling
        break;
    }
  }

  return { status: 'expired' };
}
