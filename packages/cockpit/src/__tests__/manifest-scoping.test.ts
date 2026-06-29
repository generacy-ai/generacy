import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEpicIssues } from '../manifest/scoping.js';
import type { GhWrapper, Issue, ListIssuesOptions, CheckRunSummary } from '../gh/wrapper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, 'fixtures', 'epic-cockpit.yaml');

class StubGh implements GhWrapper {
  public calls: Array<{ query: string; options?: ListIssuesOptions }> = [];
  constructor(private readonly results: Map<string, Issue[]>) {}
  async listIssues(query: string, options?: ListIssuesOptions): Promise<Issue[]> {
    this.calls.push({ query, options });
    for (const [key, val] of this.results) {
      if (query.includes(key)) return val;
    }
    return [];
  }
  async addLabels(): Promise<void> {
    throw new Error('not implemented');
  }
  async removeLabels(): Promise<void> {
    throw new Error('not implemented');
  }
  async getPullRequestCheckRuns(): Promise<CheckRunSummary[]> {
    throw new Error('not implemented');
  }
}

function makeIssue(number: number, body = ''): Issue {
  return {
    number,
    title: `Issue #${number}`,
    state: 'OPEN',
    labels: [],
    url: `https://github.com/generacy-ai/generacy/issues/${number}`,
    body,
  };
}

