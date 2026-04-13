import { ExposureRenderer } from '../src/exposure-renderer.js';
import { CredhelperError } from '../src/errors.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('ExposureRenderer', () => {
  let renderer: ExposureRenderer;
  let tmpDir: string;

  beforeEach(async () => {
    renderer = new ExposureRenderer();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'credhelper-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('renderSessionDir()', () => {
    it('creates the session directory', async () => {
      const sessionDir = path.join(tmpDir, 'session-abc');
      await renderer.renderSessionDir(sessionDir);

      const stat = await fs.stat(sessionDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('renderEnv()', () => {
    it('writes env file with KEY=VALUE lines', async () => {
      const sessionDir = path.join(tmpDir, 'session-env');
      await renderer.renderSessionDir(sessionDir);
      await renderer.renderEnv(sessionDir, [{ key: 'TOKEN', value: 'abc123' }]);

      const content = await fs.readFile(path.join(sessionDir, 'env'), 'utf-8');
      expect(content).toContain('TOKEN=abc123');
    });

    it('writes multiple entries each on its own line', async () => {
      const sessionDir = path.join(tmpDir, 'session-env-multi');
      await renderer.renderSessionDir(sessionDir);
      await renderer.renderEnv(sessionDir, [
        { key: 'FOO', value: 'bar' },
        { key: 'BAZ', value: 'qux' },
        { key: 'HELLO', value: 'world' },
      ]);

      const content = await fs.readFile(path.join(sessionDir, 'env'), 'utf-8');
      expect(content).toContain('FOO=bar\n');
      expect(content).toContain('BAZ=qux\n');
      expect(content).toContain('HELLO=world\n');
    });
  });

  describe('renderGitCredentialHelper()', () => {
    let sessionDir: string;
    const dataSocketPath = '/tmp/credhelper-test.sock';

    beforeEach(async () => {
      sessionDir = path.join(tmpDir, 'session-git');
      await renderer.renderSessionDir(sessionDir);
      await renderer.renderGitCredentialHelper(sessionDir, dataSocketPath);
    });

    it('creates git/ directory', async () => {
      const stat = await fs.stat(path.join(sessionDir, 'git'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('creates git/config file and git/credential-helper script', async () => {
      const configStat = await fs.stat(path.join(sessionDir, 'git', 'config'));
      expect(configStat.isFile()).toBe(true);

      const helperStat = await fs.stat(path.join(sessionDir, 'git', 'credential-helper'));
      expect(helperStat.isFile()).toBe(true);
    });

    it('config file contains [credential] section with helper path', async () => {
      const config = await fs.readFile(path.join(sessionDir, 'git', 'config'), 'utf-8');
      expect(config).toContain('[credential]');
      expect(config).toContain(path.join(sessionDir, 'git', 'credential-helper'));
    });

    it('credential-helper script contains curl --unix-socket command', async () => {
      const script = await fs.readFile(
        path.join(sessionDir, 'git', 'credential-helper'),
        'utf-8',
      );
      expect(script).toContain('curl');
      expect(script).toContain('--unix-socket');
      expect(script).toContain(dataSocketPath);
    });
  });

  describe('renderGcloudExternalAccount()', () => {
    let sessionDir: string;
    const dataSocketPath = '/tmp/credhelper-gcp.sock';
    const credentialId = 'gcp-sa-key-123';

    beforeEach(async () => {
      sessionDir = path.join(tmpDir, 'session-gcp');
      await renderer.renderSessionDir(sessionDir);
      await renderer.renderGcloudExternalAccount(sessionDir, dataSocketPath, credentialId);
    });

    it('creates gcp/ directory', async () => {
      const stat = await fs.stat(path.join(sessionDir, 'gcp'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('creates gcp/external-account.json file', async () => {
      const stat = await fs.stat(path.join(sessionDir, 'gcp', 'external-account.json'));
      expect(stat.isFile()).toBe(true);
    });

    it('JSON contains type external_account and credential_source.url with the credential ID', async () => {
      const raw = await fs.readFile(
        path.join(sessionDir, 'gcp', 'external-account.json'),
        'utf-8',
      );
      const json = JSON.parse(raw);

      expect(json.type).toBe('external_account');
      expect(json.credential_source.url).toContain(credentialId);
    });
  });

  describe('renderLocalhostProxy()', () => {
    it('throws CredhelperError with code NOT_IMPLEMENTED', () => {
      expect(() => renderer.renderLocalhostProxy()).toThrow(CredhelperError);
      try {
        renderer.renderLocalhostProxy();
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('NOT_IMPLEMENTED');
      }
    });
  });

  describe('renderDockerSocketProxy()', () => {
    it('throws CredhelperError with code NOT_IMPLEMENTED', () => {
      expect(() => renderer.renderDockerSocketProxy()).toThrow(CredhelperError);
      try {
        renderer.renderDockerSocketProxy();
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('NOT_IMPLEMENTED');
      }
    });
  });
});
