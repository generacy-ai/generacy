import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import {
  readDockerConfig,
  writeDockerConfig,
  addAuth,
  removeAuth,
  getDockerConfigDir,
  dockerConfigExists,
} from '../docker-config.js';

describe('docker-config', () => {
  let generacyDir: string;

  beforeEach(() => {
    generacyDir = mkdtempSync(join(tmpdir(), 'docker-config-test-'));
  });

  afterEach(() => {
    rmSync(generacyDir, { recursive: true, force: true });
  });

  describe('getDockerConfigDir', () => {
    it('returns <generacyDir>/.docker', () => {
      expect(getDockerConfigDir('/foo/.generacy')).toBe('/foo/.generacy/.docker');
    });
  });

  describe('dockerConfigExists', () => {
    it('returns false when config does not exist', () => {
      expect(dockerConfigExists(generacyDir)).toBe(false);
    });

    it('returns true when config exists', () => {
      writeDockerConfig(generacyDir, { auths: {} });
      expect(dockerConfigExists(generacyDir)).toBe(true);
    });
  });

  describe('readDockerConfig', () => {
    it('returns empty config when file does not exist', () => {
      const config = readDockerConfig(generacyDir);
      expect(config).toEqual({ auths: {} });
    });

    it('reads existing config', () => {
      const original = { auths: { 'ghcr.io': { auth: 'dGVzdDp0b2tlbg==' } } };
      writeDockerConfig(generacyDir, original);
      const config = readDockerConfig(generacyDir);
      expect(config).toEqual(original);
    });
  });

  describe('writeDockerConfig', () => {
    it('creates .docker/ directory if missing', () => {
      writeDockerConfig(generacyDir, { auths: {} });
      expect(existsSync(join(generacyDir, '.docker'))).toBe(true);
    });

    it('writes valid JSON', () => {
      const config = { auths: { 'ghcr.io': { auth: 'abc123' } } };
      writeDockerConfig(generacyDir, config);
      const raw = readFileSync(join(generacyDir, '.docker', 'config.json'), 'utf-8');
      expect(JSON.parse(raw)).toEqual(config);
    });

    it('does not leave tmp file on success (atomic write)', () => {
      writeDockerConfig(generacyDir, { auths: {} });
      expect(existsSync(join(generacyDir, '.docker', 'config.json.tmp'))).toBe(false);
    });

    it('never modifies ~/.docker', () => {
      const homeDockerConfig = join(homedir(), '.docker', 'config.json');
      const beforeExists = existsSync(homeDockerConfig);
      let beforeContent: string | undefined;
      if (beforeExists) {
        beforeContent = readFileSync(homeDockerConfig, 'utf-8');
      }

      writeDockerConfig(generacyDir, { auths: { 'ghcr.io': { auth: 'test' } } });

      if (beforeExists) {
        expect(readFileSync(homeDockerConfig, 'utf-8')).toBe(beforeContent);
      } else {
        expect(existsSync(homeDockerConfig)).toBe(false);
      }
    });
  });

  describe('addAuth', () => {
    it('adds base64-encoded auth entry', () => {
      const config = { auths: {} };
      const result = addAuth(config, 'ghcr.io', 'user', 'token123');
      expect(result.auths['ghcr.io']).toBeDefined();
      const decoded = Buffer.from(result.auths['ghcr.io'].auth, 'base64').toString();
      expect(decoded).toBe('user:token123');
    });

    it('preserves existing entries', () => {
      const config = { auths: { 'docker.io': { auth: 'existing' } } };
      const result = addAuth(config, 'ghcr.io', 'user', 'pass');
      expect(result.auths['docker.io']).toEqual({ auth: 'existing' });
      expect(result.auths['ghcr.io']).toBeDefined();
    });

    it('overwrites entry for same host', () => {
      const config = addAuth({ auths: {} }, 'ghcr.io', 'old', 'old');
      const result = addAuth(config, 'ghcr.io', 'new', 'new');
      const decoded = Buffer.from(result.auths['ghcr.io'].auth, 'base64').toString();
      expect(decoded).toBe('new:new');
    });
  });

  describe('removeAuth', () => {
    it('removes the specified host', () => {
      const config = addAuth({ auths: {} }, 'ghcr.io', 'user', 'pass');
      const result = removeAuth(config, 'ghcr.io');
      expect(result.auths['ghcr.io']).toBeUndefined();
    });

    it('preserves other hosts', () => {
      let config = addAuth({ auths: {} }, 'ghcr.io', 'u1', 'p1');
      config = addAuth(config, 'docker.io', 'u2', 'p2');
      const result = removeAuth(config, 'ghcr.io');
      expect(result.auths['docker.io']).toBeDefined();
      expect(result.auths['ghcr.io']).toBeUndefined();
    });

    it('is a no-op if host not present', () => {
      const config = { auths: { 'docker.io': { auth: 'x' } } };
      const result = removeAuth(config, 'ghcr.io');
      expect(result).toEqual(config);
    });
  });

  describe('round-trip', () => {
    it('write then read returns same data', () => {
      let config = { auths: {} };
      config = addAuth(config, 'ghcr.io', 'myuser', 'mytoken');
      writeDockerConfig(generacyDir, config);
      const loaded = readDockerConfig(generacyDir);
      expect(loaded).toEqual(config);
    });
  });
});
