import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildClaudeSeed,
  scaffoldClaudeSeed,
} from '../../../src/cli/commands/cluster/scaffolder.js';

describe('buildClaudeSeed', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-seed-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeHostConfig(contents: unknown): string {
    const path = join(dir, '.claude.json');
    writeFileSync(path, JSON.stringify(contents), 'utf-8');
    return path;
  }

  it('carries account and onboarding state', () => {
    const path = writeHostConfig({
      oauthAccount: { emailAddress: 'operator@example.com' },
      userID: 'user-1',
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.211',
    });

    expect(buildClaudeSeed(path)).toEqual({
      oauthAccount: { emailAddress: 'operator@example.com' },
      userID: 'user-1',
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.211',
    });
  });

  it('drops mcpServers so one cluster cannot poison another', () => {
    // The whole reason for seeding rather than sharing: this path is
    // image-flavour-specific and does not exist in a source-build cluster.
    const path = writeHostConfig({
      userID: 'user-1',
      mcpServers: {
        agency: {
          type: 'stdio',
          command: 'node',
          args: ['/shared-packages/node_modules/@generacy-ai/agency/dist/cli.js'],
        },
      },
    });

    expect(buildClaudeSeed(path)).not.toHaveProperty('mcpServers');
  });

  it('drops host-specific project history and machine identity', () => {
    const path = writeHostConfig({
      userID: 'user-1',
      projects: { '/home/operator/work/repo': { history: ['...'] } },
      machineID: 'host-machine',
      cachedGrowthBookFeatures: { flag: true },
    });

    const seed = buildClaudeSeed(path);
    expect(seed).not.toHaveProperty('projects');
    expect(seed).not.toHaveProperty('machineID');
    expect(seed).not.toHaveProperty('cachedGrowthBookFeatures');
  });

  it('returns an empty seed when the host config is missing', () => {
    expect(buildClaudeSeed(join(dir, 'does-not-exist.json'))).toEqual({});
  });

  it('returns an empty seed rather than throwing on malformed JSON', () => {
    const path = join(dir, '.claude.json');
    writeFileSync(path, '{ not json', 'utf-8');

    expect(buildClaudeSeed(path)).toEqual({});
  });
});

describe('scaffoldClaudeSeed', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-seed-dir-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes an empty seed when not seeding from the host', () => {
    scaffoldClaudeSeed(dir, false);

    expect(JSON.parse(readFileSync(join(dir, 'claude.json'), 'utf-8'))).toEqual({});
  });

  it('does not overwrite an existing seed', () => {
    // Operators may hand-tune the seed; re-scaffolding must not revert it.
    writeFileSync(join(dir, 'claude.json'), '{"userID":"hand-tuned"}', 'utf-8');

    scaffoldClaudeSeed(dir, false);

    expect(JSON.parse(readFileSync(join(dir, 'claude.json'), 'utf-8'))).toEqual({
      userID: 'hand-tuned',
    });
  });
});
