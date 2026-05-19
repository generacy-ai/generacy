import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ExposureRenderer } from '../exposure-renderer.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('ExposureRenderer file exposure', () => {
  let renderer: ExposureRenderer;
  let tmpDir: string;

  beforeEach(async () => {
    renderer = new ExposureRenderer();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'renderer-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes blob to the target path', async () => {
    const targetPath = path.join(tmpDir, 'test-file.txt');
    const data = Buffer.from('test content');

    await renderer.renderFileExposure(targetPath, data);

    const content = await fs.readFile(targetPath, 'utf-8');
    expect(content).toBe('test content');
  });

  it('sets correct file mode', async () => {
    const targetPath = path.join(tmpDir, 'mode-test.txt');
    const data = Buffer.from('data');

    await renderer.renderFileExposure(targetPath, data, 0o600);

    const stat = await fs.stat(targetPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('uses default mode 0o640 when not specified', async () => {
    const targetPath = path.join(tmpDir, 'default-mode.txt');
    const data = Buffer.from('data');

    await renderer.renderFileExposure(targetPath, data);

    const stat = await fs.stat(targetPath);
    expect(stat.mode & 0o777).toBe(0o640);
  });

  it('creates parent directories', async () => {
    const targetPath = path.join(tmpDir, 'nested', 'dir', 'file.txt');
    const data = Buffer.from('nested content');

    await renderer.renderFileExposure(targetPath, data);

    const content = await fs.readFile(targetPath, 'utf-8');
    expect(content).toBe('nested content');
  });

  it('rejects denied paths', async () => {
    await expect(
      renderer.renderFileExposure('/etc/passwd', Buffer.from('bad')),
    ).rejects.toThrow('restricted system directory');
  });

  it('rejects paths that traverse to denied locations', async () => {
    await expect(
      renderer.renderFileExposure('/tmp/../etc/shadow', Buffer.from('bad')),
    ).rejects.toThrow('restricted system directory');
  });

  describe('session file tracking and cleanup', () => {
    it('tracks files and cleans up on session end', async () => {
      const targetPath = path.join(tmpDir, 'session-file.txt');
      await renderer.renderFileExposure(targetPath, Buffer.from('data'));

      renderer.trackFileForSession('test-session', targetPath);
      await renderer.cleanupSessionFiles('test-session');

      await expect(fs.access(targetPath)).rejects.toThrow();
    });

    it('is safe to cleanup a session with no tracked files', async () => {
      await expect(
        renderer.cleanupSessionFiles('nonexistent-session'),
      ).resolves.not.toThrow();
    });
  });
});