describe('resolveEpicIssues', () => {
  let manifestRoot: string;

  beforeEach(async () => {
    manifestRoot = await mkdtemp(join(tmpdir(), 'cockpit-scoping-'));
  });

  afterEach(async () => {
    await rm(manifestRoot, { recursive: true, force: true });
  });

  it('manifest hit returns repo-qualified refs from phases[*].issues', async () => {
    await copyFile(FIXTURE_PATH, join(manifestRoot, 'epic-cockpit.yaml'));
    const result = await resolveEpicIssues(786, 'generacy-ai', 'generacy', {
      manifestRoot,
    });
    expect(result).toEqual([
      { repo: 'generacy-ai/generacy', number: 786 },
      { repo: 'generacy-ai/generacy', number: 787 },
      { repo: 'generacy-ai/generacy-extension', number: 42 },
    ]);
  });

  it('manifest hit preserves cross-repo entries (#801 fix)', async () => {
    await copyFile(FIXTURE_PATH, join(manifestRoot, 'epic-cockpit.yaml'));
    const result = await resolveEpicIssues(786, 'generacy-ai', 'generacy', {
      manifestRoot,
    });
    // The ui phase references generacy-ai/generacy-extension#42; pre-fix this
    // was filtered out, post-fix it must be preserved with its own repo.
    expect(result).toContainEqual({
      repo: 'generacy-ai/generacy-extension',
      number: 42,
    });
  });

  it('manifest hit when epic.repo is the extension repo falls back to gh', async () => {
    await copyFile(FIXTURE_PATH, join(manifestRoot, 'epic-cockpit.yaml'));
    const gh = new StubGh(new Map());
    const result = await resolveEpicIssues(
      786,
      'generacy-ai',
      'generacy-extension',
      { manifestRoot, gh },
    );
    // Manifest's epic.repo is generacy-ai/generacy, so this is a miss → fallback hits gh.
    expect(gh.calls.length).toBeGreaterThan(0);
    expect(result).toEqual([]);
  });

  it('manifest miss falls back to gh queries (merge + dedupe) across single repo', async () => {
    const labelHits = [makeIssue(100), makeIssue(101)];
    const bodyHits = [makeIssue(101), makeIssue(102)];
    const gh = new StubGh(
      new Map([
        ['label:epic-child', labelHits],
        ['in:body', bodyHits],
      ]),
    );
    const result = await resolveEpicIssues(786, 'generacy-ai', 'generacy', {
      manifestRoot,
      gh,
    });
    expect(result).toEqual([
      { repo: 'generacy-ai/generacy', number: 100 },
      { repo: 'generacy-ai/generacy', number: 101 },
      { repo: 'generacy-ai/generacy', number: 102 },
    ]);
    expect(gh.calls).toHaveLength(2);
  });

  it('manifest miss with no gh hits returns empty array', async () => {
    const gh = new StubGh(new Map());
    const result = await resolveEpicIssues(786, 'generacy-ai', 'generacy', {
      manifestRoot,
      gh,
    });
    expect(result).toEqual([]);
  });

  it('manifest miss when manifestRoot does not exist falls back to gh', async () => {
    const gh = new StubGh(new Map([['label:epic-child', [makeIssue(42)]]]));
    const result = await resolveEpicIssues(786, 'generacy-ai', 'generacy', {
      manifestRoot: join(manifestRoot, 'no-such-dir'),
      gh,
    });
    expect(result).toEqual([{ repo: 'generacy-ai/generacy', number: 42 }]);
  });

  it('skips malformed manifest with logger.warn naming file path and reason', async () => {
    const bad = join(manifestRoot, 'bad.yaml');
    await writeFile(bad, 'epic:\n  repo: not-a-valid-repo\n', 'utf-8');
    await copyFile(FIXTURE_PATH, join(manifestRoot, 'epic-cockpit.yaml'));
    const warnings: string[] = [];
    const result = await resolveEpicIssues(786, 'generacy-ai', 'generacy', {
      manifestRoot,
      logger: { warn: (msg) => warnings.push(msg) },
    });
    expect(result.length).toBeGreaterThan(0);
    const matchingWarning = warnings.find((w) => w.includes('bad.yaml'));
    expect(matchingWarning).toBeDefined();
    expect(matchingWarning).toMatch(/skipped malformed manifest/);
  });

  it('malformed-only manifestRoot falls through to fallback gh search', async () => {
    const bad = join(manifestRoot, 'bad.yaml');
    await writeFile(bad, 'epic:\n  repo: not-a-valid-repo\n', 'utf-8');
    const warnings: string[] = [];
    const gh = new StubGh(new Map([['label:epic-child', [makeIssue(99)]]]));
    const result = await resolveEpicIssues(786, 'generacy-ai', 'generacy', {
      manifestRoot,
      gh,
      logger: { warn: (msg) => warnings.push(msg) },
    });
    expect(result).toEqual([{ repo: 'generacy-ai/generacy', number: 99 }]);
    expect(warnings.some((w) => w.includes('bad.yaml'))).toBe(true);
  });

  it('returns deterministic (repo, number) ordering across manifest and fallback', async () => {
    const gh = new StubGh(
      new Map([
        ['label:epic-child', [makeIssue(50), makeIssue(10), makeIssue(30)]],
        ['in:body', [makeIssue(20), makeIssue(40)]],
      ]),
    );
    const result = await resolveEpicIssues(786, 'generacy-ai', 'generacy', {
      manifestRoot,
      gh,
    });
    expect(result).toEqual([
      { repo: 'generacy-ai/generacy', number: 10 },
      { repo: 'generacy-ai/generacy', number: 20 },
      { repo: 'generacy-ai/generacy', number: 30 },
      { repo: 'generacy-ai/generacy', number: 40 },
      { repo: 'generacy-ai/generacy', number: 50 },
    ]);
  });

  describe('fallback path with options.repos (cross-repo)', () => {
    it('iterates repoSet = unique(options.repos ∪ {epicRepo}) running both queries per repo', async () => {
      // Distinct results per repo, distinguishable by query content.
      const gh: GhWrapper = {
        async listIssues(query) {
          if (query.includes('repo:owner-A/repo-A') && query.includes('label:epic-child')) {
            return [makeIssue(1)];
          }
          if (query.includes('repo:owner-A/repo-A') && query.includes('in:body')) {
            return [makeIssue(2)];
          }
          if (query.includes('repo:owner-B/repo-B') && query.includes('label:epic-child')) {
            return [makeIssue(3)];
          }
          if (query.includes('repo:owner-B/repo-B') && query.includes('in:body')) {
            return [makeIssue(4)];
          }
          if (query.includes('repo:owner-C/repo-C') && query.includes('label:epic-child')) {
            return [makeIssue(5)];
          }
          if (query.includes('repo:owner-C/repo-C') && query.includes('in:body')) {
            return [makeIssue(6)];
          }
          return [];
        },
        async addLabels() {
          throw new Error('not implemented');
        },
        async removeLabels() {
          throw new Error('not implemented');
        },
        async getPullRequestCheckRuns() {
          throw new Error('not implemented');
        },
      } as unknown as GhWrapper;
      const result = await resolveEpicIssues(99, 'owner-C', 'repo-C', {
        manifestRoot: join(manifestRoot, 'no-such-dir'),
        gh,
        repos: ['owner-A/repo-A', 'owner-B/repo-B'],
      });
      expect(result).toEqual([
        { repo: 'owner-A/repo-A', number: 1 },
        { repo: 'owner-A/repo-A', number: 2 },
        { repo: 'owner-B/repo-B', number: 3 },
        { repo: 'owner-B/repo-B', number: 4 },
        { repo: 'owner-C/repo-C', number: 5 },
        { repo: 'owner-C/repo-C', number: 6 },
      ]);
    });

    it('embeds full owner/repo#N in queries to avoid cross-repo #N collisions', async () => {
      const calls: string[] = [];
      const gh: GhWrapper = {
        async listIssues(query: string): Promise<Issue[]> {
          calls.push(query);
          return [];
        },
      } as unknown as GhWrapper;
      await resolveEpicIssues(85, 'owner-A', 'repo-A', {
        manifestRoot: join(manifestRoot, 'no-such-dir'),
        gh,
        repos: ['owner-B/repo-B'],
      });
      // 2 repos × 2 queries each = 4 calls.
      expect(calls).toHaveLength(4);
      for (const call of calls) {
        expect(call).toContain('owner-A/repo-A#85');
      }
      expect(calls.some((c) => c.startsWith('repo:owner-A/repo-A '))).toBe(true);
      expect(calls.some((c) => c.startsWith('repo:owner-B/repo-B '))).toBe(true);
    });

    it('dedups repoSet so epicRepo present in options.repos is not double-queried', async () => {
      const calls: string[] = [];
      const gh: GhWrapper = {
        async listIssues(query: string): Promise<Issue[]> {
          calls.push(query);
          return [];
        },
      } as unknown as GhWrapper;
      await resolveEpicIssues(85, 'owner-A', 'repo-A', {
        manifestRoot: join(manifestRoot, 'no-such-dir'),
        gh,
        // epic's own repo also listed in repos
        repos: ['owner-A/repo-A', 'owner-B/repo-B'],
      });
      // Without dedup we'd see 6 calls; with dedup we see 4.
      expect(calls).toHaveLength(4);
    });

    it('warns FR-005 when options.repos omitted and falls back to epic repo only', async () => {
      const warnings: string[] = [];
      const calls: string[] = [];
      const gh: GhWrapper = {
        async listIssues(query: string): Promise<Issue[]> {
          calls.push(query);
          return [];
        },
      } as unknown as GhWrapper;
      await resolveEpicIssues(85, 'owner-A', 'repo-A', {
        manifestRoot: join(manifestRoot, 'no-such-dir'),
        gh,
        logger: { warn: (msg) => warnings.push(msg) },
      });
      // 1 repo × 2 queries = 2 calls.
      expect(calls).toHaveLength(2);
      const found = warnings.find(
        (w) =>
          w.includes('resolveEpicIssues called without configured repos') &&
          w.includes('owner-A/repo-A'),
      );
      expect(found).toBeDefined();
      expect(found).toMatch(/Cross-repo children will not be discovered/);
    });
  });
});
