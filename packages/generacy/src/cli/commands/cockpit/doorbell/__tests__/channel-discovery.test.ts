import { describe, expect, it, vi } from 'vitest';
import type { CommandResult, CommandRunner } from '@generacy-ai/cockpit';
import { discoverChannelUrl } from '../channel-discovery.js';

const FILE_PATH = '/tmp/generacy-doorbell-test-smee-channel';
const MIRROR_PATH = '/workspaces/.generacy/cockpit/smee-channel';

/**
 * Build a path-aware fake fs.readFile. Any read whose path is a key in
 * `map` yields the mapped result (a string for success, or an object with
 * `code` for a thrown error). Unmapped paths throw ENOENT.
 */
function makeFs(map: Record<string, string | { code: string; message?: string }>): {
  readFile: (path: string | Buffer | URL, encoding: BufferEncoding) => Promise<string>;
} {
  return {
    readFile: async (path) => {
      const key = String(path);
      const val = map[key];
      if (val === undefined) {
        const err = new Error('not found') as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      }
      if (typeof val === 'string') return val;
      const err = new Error(val.message ?? val.code) as Error & { code?: string };
      err.code = val.code;
      throw err;
    },
  };
}

describe('discoverChannelUrl', () => {
  it('case 1: env override present + valid → { source: env }', async () => {
    const warn = vi.fn();
    const result = await discoverChannelUrl({
      env: { COCKPIT_DOORBELL_SMEE_URL: 'https://smee.io/abc123' },
      channelFilePath: FILE_PATH,
      fs: makeFs({}),
      logger: { warn },
      cwd: '/',
      workspaceMirrorPath: MIRROR_PATH,
    });
    expect(result).toEqual({ url: 'https://smee.io/abc123', source: 'env' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('case 2: env override present + invalid → walks fallback chain', async () => {
    const warn = vi.fn();
    const result = await discoverChannelUrl({
      env: { COCKPIT_DOORBELL_SMEE_URL: 'not-a-url' },
      channelFilePath: FILE_PATH,
      fs: makeFs({ [FILE_PATH]: 'https://smee.io/xyz789' }),
      logger: { warn },
      cwd: '/',
      workspaceMirrorPath: MIRROR_PATH,
    });
    expect(result).toEqual({ url: 'https://smee.io/xyz789', source: 'file' });
    // One warn for the env mismatch.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('case 3: walk-up hit at cwd → { source: workspace-walkup }', async () => {
    const warn = vi.fn();
    const cwd = '/workspaces/repo';
    const walkupPath = `${cwd}/.generacy/cockpit/smee-channel`;
    const result = await discoverChannelUrl({
      env: {},
      channelFilePath: FILE_PATH,
      fs: makeFs({ [walkupPath]: 'https://smee.io/walkup1' }),
      logger: { warn },
      cwd,
      workspaceMirrorPath: MIRROR_PATH,
    });
    expect(result).toEqual({ url: 'https://smee.io/walkup1', source: 'workspace-walkup' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('case 4: walk-up hit at parent → { source: workspace-walkup }', async () => {
    const warn = vi.fn();
    const cwd = '/workspaces/repo/deep/nested';
    const parentHit = '/workspaces/repo/.generacy/cockpit/smee-channel';
    const result = await discoverChannelUrl({
      env: {},
      channelFilePath: FILE_PATH,
      fs: makeFs({ [parentHit]: 'https://smee.io/walkup2\n' }),
      logger: { warn },
      cwd,
      workspaceMirrorPath: MIRROR_PATH,
    });
    expect(result).toEqual({ url: 'https://smee.io/walkup2', source: 'workspace-walkup' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('case 5: no walk-up hits + absolute-path hit → { source: workspace-absolute }', async () => {
    const warn = vi.fn();
    const cwd = '/other/tree';
    const result = await discoverChannelUrl({
      env: {},
      channelFilePath: FILE_PATH,
      fs: makeFs({ [MIRROR_PATH]: 'https://smee.io/absolute1' }),
      logger: { warn },
      cwd,
      workspaceMirrorPath: MIRROR_PATH,
    });
    expect(result).toEqual({ url: 'https://smee.io/absolute1', source: 'workspace-absolute' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('case 6: neither walk-up nor absolute-path + cluster-internal hit → { source: file }', async () => {
    const warn = vi.fn();
    const cwd = '/other/tree';
    const result = await discoverChannelUrl({
      env: {},
      channelFilePath: FILE_PATH,
      fs: makeFs({ [FILE_PATH]: 'https://smee.io/clusterInternal' }),
      logger: { warn },
      cwd,
      workspaceMirrorPath: MIRROR_PATH,
    });
    expect(result).toEqual({ url: 'https://smee.io/clusterInternal', source: 'file' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('case 7: all four stages miss → null (SC-005 no-regression smee-less)', async () => {
    const warn = vi.fn();
    const result = await discoverChannelUrl({
      env: {},
      channelFilePath: FILE_PATH,
      fs: makeFs({}),
      logger: { warn },
      cwd: '/other/tree',
      workspaceMirrorPath: MIRROR_PATH,
    });
    expect(result).toBeNull();
    // No warns for ENOENT-only misses.
    expect(warn).not.toHaveBeenCalled();
  });

  it('case 8: walk-up file exists but content malformed → warn + falls through to absolute path', async () => {
    // Use a cwd that is NOT nested under the mirror-path prefix so the
    // walk-up chain cannot accidentally hit the mirror as an ancestor.
    const warn = vi.fn();
    const cwd = '/opt/repo';
    const walkupPath = `${cwd}/.generacy/cockpit/smee-channel`;
    const result = await discoverChannelUrl({
      env: {},
      channelFilePath: FILE_PATH,
      fs: makeFs({
        [walkupPath]: 'this is not a smee url',
        [MIRROR_PATH]: 'https://smee.io/absoluteFallback',
      }),
      logger: { warn },
      cwd,
      workspaceMirrorPath: MIRROR_PATH,
    });
    expect(result).toEqual({ url: 'https://smee.io/absoluteFallback', source: 'workspace-absolute' });
    // One malformed-content warn from the walk-up stage.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('case 9: EACCES on absolute-path read → warn + falls through to cluster-internal', async () => {
    const warn = vi.fn();
    const cwd = '/other/tree';
    const result = await discoverChannelUrl({
      env: {},
      channelFilePath: FILE_PATH,
      fs: makeFs({
        [MIRROR_PATH]: { code: 'EACCES', message: 'perm denied' },
        [FILE_PATH]: 'https://smee.io/clusterFallback',
      }),
      logger: { warn },
      cwd,
      workspaceMirrorPath: MIRROR_PATH,
    });
    expect(result).toEqual({ url: 'https://smee.io/clusterFallback', source: 'file' });
    // One warn from the absolute-path EACCES.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('preserves default cwd + workspaceMirrorPath when not provided', async () => {
    // Sanity: input without cwd/workspaceMirrorPath still works — defaults
    // to process.cwd() and /workspaces/.generacy/cockpit/smee-channel.
    const warn = vi.fn();
    const result = await discoverChannelUrl({
      env: { COCKPIT_DOORBELL_SMEE_URL: 'https://smee.io/env1' },
      channelFilePath: FILE_PATH,
      fs: makeFs({}),
      logger: { warn },
    });
    expect(result).toEqual({ url: 'https://smee.io/env1', source: 'env' });
  });
});

/**
 * webhook-config stage cases (W1-W7). Exercises the new stage between env
 * and walk-up, using an in-memory CommandRunner stub.
 */
type RunnerCall = { cmd: string; args: string[] };

function makeRunner(
  responder: (call: RunnerCall) => CommandResult | Promise<CommandResult>,
): { runner: CommandRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    return responder({ cmd, args });
  };
  return { runner, calls };
}

function ok(payload: unknown): CommandResult {
  return { stdout: JSON.stringify(payload), stderr: '', exitCode: 0 };
}

function hook(overrides: {
  id: number;
  url: string;
  active?: boolean;
  updatedAt?: string;
}) {
  return {
    id: overrides.id,
    active: overrides.active ?? true,
    config: { url: overrides.url },
    updated_at: overrides.updatedAt ?? '2026-01-01T00:00:00Z',
  };
}

describe('discoverChannelUrl webhook-config stage', () => {
  it('W1: primary-target hit → { source: webhook-config }', async () => {
    const warn = vi.fn();
    const { runner, calls } = makeRunner(() =>
      ok([hook({ id: 1, url: 'https://smee.io/abc' })]),
    );
    const result = await discoverChannelUrl({
      env: {},
      channelFilePath: FILE_PATH,
      fs: makeFs({}),
      logger: { warn },
      cwd: '/other',
      workspaceMirrorPath: MIRROR_PATH,
      targets: [{ owner: 'acme', repo: 'coord' }],
      runner,
    });
    expect(result).toEqual({
      url: 'https://smee.io/abc',
      source: 'webhook-config',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cmd: 'gh',
      args: ['api', '/repos/acme/coord/hooks'],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('W2: stale + fresh tie-break → newer updated_at wins (SC-004)', async () => {
    const warn = vi.fn();
    const { runner } = makeRunner(() =>
      ok([
        hook({
          id: 1,
          url: 'https://smee.io/old',
          updatedAt: '2025-01-01T00:00:00Z',
        }),
        hook({
          id: 2,
          url: 'https://smee.io/new',
          updatedAt: '2026-06-01T00:00:00Z',
        }),
      ]),
    );
    const result = await discoverChannelUrl({
      env: {},
      channelFilePath: FILE_PATH,
      fs: makeFs({}),
      logger: { warn },
      cwd: '/other',
      workspaceMirrorPath: MIRROR_PATH,
      targets: [{ owner: 'acme', repo: 'coord' }],
      runner,
    });
    expect(result).toEqual({
      url: 'https://smee.io/new',
      source: 'webhook-config',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('W3: multi-repo primary-first → primary URL, one runner call', async () => {
    const warn = vi.fn();
    const { runner, calls } = makeRunner((c) => {
      if (c.args[1] === '/repos/acme/coord/hooks') {
        return ok([hook({ id: 1, url: 'https://smee.io/primary' })]);
      }
      return ok([hook({ id: 2, url: 'https://smee.io/sibling' })]);
    });
    const result = await discoverChannelUrl({
      env: {},
      channelFilePath: FILE_PATH,
      fs: makeFs({}),
      logger: { warn },
      cwd: '/other',
      workspaceMirrorPath: MIRROR_PATH,
      targets: [
        { owner: 'acme', repo: 'coord' },
        { owner: 'acme', repo: 'sibling' },
      ],
      runner,
    });
    expect(result).toEqual({
      url: 'https://smee.io/primary',
      source: 'webhook-config',
    });
    expect(calls).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('W4: multi-repo fallback to sibling → sibling URL, two runner calls', async () => {
    const warn = vi.fn();
    const { runner, calls } = makeRunner((c) => {
      if (c.args[1] === '/repos/acme/coord/hooks') {
        // No smee hook on primary (empty array).
        return ok([]);
      }
      return ok([hook({ id: 2, url: 'https://smee.io/sibling' })]);
    });
    const result = await discoverChannelUrl({
      env: {},
      channelFilePath: FILE_PATH,
      fs: makeFs({}),
      logger: { warn },
      cwd: '/other',
      workspaceMirrorPath: MIRROR_PATH,
      targets: [
        { owner: 'acme', repo: 'coord' },
        { owner: 'acme', repo: 'sibling' },
      ],
      runner,
    });
    expect(result).toEqual({
      url: 'https://smee.io/sibling',
      source: 'webhook-config',
    });
    expect(calls).toHaveLength(2);
    // Silent no-match on primary.
    expect(warn).not.toHaveBeenCalled();
  });

  it('W5: 403 exit=1 → fall-through to next FS stage + one warn', async () => {
    const warn = vi.fn();
    const { runner } = makeRunner(() => ({
      stdout: '',
      stderr: 'HTTP 403: Resource not accessible by integration',
      exitCode: 1,
    }));
    const cwd = '/opt/repo';
    const walkupPath = `${cwd}/.generacy/cockpit/smee-channel`;
    const result = await discoverChannelUrl({
      env: {},
      channelFilePath: FILE_PATH,
      fs: makeFs({ [walkupPath]: 'https://smee.io/walkupFallback' }),
      logger: { warn },
      cwd,
      workspaceMirrorPath: MIRROR_PATH,
      targets: [{ owner: 'acme', repo: 'coord' }],
      runner,
    });
    expect(result).toEqual({
      url: 'https://smee.io/walkupFallback',
      source: 'workspace-walkup',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(
      /webhook-config stage failed for acme\/coord: exit=1/,
    );
  });

  it('W6: timeout exit=124 → fall-through + one warn', async () => {
    const warn = vi.fn();
    const { runner } = makeRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 124,
    }));
    const cwd = '/opt/repo';
    const walkupPath = `${cwd}/.generacy/cockpit/smee-channel`;
    const result = await discoverChannelUrl({
      env: {},
      channelFilePath: FILE_PATH,
      fs: makeFs({ [walkupPath]: 'https://smee.io/walkupFallback' }),
      logger: { warn },
      cwd,
      workspaceMirrorPath: MIRROR_PATH,
      targets: [{ owner: 'acme', repo: 'coord' }],
      runner,
    });
    expect(result).toEqual({
      url: 'https://smee.io/walkupFallback',
      source: 'workspace-walkup',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(
      /webhook-config stage failed for acme\/coord: exit=124/,
    );
  });

  it('W7: no-runner no-op → silent skip, discovery reaches walk-up without warn', async () => {
    const warn = vi.fn();
    const cwd = '/opt/repo';
    const walkupPath = `${cwd}/.generacy/cockpit/smee-channel`;
    const result = await discoverChannelUrl({
      env: {},
      channelFilePath: FILE_PATH,
      fs: makeFs({ [walkupPath]: 'https://smee.io/walkupFallback' }),
      logger: { warn },
      cwd,
      workspaceMirrorPath: MIRROR_PATH,
      // targets provided but runner omitted
      targets: [{ owner: 'acme', repo: 'coord' }],
    });
    expect(result).toEqual({
      url: 'https://smee.io/walkupFallback',
      source: 'workspace-walkup',
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
