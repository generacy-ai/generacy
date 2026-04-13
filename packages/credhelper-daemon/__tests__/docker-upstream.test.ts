import { constants } from 'node:fs';

vi.mock('node:fs/promises', () => ({
  default: {
    access: vi.fn(),
  },
}));

import fs from 'node:fs/promises';
import { detectUpstreamSocket } from '../src/docker-upstream.js';
import { CredhelperError } from '../src/errors.js';

const mockAccess = vi.mocked(fs.access);

describe('detectUpstreamSocket', () => {
  let savedEnableDind: string | undefined;

  beforeEach(() => {
    savedEnableDind = process.env.ENABLE_DIND;
    delete process.env.ENABLE_DIND;
    mockAccess.mockReset();
  });

  afterEach(() => {
    if (savedEnableDind !== undefined) {
      process.env.ENABLE_DIND = savedEnableDind;
    } else {
      delete process.env.ENABLE_DIND;
    }
  });

  it('returns DinD socket when ENABLE_DIND=true and /var/run/docker.sock is writable', async () => {
    process.env.ENABLE_DIND = 'true';
    mockAccess.mockResolvedValue(undefined);

    const result = await detectUpstreamSocket();

    expect(result).toEqual({
      socketPath: '/var/run/docker.sock',
      isHost: false,
    });
    expect(mockAccess).toHaveBeenCalledWith('/var/run/docker.sock', constants.W_OK);
  });

  it('returns DooD socket when ENABLE_DIND is not set and /var/run/docker-host.sock is writable', async () => {
    mockAccess.mockResolvedValue(undefined);

    const result = await detectUpstreamSocket();

    expect(result).toEqual({
      socketPath: '/var/run/docker-host.sock',
      isHost: true,
    });
    expect(mockAccess).toHaveBeenCalledWith('/var/run/docker-host.sock', constants.W_OK);
  });

  it('returns DinD socket when both sockets exist and ENABLE_DIND=true', async () => {
    process.env.ENABLE_DIND = 'true';
    mockAccess.mockResolvedValue(undefined);

    const result = await detectUpstreamSocket();

    expect(result).toEqual({
      socketPath: '/var/run/docker.sock',
      isHost: false,
    });
    // Should only check the DinD socket since it succeeded
    expect(mockAccess).toHaveBeenCalledTimes(1);
    expect(mockAccess).toHaveBeenCalledWith('/var/run/docker.sock', constants.W_OK);
  });

  it('falls back to DooD when ENABLE_DIND=true but /var/run/docker.sock is not writable', async () => {
    process.env.ENABLE_DIND = 'true';
    mockAccess.mockImplementation(async (path: any) => {
      if (path === '/var/run/docker.sock') {
        throw new Error('EACCES: permission denied');
      }
      // /var/run/docker-host.sock succeeds
      return undefined;
    });

    const result = await detectUpstreamSocket();

    expect(result).toEqual({
      socketPath: '/var/run/docker-host.sock',
      isHost: true,
    });
    expect(mockAccess).toHaveBeenCalledTimes(2);
    expect(mockAccess).toHaveBeenCalledWith('/var/run/docker.sock', constants.W_OK);
    expect(mockAccess).toHaveBeenCalledWith('/var/run/docker-host.sock', constants.W_OK);
  });

  it('throws CredhelperError with DOCKER_UPSTREAM_NOT_FOUND when neither socket is available', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT: no such file or directory'));

    await expect(detectUpstreamSocket()).rejects.toThrow(CredhelperError);

    try {
      await detectUpstreamSocket();
    } catch (err) {
      expect(err).toBeInstanceOf(CredhelperError);
      expect((err as CredhelperError).code).toBe('DOCKER_UPSTREAM_NOT_FOUND');
    }
  });

  it('does not check DinD socket when ENABLE_DIND is not set', async () => {
    mockAccess.mockResolvedValue(undefined);

    await detectUpstreamSocket();

    expect(mockAccess).toHaveBeenCalledTimes(1);
    expect(mockAccess).toHaveBeenCalledWith('/var/run/docker-host.sock', constants.W_OK);
  });

  it('does not check DinD socket when ENABLE_DIND is set to a value other than "true"', async () => {
    process.env.ENABLE_DIND = 'false';
    mockAccess.mockResolvedValue(undefined);

    await detectUpstreamSocket();

    expect(mockAccess).toHaveBeenCalledTimes(1);
    expect(mockAccess).toHaveBeenCalledWith('/var/run/docker-host.sock', constants.W_OK);
  });
});
