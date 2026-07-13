import { describe, it, expect, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { runPostActivationBranch } from '../services/post-activation-dispatch.js';
import type { PostActivationRetryService, PostActivationState } from '../services/post-activation-retry.js';
import type { BootResumeService } from '../services/boot-resume-service.js';

function createMockLogger(): FastifyBaseLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => createMockLogger()),
    level: 'info',
    silent: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

function makeRetryFactory(state: PostActivationState, triggerImpl?: () => Promise<void>) {
  const triggerPostActivationRetry = vi.fn(triggerImpl ?? (() => Promise.resolve()));
  const checkPostActivationState = vi.fn(() => state);
  const factory = vi.fn(() =>
    ({
      checkPostActivationState,
      triggerPostActivationRetry,
    }) as unknown as PostActivationRetryService,
  );
  return { factory, triggerPostActivationRetry, checkPostActivationState };
}

function makeResumeFactory(triggerImpl?: () => Promise<void>) {
  const triggerBootResume = vi.fn(triggerImpl ?? (() => Promise.resolve()));
  const factory = vi.fn(() =>
    ({
      triggerBootResume,
    }) as unknown as BootResumeService,
  );
  return { factory, triggerBootResume };
}

describe('runPostActivationBranch', () => {
  it('returns retry and dispatches triggerPostActivationRetry when needsRetry', async () => {
    const logger = createMockLogger();
    const retry = makeRetryFactory({
      activated: true,
      postActivationComplete: false,
      needsRetry: true,
    });
    const resume = makeResumeFactory();

    const outcome = await runPostActivationBranch({
      logger,
      retryServiceFactory: retry.factory,
      resumeServiceFactory: resume.factory,
    });

    expect(outcome).toBe('retry');
    expect(retry.triggerPostActivationRetry).toHaveBeenCalledTimes(1);
    expect(resume.triggerBootResume).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Post-activation incomplete on restart — triggering retry',
    );
  });

  it('returns resume and dispatches triggerBootResume when activated + complete', async () => {
    const logger = createMockLogger();
    const retry = makeRetryFactory({
      activated: true,
      postActivationComplete: true,
      needsRetry: false,
    });
    const resume = makeResumeFactory();

    const outcome = await runPostActivationBranch({
      logger,
      retryServiceFactory: retry.factory,
      resumeServiceFactory: resume.factory,
    });

    expect(outcome).toBe('resume');
    expect(resume.triggerBootResume).toHaveBeenCalledTimes(1);
    expect(retry.triggerPostActivationRetry).not.toHaveBeenCalled();
  });

  it('returns noop and dispatches nothing when !activated', async () => {
    const logger = createMockLogger();
    const retry = makeRetryFactory({
      activated: false,
      postActivationComplete: false,
      needsRetry: false,
    });
    const resume = makeResumeFactory();

    const outcome = await runPostActivationBranch({
      logger,
      retryServiceFactory: retry.factory,
      resumeServiceFactory: resume.factory,
    });

    expect(outcome).toBe('noop');
    expect(retry.triggerPostActivationRetry).not.toHaveBeenCalled();
    expect(resume.triggerBootResume).not.toHaveBeenCalled();
    expect(resume.factory).not.toHaveBeenCalled();
  });

  it('catches and logs triggerPostActivationRetry rejection; still returns retry', async () => {
    const logger = createMockLogger();
    const err = new Error('retry boom');
    const retry = makeRetryFactory(
      { activated: true, postActivationComplete: false, needsRetry: true },
      () => Promise.reject(err),
    );
    const resume = makeResumeFactory();

    const outcome = await runPostActivationBranch({
      logger,
      retryServiceFactory: retry.factory,
      resumeServiceFactory: resume.factory,
    });

    expect(outcome).toBe('retry');
    // Let the microtask queue flush so .catch() runs
    await new Promise((r) => setImmediate(r));
    expect(logger.error).toHaveBeenCalledWith(
      { err },
      'Post-activation retry failed',
    );
  });

  it('catches and logs triggerBootResume rejection; still returns resume', async () => {
    const logger = createMockLogger();
    const err = new Error('resume boom');
    const retry = makeRetryFactory({
      activated: true,
      postActivationComplete: true,
      needsRetry: false,
    });
    const resume = makeResumeFactory(() => Promise.reject(err));

    const outcome = await runPostActivationBranch({
      logger,
      retryServiceFactory: retry.factory,
      resumeServiceFactory: resume.factory,
    });

    expect(outcome).toBe('resume');
    await new Promise((r) => setImmediate(r));
    expect(logger.error).toHaveBeenCalledWith(
      { err },
      'Boot resume failed',
    );
  });

  it('accepts nullable sendRelayEvent without throwing', async () => {
    const logger = createMockLogger();
    const retry = makeRetryFactory({
      activated: true,
      postActivationComplete: true,
      needsRetry: false,
    });
    const resume = makeResumeFactory();

    const outcome = await runPostActivationBranch({
      logger,
      sendRelayEvent: undefined,
      retryServiceFactory: retry.factory,
      resumeServiceFactory: resume.factory,
    });

    expect(outcome).toBe('resume');
    expect(resume.triggerBootResume).toHaveBeenCalledTimes(1);
  });
});
