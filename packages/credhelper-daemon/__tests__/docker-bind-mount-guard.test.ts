import http from 'node:http';
import { Readable } from 'node:stream';

import {
  validateBindMounts,
  bufferRequestBody,
  type DockerCreateBody,
} from '../src/docker-bind-mount-guard.js';

describe('validateBindMounts', () => {
  const scratchDir = '/var/lib/generacy/scratch/session-abc';

  describe('valid mounts under scratch dir', () => {
    it('allows Binds under scratch dir', () => {
      const body: DockerCreateBody = {
        HostConfig: {
          Binds: [`${scratchDir}/workspace:/app`],
        },
      };
      const result = validateBindMounts(body, scratchDir);
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('allows Mounts (type bind) under scratch dir', () => {
      const body: DockerCreateBody = {
        HostConfig: {
          Mounts: [
            {
              Type: 'bind',
              Source: `${scratchDir}/data`,
              Target: '/data',
            },
          ],
        },
      };
      const result = validateBindMounts(body, scratchDir);
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('allows the scratch dir itself as a mount source', () => {
      const body: DockerCreateBody = {
        HostConfig: {
          Binds: [`${scratchDir}:/workspace`],
        },
      };
      const result = validateBindMounts(body, scratchDir);
      expect(result.valid).toBe(true);
    });
  });

  describe('rejected mounts outside scratch dir', () => {
    it('rejects Binds pointing to /etc', () => {
      const body: DockerCreateBody = {
        HostConfig: {
          Binds: ['/etc/passwd:/etc/passwd:ro'],
        },
      };
      const result = validateBindMounts(body, scratchDir);
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.source).toBe('/etc/passwd');
    });

    it('rejects Mounts pointing to /home', () => {
      const body: DockerCreateBody = {
        HostConfig: {
          Mounts: [
            {
              Type: 'bind',
              Source: '/home/user',
              Target: '/home',
            },
          ],
        },
      };
      const result = validateBindMounts(body, scratchDir);
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(1);
    });
  });

  describe('../ traversal prevention', () => {
    it('rejects paths using ../ to escape scratch dir', () => {
      const body: DockerCreateBody = {
        HostConfig: {
          Binds: [`${scratchDir}/../../../etc/shadow:/shadow`],
        },
      };
      const result = validateBindMounts(body, scratchDir);
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.resolved).not.toContain('..');
    });

    it('rejects Mounts with ../ traversal', () => {
      const body: DockerCreateBody = {
        HostConfig: {
          Mounts: [
            {
              Type: 'bind',
              Source: `${scratchDir}/../../secret`,
              Target: '/secret',
            },
          ],
        },
      };
      const result = validateBindMounts(body, scratchDir);
      expect(result.valid).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('allows empty Binds array', () => {
      const body: DockerCreateBody = {
        HostConfig: { Binds: [] },
      };
      const result = validateBindMounts(body, scratchDir);
      expect(result.valid).toBe(true);
    });

    it('allows empty Mounts array', () => {
      const body: DockerCreateBody = {
        HostConfig: { Mounts: [] },
      };
      const result = validateBindMounts(body, scratchDir);
      expect(result.valid).toBe(true);
    });

    it('allows missing HostConfig', () => {
      const body: DockerCreateBody = {};
      const result = validateBindMounts(body, scratchDir);
      expect(result.valid).toBe(true);
    });

    it('ignores non-bind Mounts (volume, tmpfs)', () => {
      const body: DockerCreateBody = {
        HostConfig: {
          Mounts: [
            { Type: 'volume', Source: 'my-vol', Target: '/data' },
            { Type: 'tmpfs', Target: '/tmp' },
          ],
        },
      };
      const result = validateBindMounts(body, scratchDir);
      expect(result.valid).toBe(true);
    });

    it('reports multiple violations', () => {
      const body: DockerCreateBody = {
        HostConfig: {
          Binds: ['/etc/hosts:/etc/hosts', '/var/run/docker.sock:/var/run/docker.sock'],
          Mounts: [
            { Type: 'bind', Source: '/root', Target: '/root' },
          ],
        },
      };
      const result = validateBindMounts(body, scratchDir);
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(3);
    });

    it('handles mixed valid and invalid mounts', () => {
      const body: DockerCreateBody = {
        HostConfig: {
          Binds: [
            `${scratchDir}/good:/app`,
            '/etc/shadow:/shadow',
          ],
        },
      };
      const result = validateBindMounts(body, scratchDir);
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.source).toBe('/etc/shadow');
    });
  });
});

describe('bufferRequestBody', () => {
  function createMockRequest(body: string): http.IncomingMessage {
    const readable = new Readable({
      read() {
        this.push(Buffer.from(body));
        this.push(null);
      },
    });
    return readable as unknown as http.IncomingMessage;
  }

  it('buffers a normal request body', async () => {
    const body = JSON.stringify({ Image: 'node:20' });
    const req = createMockRequest(body);
    const result = await bufferRequestBody(req);
    expect(result).toBe(body);
  });

  it('rejects body exceeding the size limit', async () => {
    const smallLimit = 10;
    const body = 'x'.repeat(20);
    const req = createMockRequest(body);
    await expect(bufferRequestBody(req, smallLimit)).rejects.toThrow(
      /exceeds maximum size/,
    );
  });

  it('handles empty body', async () => {
    const req = createMockRequest('');
    const result = await bufferRequestBody(req);
    expect(result).toBe('');
  });
});
