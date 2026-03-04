import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ClusterVariant } from '../types.js';

// ---------------------------------------------------------------------------
// Tar construction helpers (reused from tar-utils.test.ts)
// ---------------------------------------------------------------------------

const BLOCK_SIZE = 512;

function makeTarHeader(opts: {
  name: string;
  size: number;
  prefix?: string;
  typeFlag?: string;
}): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  header.write(opts.name, 0, Math.min(opts.name.length, 100), 'ascii');
  const octalSize = opts.size.toString(8).padStart(11, '0');
  header.write(octalSize, 124, 11, 'ascii');
  header[135] = 0;
  header.write(opts.typeFlag ?? '0', 156, 1, 'ascii');
  if (opts.prefix) {
    header.write(opts.prefix, 345, Math.min(opts.prefix.length, 155), 'ascii');
  }
  return header;
}

function padToBlock(content: Buffer): Buffer {
  const remainder = content.length % BLOCK_SIZE;
  if (remainder === 0) return content;
  return Buffer.concat([content, Buffer.alloc(BLOCK_SIZE - remainder, 0)]);
}

function endOfArchive(): Buffer {
  return Buffer.alloc(BLOCK_SIZE * 2, 0);
}

function makeTarEntry(opts: {
  name: string;
  content: string;
  prefix?: string;
}): Buffer {
  const body = Buffer.from(opts.content, 'utf-8');
  const header = makeTarHeader({
    name: opts.name,
    size: body.length,
    prefix: opts.prefix,
  });
  return Buffer.concat([header, padToBlock(body)]);
}

function makeDirEntry(name: string, prefix?: string): Buffer {
  return makeTarHeader({ name, size: 0, prefix, typeFlag: '5' });
}

function buildTarGz(...entries: Buffer[]): Buffer {
  const tar = Buffer.concat([...entries, endOfArchive()]);
  return Buffer.from(gzipSync(tar));
}

// ---------------------------------------------------------------------------
// Build a tarball mimicking the GitHub structure for cluster-templates
// ---------------------------------------------------------------------------

const HASH_PREFIX = 'generacy-ai-cluster-templates-abc1234';

