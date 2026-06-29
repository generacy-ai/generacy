import { describe, expect, it, vi } from 'vitest';
import type { CockpitConfig } from '@generacy-ai/cockpit';
import { resolveScope } from '../shared/scoping.js';
import { FakeGh, makeIssue } from './helpers/fake-gh.js';

const config: CockpitConfig = {
  owner: undefined,
  repos: ['generacy-ai/generacy', 'generacy-ai/tetrad'],
  orchestrator: { baseUrl: 'http://localhost:3100' },
};

describe('resolveScope', () => {
  it('returns kind: repos when --epic is absent', async () => {
    const gh = new FakeGh();
    const scope = await resolveScope({ config, gh });
    expect(scope).toEqual({ kind: 'repos', repos: config.repos });
  });

  it('honors reposOverride over config.repos', async () => {
    const gh = new FakeGh();
    const scope = await resolveScope({
      config,
      gh,
      reposOverride: ['foo/bar'],
    });
    expect(scope).toEqual({ kind: 'repos', repos: ['foo/bar'] });
  });

  it('throws on malformed --epic (no slash)', async () => {
    const gh = new FakeGh();
    await expect(
      resolveScope({ epic: 'tetrad-development#85', config, gh }),
    ).rejects.toThrow('--epic must be owner/repo#NNN');
  });

  it('throws on malformed --epic (no repo)', async () => {
    const gh = new FakeGh();
    await expect(resolveScope({ epic: '#85', config, gh })).rejects.toThrow();
  });

  it('throws on malformed --epic (missing issue)', async () => {
    const gh = new FakeGh();
    await expect(resolveScope({ epic: 'o/r', config, gh })).rejects.toThrow();
  });

  it('resolves a well-formed --epic to {kind:epic, issues[]}', async () => {
    const gh = new FakeGh({
      issuesByQuery: (query: string): ReturnType<typeof makeIssue>[] => {
        // Restrict hits to the epic's own repo so the assertion below stays
        // narrow even though the fallback now iterates config.repos too.
        if (!query.includes('repo:generacy-ai/generacy ')) return [];
        if (query.includes('label:epic-child')) {
          return [makeIssue({ number: 100 }), makeIssue({ number: 101 })];
        }
        if (query.includes('in:body')) {
          return [makeIssue({ number: 101 }), makeIssue({ number: 102 })];
        }
        return [];
      },
    });
    const scope = await resolveScope({
      epic: 'generacy-ai/generacy#787',
      config,
      gh,
      cwd: '/tmp/no-manifest-here',
      logger: { warn: vi.fn() },
    });
    expect(scope.kind).toBe('epic');
    if (scope.kind === 'epic') {
      expect(scope.owner).toBe('generacy-ai');
      expect(scope.repo).toBe('generacy');
      expect(scope.ownerRepo).toBe('generacy-ai/generacy');
      expect(scope.issues).toEqual([
        { repo: 'generacy-ai/generacy', number: 100 },
        { repo: 'generacy-ai/generacy', number: 101 },
        { repo: 'generacy-ai/generacy', number: 102 },
      ]);
    }
  });

  it('threads config.repos through to resolveEpicIssues so cross-repo children resolve', async () => {
    const gh = new FakeGh({
      issuesByQuery: (query: string): ReturnType<typeof makeIssue>[] => {
        if (query.includes('repo:generacy-ai/tetrad') && query.includes('label:epic-child')) {
          return [makeIssue({ number: 50 })];
        }
        if (query.includes('repo:generacy-ai/generacy') && query.includes('label:epic-child')) {
          return [makeIssue({ number: 10 })];
        }
        return [];
      },
    });
    const scope = await resolveScope({
      epic: 'generacy-ai/generacy#787',
      config,
      gh,
      cwd: '/tmp/no-manifest-here',
      logger: { warn: vi.fn() },
    });
    expect(scope.kind).toBe('epic');
    if (scope.kind === 'epic') {
      const repos = [...new Set(scope.issues.map((r) => r.repo))].sort();
      expect(repos).toEqual(['generacy-ai/generacy', 'generacy-ai/tetrad']);
      expect(scope.issues).toContainEqual({ repo: 'generacy-ai/tetrad', number: 50 });
      expect(scope.issues).toContainEqual({ repo: 'generacy-ai/generacy', number: 10 });
    }
  });
});
