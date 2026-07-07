import type { FastifyBaseLogger } from 'fastify';
import { PostActivationRetryService } from './post-activation-retry.js';
import { BootResumeService } from './boot-resume-service.js';

export type DispatchOutcome = 'retry' | 'resume' | 'noop';

export interface DispatchOptions {
  logger: FastifyBaseLogger;
  sendRelayEvent?: (channel: string, payload: unknown) => void;

  retryServiceFactory?: (deps: {
    logger: FastifyBaseLogger;
    sendRelayEvent?: (channel: string, payload: unknown) => void;
  }) => PostActivationRetryService;
  resumeServiceFactory?: (deps: {
    logger: FastifyBaseLogger;
    sendRelayEvent?: (channel: string, payload: unknown) => void;
  }) => BootResumeService;
}

const defaultRetryFactory = (deps: {
  logger: FastifyBaseLogger;
  sendRelayEvent?: (channel: string, payload: unknown) => void;
}): PostActivationRetryService => new PostActivationRetryService(deps);

const defaultResumeFactory = (deps: {
  logger: FastifyBaseLogger;
  sendRelayEvent?: (channel: string, payload: unknown) => void;
}): BootResumeService => new BootResumeService(deps);

export async function runPostActivationBranch(opts: DispatchOptions): Promise<DispatchOutcome> {
  const retryService = (opts.retryServiceFactory ?? defaultRetryFactory)({
    logger: opts.logger,
    sendRelayEvent: opts.sendRelayEvent,
  });

  const state = retryService.checkPostActivationState();

  if (state.needsRetry) {
    opts.logger.info('Post-activation incomplete on restart — triggering retry');
    retryService.triggerPostActivationRetry().catch((err) => {
      opts.logger.error({ err }, 'Post-activation retry failed');
    });
    return 'retry';
  }

  if (state.activated && state.postActivationComplete) {
    const resumeService = (opts.resumeServiceFactory ?? defaultResumeFactory)({
      logger: opts.logger,
      sendRelayEvent: opts.sendRelayEvent,
    });
    resumeService.triggerBootResume().catch((err) => {
      opts.logger.error({ err }, 'Boot resume failed');
    });
    return 'resume';
  }

  return 'noop';
}
