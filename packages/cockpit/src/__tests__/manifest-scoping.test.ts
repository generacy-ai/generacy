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

  it('manifest hit returns union of phases[*].issues for matching owner/repo', async () => {
    await copyFile(FIXTURE_PATH, join(manifestRoot, 'epic-cockpit.yaml'));
    const result = await resolveEpicIssues(786, 'generacy-ai', 'generacy', {
      manifestRoot,
    });
    expect(result).toEqual([786, 787]);
  });

  it('manifest hit filters out entries from other repos', async () => {
    await copyFile(FIXTURE_PATH, join(manifestRoot, 'epic-cockpit.yaml'));
    // ui phase references generacy-ai/generacy-extension#42 — not in scope for generacy-ai/generacy
    const result = await resolveEpicIssues(786, 'generacy-ai', 'generacy', {
      manifestRoot,
    });
    expect(result).not.toContain(42);
  });

  it('manifest hit resolves the extension repo', async () => {
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

  it('manifest miss falls back to gh queries (merge + dedupe)', async () => {
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
    expect(result).toEqual([100, 101, 102]);
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
    expect(result).toEqual([42]);
  });

  it('skips malformed manifest, continues to find valid sibling', async () => {
    const bad = join(manifestRoot, 'bad.yaml');
    await writeFile(bad, 'epic:\n  repo: not-a-valid-repo\n', 'utf-8');
    await copyFile(FIXTURE_PATH, join(manifestRoot, 'epic-cockpit.yaml'));
    const warnings: string[] = [];
    const result = await resolveEpicIssues(786, 'generacy-ai', 'generacy', {
      manifestRoot,
      logger: { warn: (msg) => warnings.push(msg) },
    });
    expect(result).toEqual([786, 787]);
    expect(warnings.some((w) => w.includes('bad.yaml'))).toBe(true);
  });

  it('returns deterministic ordering across manifest and fallback', async () => {
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
    expect(result).toEqual([10, 20, 30, 40, 50]);
  });
});
