import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock promptWorkerCount so the prompt-path rows don't hit real Clack.
vi.mock('../prompts.js', async () => {
  const actual = await vi.importActual<typeof import('../prompts.js')>('../prompts.js');
  return {
    ...actual,
    promptWorkerCount: vi.fn(),
  };
});

import { promptWorkerCount } from '../prompts.js';
import {
  resolveWorkerCount,
  CLI_FALLBACK_TIER_CAP,
  SUGGESTED_FROM_HOST,
} from '../worker-count-resolver.js';
import type { LaunchConfig } from '../types.js';

const baseConfig: LaunchConfig = {
  projectId: 'pj',
  projectName: 'demo',
  variant: 'cluster-base',
  cloudUrl: 'https://api.generacy.ai',
  clusterId: 'cl',
  imageTag: 'ghcr.io/generacy-ai/cluster-base:dev',
  orgId: 'org',
  repos: { primary: 'gen/demo' },
};

function withTierCap(tierCap?: number): LaunchConfig {
  return tierCap == null ? baseConfig : { ...baseConfig, tierCap };
}

beforeEach(() => {
  vi.mocked(promptWorkerCount).mockReset();
});

describe('resolveWorkerCount', () => {
  it('exports CLI_FALLBACK_TIER_CAP=8 and SUGGESTED_FROM_HOST=2', () => {
    expect(CLI_FALLBACK_TIER_CAP).toBe(8);
    expect(SUGGESTED_FROM_HOST).toBe(2);
  });

  it('row 1: flag <= cap, tierCap present, TTY — accepts', async () => {
    const r = await resolveWorkerCount({ workers: 3 }, withTierCap(4), true);
    expect(r.workerCount).toBe(3);
    expect(r.source).toBe('flag');
    expect(r.tierCapSource).toBe('launch-config');
    expect(r.warnings).toEqual([]);
    expect(promptWorkerCount).not.toHaveBeenCalled();
  });

  it('row 2: flag, tierCap absent — accepts with fallback warning', async () => {
    const r = await resolveWorkerCount({ workers: 3 }, withTierCap(), true);
    expect(r.workerCount).toBe(3);
    expect(r.source).toBe('flag');
    expect(r.tierCapSource).toBe('fallback');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/tierCap fallback/);
  });

  it('row 3: flag > cap — throws with upgrade reference', async () => {
    await expect(
      resolveWorkerCount({ workers: 100 }, withTierCap(4), true),
    ).rejects.toThrow(/exceeds tier cap of 4/);
  });

  it('row 3 (fallback): flag > fallback cap — throws referencing CLI fallback', async () => {
    await expect(
      resolveWorkerCount({ workers: 100 }, withTierCap(), true),
    ).rejects.toThrow(/CLI fallback cap/);
  });

  it('row 4: no flag, tierCap present, TTY — prompts; default = min(cap, 2)', async () => {
    vi.mocked(promptWorkerCount).mockResolvedValueOnce(3);
    const r = await resolveWorkerCount({}, withTierCap(4), true);
    expect(r.workerCount).toBe(3);
    expect(r.source).toBe('prompt');
    expect(r.tierCapSource).toBe('launch-config');
    expect(r.warnings).toEqual([]);
    expect(promptWorkerCount).toHaveBeenCalledWith(4, 2);
  });

  it('row 5: no flag, tierCap absent, TTY — prompts with fallback cap; default = 2', async () => {
    vi.mocked(promptWorkerCount).mockResolvedValueOnce(5);
    const r = await resolveWorkerCount({}, withTierCap(), true);
    expect(r.workerCount).toBe(5);
    expect(r.source).toBe('prompt');
    expect(r.tierCapSource).toBe('fallback');
    expect(r.warnings).toHaveLength(1);
    expect(promptWorkerCount).toHaveBeenCalledWith(8, 2);
  });

  it('row 6: no flag, tierCap present, no TTY — default with no-TTY warning', async () => {
    const r = await resolveWorkerCount({}, withTierCap(4), false);
    expect(r.workerCount).toBe(2);
    expect(r.source).toBe('default');
    expect(r.tierCapSource).toBe('launch-config');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/No TTY detected/);
    expect(promptWorkerCount).not.toHaveBeenCalled();
  });

  it('row 7: no flag, tierCap absent, no TTY — default with both warnings', async () => {
    const r = await resolveWorkerCount({}, withTierCap(), false);
    expect(r.workerCount).toBe(2);
    expect(r.source).toBe('default');
    expect(r.tierCapSource).toBe('fallback');
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.some((w) => /No TTY detected/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /tierCap fallback/.test(w))).toBe(true);
  });

  it('row 8: no flag, tierCap=1, TTY — prompts with default=1', async () => {
    vi.mocked(promptWorkerCount).mockResolvedValueOnce(1);
    const r = await resolveWorkerCount({}, withTierCap(1), true);
    expect(r.workerCount).toBe(1);
    expect(r.source).toBe('prompt');
    expect(r.tierCapSource).toBe('launch-config');
    expect(promptWorkerCount).toHaveBeenCalledWith(1, 1);
  });

  it('rejects non-positive integer flag values', async () => {
    await expect(
      resolveWorkerCount({ workers: 0 }, withTierCap(4), true),
    ).rejects.toThrow(/positive integer/);
  });
});
