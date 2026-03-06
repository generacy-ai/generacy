import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findWorkspaceConfigPath, scanForWorkspaceConfig, tryLoadWorkspaceConfig } from '../loader.js';

const VALID_YAML = `
workspace:
  org: generacy-ai
  branch: develop
  repos:
    - name: tetrad-development
      monitor: true
    - name: generacy
      monitor: true
    - name: contracts
      monitor: false
`;

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'config-loader-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('tryLoadWorkspaceConfig', () => {
  it('returns WorkspaceConfig for valid YAML', () => {
    const configPath = join(tempDir, 'config.yaml');
    writeFileSync(configPath, VALID_YAML);

    const result = tryLoadWorkspaceConfig(configPath);
    expect(result).toEqual({
      org: 'generacy-ai',
      branch: 'develop',
      repos: [
        { name: 'tetrad-development', monitor: true },
        { name: 'generacy', monitor: true },
        { name: 'contracts', monitor: false },
      ],
    });
  });

  it('applies schema defaults for omitted fields', () => {
    const yaml = `
workspace:
  org: generacy-ai
  repos:
    - name: generacy
`;
    const configPath = join(tempDir, 'config.yaml');
    writeFileSync(configPath, yaml);

    const result = tryLoadWorkspaceConfig(configPath);
    expect(result).toEqual({
      org: 'generacy-ai',
      branch: 'develop',
      repos: [{ name: 'generacy', monitor: true }],
    });
  });

  it('returns null when file does not exist', () => {
    const result = tryLoadWorkspaceConfig(join(tempDir, 'nonexistent.yaml'));
    expect(result).toBeNull();
  });

  it('returns null when YAML has no workspace key', () => {
    const yaml = `
other:
  key: value
`;
    const configPath = join(tempDir, 'config.yaml');
    writeFileSync(configPath, yaml);

    expect(tryLoadWorkspaceConfig(configPath)).toBeNull();
  });

  it('returns null when workspace key is null', () => {
    const yaml = `workspace:\n`;
    const configPath = join(tempDir, 'config.yaml');
    writeFileSync(configPath, yaml);

    expect(tryLoadWorkspaceConfig(configPath)).toBeNull();
  });

  it('returns null for empty YAML file', () => {
    const configPath = join(tempDir, 'config.yaml');
    writeFileSync(configPath, '');

    expect(tryLoadWorkspaceConfig(configPath)).toBeNull();
  });

  it('returns null for YAML that parses to a scalar', () => {
    const configPath = join(tempDir, 'config.yaml');
    writeFileSync(configPath, 'just a string');

    expect(tryLoadWorkspaceConfig(configPath)).toBeNull();
  });

  it('throws on invalid workspace section (missing org)', () => {
    const yaml = `
workspace:
  repos:
    - name: generacy
`;
    const configPath = join(tempDir, 'config.yaml');
    writeFileSync(configPath, yaml);

    expect(() => tryLoadWorkspaceConfig(configPath)).toThrow();
  });

  it('throws on invalid workspace section (empty repos)', () => {
    const yaml = `
workspace:
  org: generacy-ai
  repos: []
`;
    const configPath = join(tempDir, 'config.yaml');
    writeFileSync(configPath, yaml);

    expect(() => tryLoadWorkspaceConfig(configPath)).toThrow();
  });

  it('throws on invalid workspace section (invalid repo entry)', () => {
    const yaml = `
workspace:
  org: generacy-ai
  repos:
    - name: ""
`;
    const configPath = join(tempDir, 'config.yaml');
    writeFileSync(configPath, yaml);

    expect(() => tryLoadWorkspaceConfig(configPath)).toThrow();
  });
});

