import type {
  OrchestratorClient,
  HealthResult,
  JobsResult,
  WorkersResult,
} from './client.js';

const NO_TOKEN_RESULT = { available: false as const, reason: 'no-token' as const };

/**
 * Stub orchestrator client used when no token is available.
 * Every method resolves to `{ available: false, reason: 'no-token' }`.
 * Never throws.
 */
export function createStubOrchestratorClient(): OrchestratorClient {
  return {
    isAvailable(): boolean {
      return false;
    },
    async health(): Promise<HealthResult> {
      return NO_TOKEN_RESULT;
    },
    async getJobs(): Promise<JobsResult> {
      return NO_TOKEN_RESULT;
    },
    async getWorkers(): Promise<WorkersResult> {
      return NO_TOKEN_RESULT;
    },
  };
}
