import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { setupFileRoutes } from '../files.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = resolve(process.cwd(), '.generacy/__test__');
const TEST_FILE = '.generacy/__test__/test-file.yaml';
const TEST_FILE_ABS = resolve(process.cwd(), TEST_FILE);

function ensureTestDir(): void {
  mkdirSync(TEST_DIR, { recursive: true });
}

function writeTestFile(content: string): void {
  ensureTestDir();
  writeFileSync(TEST_FILE_ABS, content, 'utf-8');
}

function cleanTestDir(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('File routes', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = Fastify();
    await setupFileRoutes(server);
    await server.ready();
  });

  afterEach(() => {
    cleanTestDir();
  });

  // -------------------------------------------------------------------------
  // GET /files
  // -------------------------------------------------------------------------

  describe('GET /files', () => {
    it('returns file content and mtime for an existing file', async () => {
      writeTestFile('channel: preview\n');

      const response = await server.inject({
        method: 'GET',
        url: `/files?path=${TEST_FILE}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.content).toBe('channel: preview\n');
      expect(body.mtime).toBeDefined();
    });

    it('returns 404 for a non-existent file', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/files?path=.generacy/__test__/nonexistent.yaml',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('File not found');
    });

    it('returns 403 for path traversal', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/files?path=.generacy/../../etc/passwd',
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Access denied');
      expect(body.reason).toBe('path-traversal');
    });

    it('returns 403 for disallowed prefix', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/files?path=src/index.ts',
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Access denied');
      expect(body.reason).toBe('disallowed-prefix');
    });
  });

  // -------------------------------------------------------------------------
  // PUT /files
  // -------------------------------------------------------------------------

  describe('PUT /files', () => {
    it('creates a new file and returns 201', async () => {
      ensureTestDir();
      const newPath = '.generacy/__test__/new-file.yaml';
      const absPath = resolve(process.cwd(), newPath);

      // Ensure file doesn't exist
      if (existsSync(absPath)) rmSync(absPath);

      const response = await server.inject({
        method: 'PUT',
        url: `/files?path=${newPath}`,
        payload: { content: 'channel: stable\n' },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.mtime).toBeDefined();

      // Verify file was actually written
      expect(existsSync(absPath)).toBe(true);
    });

    it('updates an existing file and returns 200', async () => {
      writeTestFile('channel: preview\n');

      const response = await server.inject({
        method: 'PUT',
        url: `/files?path=${TEST_FILE}`,
        payload: { content: 'channel: stable\n' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.mtime).toBeDefined();
    });

    it('returns 403 for path traversal', async () => {
      const response = await server.inject({
        method: 'PUT',
        url: '/files?path=.generacy/../../etc/evil',
        payload: { content: 'bad' },
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 403 for disallowed prefix', async () => {
      const response = await server.inject({
        method: 'PUT',
        url: '/files?path=package.json',
        payload: { content: '{}' },
      });

      expect(response.statusCode).toBe(403);
    });
  });
});