describe('findWorkspaceConfigPath', () => {
  it('finds config in the start directory', () => {
    const configDir = join(tempDir, '.generacy');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'config.yaml'), VALID_YAML);

    const result = findWorkspaceConfigPath(tempDir);
    expect(result).toBe(join(configDir, 'config.yaml'));
  });

  it('walks up to find config in a parent directory', () => {
    const configDir = join(tempDir, '.generacy');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'config.yaml'), VALID_YAML);

    const nested = join(tempDir, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });

    const result = findWorkspaceConfigPath(nested);
    expect(result).toBe(join(configDir, 'config.yaml'));
  });

  it('returns null when config is not found', () => {
    // Use a custom config dir name that will never exist in any parent directory
    const nested = join(tempDir, 'empty', 'tree');
    mkdirSync(nested, { recursive: true });

    const result = findWorkspaceConfigPath(nested, '.generacy-test-nonexistent');
    expect(result).toBeNull();
  });

  it('supports custom config directory name', () => {
    const configDir = join(tempDir, '.custom');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'config.yaml'), VALID_YAML);

    const result = findWorkspaceConfigPath(tempDir, '.custom');
    expect(result).toBe(join(configDir, 'config.yaml'));
  });

  it('supports custom config file name', () => {
    const configDir = join(tempDir, '.generacy');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'workspace.yaml'), VALID_YAML);

    const result = findWorkspaceConfigPath(tempDir, '.generacy', 'workspace.yaml');
    expect(result).toBe(join(configDir, 'workspace.yaml'));
  });

  it('returns the nearest config when multiple exist', () => {
    // Create config in parent
    const parentConfigDir = join(tempDir, '.generacy');
    mkdirSync(parentConfigDir);
    writeFileSync(join(parentConfigDir, 'config.yaml'), VALID_YAML);

    // Create config in child
    const child = join(tempDir, 'child');
    const childConfigDir = join(child, '.generacy');
    mkdirSync(childConfigDir, { recursive: true });
    writeFileSync(join(childConfigDir, 'config.yaml'), VALID_YAML);

    const result = findWorkspaceConfigPath(child);
    expect(result).toBe(join(childConfigDir, 'config.yaml'));
  });

  it('skips directories without the config file', () => {
    // Create the .generacy dir but no config.yaml in nested dir
    const nested = join(tempDir, 'nested');
    mkdirSync(join(nested, '.generacy'), { recursive: true });

    // Put the actual config in the parent
    const parentConfigDir = join(tempDir, '.generacy');
    mkdirSync(parentConfigDir);
    writeFileSync(join(parentConfigDir, 'config.yaml'), VALID_YAML);

    const result = findWorkspaceConfigPath(nested);
    expect(result).toBe(join(parentConfigDir, 'config.yaml'));
  });
});

describe('scanForWorkspaceConfig', () => {
  it('returns empty array when no subdirectories have config', () => {
    mkdirSync(join(tempDir, 'project-a'));
    mkdirSync(join(tempDir, 'project-b'));

    const result = scanForWorkspaceConfig(tempDir);
    expect(result).toEqual([]);
  });

  it('finds config in a single subdirectory', () => {
    const configDir = join(tempDir, 'my-project', '.generacy');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), VALID_YAML);

    const result = scanForWorkspaceConfig(tempDir);
    expect(result).toEqual([join(configDir, 'config.yaml')]);
  });

  it('finds configs in multiple subdirectories', () => {
    const configA = join(tempDir, 'project-a', '.generacy');
    const configB = join(tempDir, 'project-b', '.generacy');
    mkdirSync(configA, { recursive: true });
    mkdirSync(configB, { recursive: true });
    writeFileSync(join(configA, 'config.yaml'), VALID_YAML);
    writeFileSync(join(configB, 'config.yaml'), VALID_YAML);

    const result = scanForWorkspaceConfig(tempDir);
    expect(result).toHaveLength(2);
    expect(result).toContain(join(configA, 'config.yaml'));
    expect(result).toContain(join(configB, 'config.yaml'));
  });

  it('skips non-directory entries', () => {
    // Create a file (not a directory) at the top level
    writeFileSync(join(tempDir, 'not-a-dir'), 'hello');

    // Create an actual project with config
    const configDir = join(tempDir, 'real-project', '.generacy');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), VALID_YAML);

    const result = scanForWorkspaceConfig(tempDir);
    expect(result).toEqual([join(configDir, 'config.yaml')]);
  });
});
