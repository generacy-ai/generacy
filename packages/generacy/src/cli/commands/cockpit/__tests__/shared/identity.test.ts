import { describe, it, expect, vi } from 'vitest';
import {
  LoudIdentityError,
  resolveCockpitIdentity,
  type IdentitySource,
} from '../../shared/identity.js';

function makeGh(getCurrentUser?: () => Promise<string>) {
  return {
    getCurrentUser: vi.fn(
      getCurrentUser ?? (() => Promise.reject(new Error('gh unavailable'))),
    ),
  };
}

function makeLogger() {
  return {
    warn: vi.fn<(msg: string) => void>(),
    info: vi.fn<(msg: string) => void>(),
  };
}

const FOUR_KNOBS = [
  '--assignee',
  'cockpit.assignee',
  'CLUSTER_GITHUB_USERNAME',
  'GH_USERNAME',
];

describe('resolveCockpitIdentity — precedence table (SC-006)', () => {
  it('flag beats all', async () => {
    const gh = makeGh(() => Promise.resolve('eve'));
    const logger = makeLogger();
    const result = await resolveCockpitIdentity({
      flag: 'alice',
      configAssignee: 'bob',
      gh,
      logger,
      verb: 'test',
      mode: 'required',
      env: { CLUSTER_GITHUB_USERNAME: 'charlie', GH_USERNAME: 'dave' },
    });
    expect(result).toEqual({ login: 'alice', source: 'flag' satisfies IdentitySource });
    expect(gh.getCurrentUser).not.toHaveBeenCalled();
  });

  it('config beats env', async () => {
    const gh = makeGh(() => Promise.resolve('eve'));
    const logger = makeLogger();
    const result = await resolveCockpitIdentity({
      configAssignee: 'bob',
      gh,
      logger,
      verb: 'test',
      mode: 'required',
      env: { CLUSTER_GITHUB_USERNAME: 'charlie', GH_USERNAME: 'dave' },
    });
    expect(result).toEqual({ login: 'bob', source: 'config' satisfies IdentitySource });
    expect(gh.getCurrentUser).not.toHaveBeenCalled();
  });

  it('CLUSTER_GITHUB_USERNAME beats GH_USERNAME', async () => {
    const gh = makeGh(() => Promise.resolve('eve'));
    const logger = makeLogger();
    const result = await resolveCockpitIdentity({
      gh,
      logger,
      verb: 'test',
      mode: 'required',
      env: { CLUSTER_GITHUB_USERNAME: 'charlie', GH_USERNAME: 'dave' },
    });
    expect(result).toEqual({
      login: 'charlie',
      source: 'CLUSTER_GITHUB_USERNAME' satisfies IdentitySource,
    });
    expect(gh.getCurrentUser).not.toHaveBeenCalled();
  });

  it('GH_USERNAME beats gh-api', async () => {
    const gh = makeGh(() => Promise.resolve('eve'));
    const logger = makeLogger();
    const result = await resolveCockpitIdentity({
      gh,
      logger,
      verb: 'test',
      mode: 'required',
      env: { GH_USERNAME: 'dave' },
    });
    expect(result).toEqual({
      login: 'dave',
      source: 'GH_USERNAME' satisfies IdentitySource,
    });
    expect(gh.getCurrentUser).not.toHaveBeenCalled();
  });

  it('gh-api resolves when all earlier tiers miss', async () => {
    const gh = makeGh(() => Promise.resolve('eve'));
    const logger = makeLogger();
    const result = await resolveCockpitIdentity({
      gh,
      logger,
      verb: 'test',
      mode: 'required',
      env: {},
    });
    expect(result).toEqual({
      login: 'eve',
      source: 'gh-api' satisfies IdentitySource,
    });
    expect(gh.getCurrentUser).toHaveBeenCalledTimes(1);
  });

  it('all miss, mode required → throws LoudIdentityError with all four knobs', async () => {
    const gh = makeGh();
    const logger = makeLogger();
    await expect(
      resolveCockpitIdentity({
        gh,
        logger,
        verb: 'queue',
        mode: 'required',
        env: {},
      }),
    ).rejects.toBeInstanceOf(LoudIdentityError);

    let caught: unknown;
    try {
      await resolveCockpitIdentity({
        gh,
        logger,
        verb: 'queue',
        mode: 'required',
        env: {},
      });
    } catch (err) {
      caught = err;
    }
    const err = caught as LoudIdentityError;
    expect(err.code).toBe('IDENTITY_UNRESOLVED');
    expect(err.verb).toBe('queue');
    for (const knob of FOUR_KNOBS) {
      expect(err.message).toContain(knob);
    }
  });

  it('all miss, mode optional → returns source: none and warns with all four knobs', async () => {
    const gh = makeGh();
    const logger = makeLogger();
    const result = await resolveCockpitIdentity({
      gh,
      logger,
      verb: 'advance',
      mode: 'optional',
      env: {},
    });
    expect(result).toEqual({ login: undefined, source: 'none' satisfies IdentitySource });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warnMsg = logger.warn.mock.calls[0]?.[0] ?? '';
    expect(warnMsg.startsWith('warning: ')).toBe(true);
    for (const knob of FOUR_KNOBS) {
      expect(warnMsg).toContain(knob);
    }
  });
});

describe('resolveCockpitIdentity — env source treats empty string as missing', () => {
  it('empty CLUSTER_GITHUB_USERNAME falls through to GH_USERNAME', async () => {
    const gh = makeGh();
    const logger = makeLogger();
    const result = await resolveCockpitIdentity({
      gh,
      logger,
      verb: 'test',
      mode: 'required',
      env: { CLUSTER_GITHUB_USERNAME: '', GH_USERNAME: 'dave' },
    });
    expect(result.source).toBe('GH_USERNAME');
  });
});