function buildStandardTarball(): Buffer {
  return buildTarGz(
    makeDirEntry(`${HASH_PREFIX}/`),
    makeDirEntry('standard/', HASH_PREFIX),
    makeTarEntry({
      name: 'Dockerfile',
      content: 'FROM node:20',
      prefix: `${HASH_PREFIX}/standard`,
    }),
    makeTarEntry({
      name: 'docker-compose.yml',
      content: 'version: "3.8"',
      prefix: `${HASH_PREFIX}/standard`,
    }),
    makeTarEntry({
      name: 'devcontainer.json',
      content: '{ "name": "dev" }',
      prefix: `${HASH_PREFIX}/standard`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the logger
vi.mock('../../../../cli/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock homedir to use a temp directory for cache isolation
let testHomeDir: string;

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return {
    ...original,
    homedir: () => testHomeDir,
  };
});

// Store the original global fetch
const originalFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Import the module under test (after mocks)
// ---------------------------------------------------------------------------

import { fetchClusterTemplates } from '../template-fetcher.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchClusterTemplates', () => {
  beforeEach(() => {
    // Create an isolated temp directory for each test
    testHomeDir = join(tmpdir(), `generacy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testHomeDir, { recursive: true });
  });

  afterEach(() => {
    // Restore fetch
    globalThis.fetch = originalFetch;
    // Clean up temp directory
    if (existsSync(testHomeDir)) {
      rmSync(testHomeDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Successful download + extraction
  // -------------------------------------------------------------------------

  describe('successful fetch', () => {
    it('downloads tarball and returns mapped files under .devcontainer/', async () => {
      const tarball = buildStandardTarball();

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength)),
      });

      const files = await fetchClusterTemplates({
        variant: 'standard',
        ref: 'test-ref',
      });

      expect(files.size).toBe(3);
      expect(files.get('.devcontainer/Dockerfile')).toBe('FROM node:20');
      expect(files.get('.devcontainer/docker-compose.yml')).toBe('version: "3.8"');
      expect(files.get('.devcontainer/devcontainer.json')).toBe('{ "name": "dev" }');
    });

    it('defaults ref to "develop" when not specified', async () => {
      const tarball = buildStandardTarball();

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength)),
      });

      await fetchClusterTemplates({ variant: 'standard' });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/tarball/develop'),
        expect.any(Object),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Path mapping
  // -------------------------------------------------------------------------

  describe('path mapping', () => {
    it('maps {hash}/standard/Dockerfile to .devcontainer/Dockerfile', async () => {
      const tarball = buildTarGz(
        makeTarEntry({
          name: 'Dockerfile',
          content: 'FROM ubuntu',
          prefix: `${HASH_PREFIX}/standard`,
        }),
      );

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength)),
      });

      const files = await fetchClusterTemplates({
        variant: 'standard',
        ref: 'v1',
      });

      expect(files.has('.devcontainer/Dockerfile')).toBe(true);
    });

    it('maps nested paths correctly', async () => {
      const tarball = buildTarGz(
        makeTarEntry({
          name: 'entrypoint.sh',
          content: '#!/bin/bash',
          prefix: `${HASH_PREFIX}/standard/scripts`,
        }),
      );

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength)),
      });

      const files = await fetchClusterTemplates({
        variant: 'standard',
        ref: 'v1',
      });

      expect(files.get('.devcontainer/scripts/entrypoint.sh')).toBe('#!/bin/bash');
    });

    it('excludes files from other variants', async () => {
      const tarball = buildTarGz(
        makeTarEntry({
          name: 'Dockerfile',
          content: 'FROM node:20',
          prefix: `${HASH_PREFIX}/standard`,
        }),
        makeTarEntry({
          name: 'Dockerfile',
          content: 'FROM node:20-slim',
          prefix: `${HASH_PREFIX}/microservices`,
        }),
      );

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength)),
      });

      const files = await fetchClusterTemplates({
        variant: 'standard',
        ref: 'v1',
      });

      expect(files.size).toBe(1);
      expect(files.get('.devcontainer/Dockerfile')).toBe('FROM node:20');
    });
  });

  // -------------------------------------------------------------------------
  // Cache behavior
  // -------------------------------------------------------------------------

  describe('caching', () => {
    it('caches files on first fetch and serves from cache on second call', async () => {
      const tarball = buildStandardTarball();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength)),
      });
      globalThis.fetch = mockFetch;

      // First call — fetches from network
      const first = await fetchClusterTemplates({
        variant: 'standard',
        ref: 'cache-test',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(first.size).toBe(3);

      // Second call — served from cache, no fetch
      const second = await fetchClusterTemplates({
        variant: 'standard',
        ref: 'cache-test',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1); // still 1
      expect(second.size).toBe(3);
      expect(second.get('.devcontainer/Dockerfile')).toBe('FROM node:20');
    });

    it('bypasses cache when refreshCache is true', async () => {
      const tarball = buildStandardTarball();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength)),
      });
      globalThis.fetch = mockFetch;

      // First call — populates cache
      await fetchClusterTemplates({
        variant: 'standard',
        ref: 'refresh-test',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call with refreshCache — should fetch again
      await fetchClusterTemplates({
        variant: 'standard',
        ref: 'refresh-test',
        refreshCache: true,
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('writes cache files to the correct directory structure', async () => {
      const tarball = buildStandardTarball();
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength)),
      });

      await fetchClusterTemplates({
        variant: 'standard',
        ref: 'dir-test',
      });

      const cacheDir = join(testHomeDir, '.generacy/template-cache/dir-test/standard');
      expect(existsSync(cacheDir)).toBe(true);
      expect(existsSync(join(cacheDir, '.devcontainer/Dockerfile'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  describe('authentication', () => {
    it('includes Authorization header when token is provided', async () => {
      const tarball = buildStandardTarball();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength)),
      });
      globalThis.fetch = mockFetch;

      await fetchClusterTemplates({
        variant: 'standard',
        ref: 'auth-test',
        token: 'ghp_test123',
      });

      const [, requestInit] = mockFetch.mock.calls[0]!;
      expect(requestInit.headers['Authorization']).toBe('Bearer ghp_test123');
    });

    it('omits Authorization header when token is undefined', async () => {
      const tarball = buildStandardTarball();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength)),
      });
      globalThis.fetch = mockFetch;

      await fetchClusterTemplates({
        variant: 'standard',
        ref: 'noauth-test',
      });

      const [, requestInit] = mockFetch.mock.calls[0]!;
      expect(requestInit.headers['Authorization']).toBeUndefined();
    });

    it('omits Authorization header when token is null', async () => {
      const tarball = buildStandardTarball();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength)),
      });
      globalThis.fetch = mockFetch;

      await fetchClusterTemplates({
        variant: 'standard',
        ref: 'nullauth-test',
        token: null,
      });

      const [, requestInit] = mockFetch.mock.calls[0]!;
      expect(requestInit.headers['Authorization']).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // HTTP error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('throws descriptive error on HTTP 404 with ref name', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      await expect(
        fetchClusterTemplates({
          variant: 'standard',
          ref: 'nonexistent-tag',
        }),
      ).rejects.toThrow("Template ref 'nonexistent-tag' not found");
    });

    it('throws auth error on HTTP 401', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });

      await expect(
        fetchClusterTemplates({ variant: 'standard', ref: 'v1' }),
      ).rejects.toThrow('Authentication required or rate limited');
    });

    it('throws auth error on HTTP 403', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
      });

      await expect(
        fetchClusterTemplates({ variant: 'standard', ref: 'v1' }),
      ).rejects.toThrow('Authentication required or rate limited');
    });

    it('throws generic HTTP error for other status codes', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      await expect(
        fetchClusterTemplates({ variant: 'standard', ref: 'v1' }),
      ).rejects.toThrow('Failed to fetch cluster templates (HTTP 500)');
    });

    it('throws network connectivity error on fetch rejection', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

      await expect(
        fetchClusterTemplates({ variant: 'standard', ref: 'v1' }),
      ).rejects.toThrow('Failed to fetch cluster templates — check your network connection');
    });
  });

  // -------------------------------------------------------------------------
  // Request construction
  // -------------------------------------------------------------------------

  describe('request construction', () => {
    it('constructs the correct GitHub tarball URL', async () => {
      const tarball = buildStandardTarball();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength)),
      });
      globalThis.fetch = mockFetch;

      await fetchClusterTemplates({
        variant: 'standard',
        ref: 'v2.0.0',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/generacy-ai/cluster-templates/tarball/v2.0.0',
        expect.any(Object),
      );
    });

    it('includes correct Accept and User-Agent headers', async () => {
      const tarball = buildStandardTarball();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength)),
      });
      globalThis.fetch = mockFetch;

      await fetchClusterTemplates({
        variant: 'standard',
        ref: 'v1',
      });

      const [, requestInit] = mockFetch.mock.calls[0]!;
      expect(requestInit.headers['Accept']).toBe('application/vnd.github+json');
      expect(requestInit.headers['User-Agent']).toBe('generacy-cli');
    });
  });
});
