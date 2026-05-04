import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { setDefaultRole } from '../../src/services/default-role-writer.js';
import { ControlPlaneError } from '../../src/errors.js';

describe('setDefaultRole', () => {
  let tmpDir: string;
  let agencyDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'default-role-writer-'));
    agencyDir = path.join(tmpDir, '.agency');
    configPath = path.join(tmpDir, '.generacy', 'config.yaml');

    // Create a valid role file by default
    await fs.mkdir(path.join(agencyDir, 'roles'), { recursive: true });
    await fs.writeFile(path.join(agencyDir, 'roles', 'developer.yaml'), 'name: developer\n');
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('creates config when it does not exist and role file is valid', async () => {
    await setDefaultRole({ role: 'developer', agencyDir, configPath });

    const content = await fs.readFile(configPath, 'utf8');
    const parsed = YAML.parse(content);
    expect(parsed).toEqual({ defaults: { role: 'developer' } });
  });

  it('merges into existing config preserving other keys', async () => {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      YAML.stringify({ logging: { level: 'debug' }, defaults: { timeout: 30 } }),
    );

    await setDefaultRole({ role: 'developer', agencyDir, configPath });

    const content = await fs.readFile(configPath, 'utf8');
    const parsed = YAML.parse(content);
    expect(parsed.logging).toEqual({ level: 'debug' });
    expect(parsed.defaults.role).toBe('developer');
    expect(parsed.defaults.timeout).toBe(30);
  });

  it('throws INVALID_REQUEST when role file does not exist', async () => {
    try {
      await setDefaultRole({ role: 'nonexistent', agencyDir, configPath });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ControlPlaneError);
      expect((err as ControlPlaneError).code).toBe('INVALID_REQUEST');
      expect((err as ControlPlaneError).message).toContain('nonexistent');
    }
  });

  it('handles empty config file', async () => {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, '');

    await setDefaultRole({ role: 'developer', agencyDir, configPath });

    const content = await fs.readFile(configPath, 'utf8');
    const parsed = YAML.parse(content);
    expect(parsed).toEqual({ defaults: { role: 'developer' } });
  });

  it('creates parent directory for config if needed', async () => {
    const nestedConfigPath = path.join(tmpDir, 'deep', 'nested', 'config.yaml');

    await setDefaultRole({ role: 'developer', agencyDir, configPath: nestedConfigPath });

    const content = await fs.readFile(nestedConfigPath, 'utf8');
    const parsed = YAML.parse(content);
    expect(parsed).toEqual({ defaults: { role: 'developer' } });
  });
});
