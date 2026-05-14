import type { ActivationOptions, ActivationResult } from './types.js';
import { NativeHttpClient, requestDeviceCode } from './client.js';
import { pollForApproval } from './poller.js';
import { readKeyFile, writeKeyFile, readClusterJson, writeClusterJson } from './persistence.js';
import { ActivationError } from './errors.js';

export type { ActivationOptions, ActivationResult } from './types.js';
export { ActivationError } from './errors.js';
export type { ActivationErrorCode } from './errors.js';

const DEFAULT_MAX_CYCLES = 3;

export function buildActivationUrl(verificationUri: string, userCode: string): string {
  const url = new URL(verificationUri);
  url.searchParams.set('code', userCode);
  const projectId = process.env['GENERACY_PROJECT_ID'];
  if (projectId) {
    url.searchParams.set('projectId', projectId);
  }
  return url.toString();
}

/**
 * Activate the cluster via device-code flow.
 *
 * - If key file exists: reads and returns existing key + metadata
 * - If key file absent: runs device-code flow, persists, returns result
 * - Throws ActivationError on unrecoverable failure
 */
export async function activate(options: ActivationOptions): Promise<ActivationResult> {
  const {
    cloudUrl,
    keyFilePath,
    clusterJsonPath,
    logger,
    maxCycles = DEFAULT_MAX_CYCLES,
    maxRetries,
    httpClient: injectedClient,
  } = options;

  const httpClient = injectedClient ?? new NativeHttpClient();

  // Check for existing key
  logger.info('Checking for existing cluster API key');
  const existingKey = await readKeyFile(keyFilePath);
  if (existingKey) {
    logger.info('Existing cluster API key found, skipping activation');
    const metadata = await readClusterJson(clusterJsonPath);
    return {
      apiKey: existingKey,
      clusterApiKeyId: undefined,
      clusterId: metadata?.cluster_id ?? 'unknown',
      projectId: metadata?.project_id ?? 'unknown',
      orgId: metadata?.org_id ?? 'unknown',
      cloudUrl: metadata?.cloud_url,
    };
  }

  // Run device-code flow
  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    logger.info(`Requesting device code (cycle ${cycle}/${maxCycles})`);

    const deviceCode = await requestDeviceCode(cloudUrl, httpClient, logger, maxRetries);

    // Print activation instructions
    logger.info(
      `\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `  Cluster Activation Required\n` +
      `\n` +
      `  Go to: ${buildActivationUrl(deviceCode.verification_uri, deviceCode.user_code)}\n` +
      `  Enter code: ${deviceCode.user_code}\n` +
      `\n` +
      `  Code expires in ${Math.floor(deviceCode.expires_in / 60)} minutes.\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    );

    const pollResult = await pollForApproval({
      cloudUrl,
      deviceCode: deviceCode.device_code,
      interval: deviceCode.interval,
      expiresIn: deviceCode.expires_in,
      httpClient,
      logger,
    });

    if (pollResult.status === 'approved') {
      // Persist key and metadata
      await writeKeyFile(keyFilePath, pollResult.cluster_api_key);
      await writeClusterJson(clusterJsonPath, {
        cluster_id: pollResult.cluster_id,
        project_id: pollResult.project_id,
        org_id: pollResult.org_id,
        cloud_url: pollResult.cloud_url,
        activated_at: new Date().toISOString(),
      });

      logger.info('Cluster activated successfully');

      return {
        apiKey: pollResult.cluster_api_key,
        clusterApiKeyId: pollResult.cluster_api_key_id,
        clusterId: pollResult.cluster_id,
        projectId: pollResult.project_id,
        orgId: pollResult.org_id,
        cloudUrl: pollResult.cloud_url,
      };
    }

    // Device code expired
    if (cycle < maxCycles) {
      logger.warn(`Device code expired, requesting new code (cycle ${cycle + 1}/${maxCycles})`);
    }
  }

  throw new ActivationError(
    `Activation failed: device code expired after ${maxCycles} cycles`,
    'DEVICE_CODE_EXPIRED',
  );
}
