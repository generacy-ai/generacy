import { describe, expect, it } from 'vitest';
import {
  WorkspaceRepoSchema,
  WorkspaceConfigSchema,
  type WorkspaceRepo,
  type WorkspaceConfig,
} from '../workspace-schema.js';

describe('WorkspaceRepoSchema', () => {
  it('accepts a valid repo with all fields', () => {
    const result = WorkspaceRepoSchema.parse({ name: 'generacy', monitor: false });
    expect(result).toEqual({ name: 'generacy', monitor: false });
  });

  it('defaults monitor to true when omitted', () => {
    const result = WorkspaceRepoSchema.parse({ name: 'generacy' });
    expect(result.monitor).toBe(true);
  });

  it('rejects empty name', () => {
    expect(() => WorkspaceRepoSchema.parse({ name: '' })).toThrow();
  });

  it('rejects missing name', () => {
    expect(() => WorkspaceRepoSchema.parse({ monitor: true })).toThrow();
  });

  it('rejects non-string name', () => {
    expect(() => WorkspaceRepoSchema.parse({ name: 123 })).toThrow();
  });

  it('rejects non-boolean monitor', () => {
    expect(() => WorkspaceRepoSchema.parse({ name: 'repo', monitor: 'yes' })).toThrow();
  });
});

describe('WorkspaceConfigSchema', () => {
  const validConfig = {
    org: 'generacy-ai',
    branch: 'main',
    repos: [{ name: 'generacy', monitor: true }],
  };

  it('accepts a valid config with all fields', () => {
    const result = WorkspaceConfigSchema.parse(validConfig);
    expect(result).toEqual(validConfig);
  });

  it('defaults branch to develop when omitted', () => {
    const result = WorkspaceConfigSchema.parse({
      org: 'generacy-ai',
      repos: [{ name: 'generacy' }],
    });
    expect(result.branch).toBe('develop');
  });

  it('defaults monitor to true for repos when omitted', () => {
    const result = WorkspaceConfigSchema.parse({
      org: 'generacy-ai',
      repos: [{ name: 'generacy' }],
    });
    expect(result.repos[0].monitor).toBe(true);
  });

  it('accepts multiple repos', () => {
    const result = WorkspaceConfigSchema.parse({
      org: 'generacy-ai',
      repos: [
        { name: 'tetrad-development', monitor: true },
        { name: 'generacy', monitor: true },
        { name: 'contracts', monitor: false },
      ],
    });
    expect(result.repos).toHaveLength(3);
  });

  it('rejects empty org', () => {
    expect(() =>
      WorkspaceConfigSchema.parse({ org: '', repos: [{ name: 'repo' }] }),
    ).toThrow();
  });

  it('rejects missing org', () => {
    expect(() =>
      WorkspaceConfigSchema.parse({ repos: [{ name: 'repo' }] }),
    ).toThrow();
  });

  it('rejects empty repos array', () => {
    expect(() =>
      WorkspaceConfigSchema.parse({ org: 'generacy-ai', repos: [] }),
    ).toThrow();
  });

  it('rejects missing repos', () => {
    expect(() =>
      WorkspaceConfigSchema.parse({ org: 'generacy-ai' }),
    ).toThrow();
  });

  it('rejects empty branch', () => {
    expect(() =>
      WorkspaceConfigSchema.parse({
        org: 'generacy-ai',
        branch: '',
        repos: [{ name: 'repo' }],
      }),
    ).toThrow();
  });

  it('rejects repo with empty name inside repos array', () => {
    expect(() =>
      WorkspaceConfigSchema.parse({
        org: 'generacy-ai',
        repos: [{ name: '' }],
      }),
    ).toThrow();
  });

  it('preserves explicit branch value', () => {
    const result = WorkspaceConfigSchema.parse({
      org: 'generacy-ai',
      branch: 'main',
      repos: [{ name: 'repo' }],
    });
    expect(result.branch).toBe('main');
  });

  it('preserves explicit monitor: false', () => {
    const result = WorkspaceConfigSchema.parse({
      org: 'generacy-ai',
      repos: [{ name: 'repo', monitor: false }],
    });
    expect(result.repos[0].monitor).toBe(false);
  });
});

describe('type inference', () => {
  it('WorkspaceRepo type matches schema output', () => {
    const repo: WorkspaceRepo = { name: 'generacy', monitor: true };
    const parsed = WorkspaceRepoSchema.parse(repo);
    // Verify the parsed result is assignable to the type
    const typed: WorkspaceRepo = parsed;
    expect(typed.name).toBe('generacy');
    expect(typed.monitor).toBe(true);
  });

  it('WorkspaceConfig type matches schema output', () => {
    const config: WorkspaceConfig = {
      org: 'generacy-ai',
      branch: 'develop',
      repos: [{ name: 'generacy', monitor: true }],
    };
    const parsed = WorkspaceConfigSchema.parse(config);
    const typed: WorkspaceConfig = parsed;
    expect(typed.org).toBe('generacy-ai');
    expect(typed.branch).toBe('develop');
    expect(typed.repos).toHaveLength(1);
  });
});
