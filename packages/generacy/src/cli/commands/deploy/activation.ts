import {
  initDeviceFlow,
  pollForApproval,
  NativeHttpClient,
  ActivationError,
  type ActivationResult,
  type ActivationLogger,
} from '@generacy-ai/activation-client';
import { openUrl } from '../../utils/browser.js';
import { DeployError } from './types.js';

const DEFAULT_MAX_CYCLES = 3;

export interface ActivateOptions {
  cloudUrl: string;
  logger: ActivationLogger;
  maxCycles?: number;
  maxRetries?: number;
}

/**
 * Run device-flow activation for deploy.
 * Opens the verification URL in the user's browser and polls for approval.
 */
export async function runActivation(options: ActivateOptions): Promise<ActivationResult> {
  const {
    cloudUrl,
    logger,
    maxCycles = DEFAULT_MAX_CYCLES,
    maxRetries,
  } = options;

  const httpClient = new NativeHttpClient();

  try {
    for (let cycle = 1; cycle <= maxCycles; cycle++) {
      logger.info(`Requesting device code (cycle ${cycle}/${maxCycles})`);

      const deviceCode = await initDeviceFlow(cloudUrl, httpClient, logger, maxRetries);

      // Open browser for user approval
      console.log(`\nOpen this URL to approve the deployment:`);
      console.log(`  ${deviceCode.verification_uri}`);
      console.log(`\nEnter code: ${deviceCode.user_code}`);
      console.log(`Code expires in ${Math.floor(deviceCode.expires_in / 60)} minutes.\n`);

      openUrl(deviceCode.verification_uri);

      const pollResult = await pollForApproval({
        cloudUrl,
        deviceCode: deviceCode.device_code,
        interval: deviceCode.interval,
        expiresIn: deviceCode.expires_in,
        httpClient,
        logger,
      });

      if (pollResult.status === 'approved') {
        logger.info('Device-flow activation approved');
        return {
          apiKey: pollResult.cluster_api_key,
          clusterApiKeyId: pollResult.cluster_api_key_id,
          clusterId: pollResult.cluster_id,
          projectId: pollResult.project_id,
          orgId: pollResult.org_id,
        };
      }

      if (cycle < maxCycles) {
        logger.warn(`Device code expired, requesting new code (cycle ${cycle + 1}/${maxCycles})`);
      }
    }

    throw new ActivationError(
      `Activation failed: device code expired after ${maxCycles} cycles`,
      'DEVICE_CODE_EXPIRED',
    );
  } catch (error) {
    if (error instanceof DeployError) throw error;
    if (error instanceof ActivationError) {
      throw new DeployError(
        `Activation failed: ${error.message}`,
        'ACTIVATION_FAILED',
        error,
      );
    }
    throw new DeployError(
      `Activation failed: ${error instanceof Error ? error.message : String(error)}`,
      'ACTIVATION_FAILED',
      error instanceof Error ? error : undefined,
    );
  }
}
