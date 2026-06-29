import { describe, expect, it } from 'vitest';
import type { EpicManifest } from '@generacy-ai/cockpit';
import { applyChangeSet, diffPhases, isEmpty } from '../manifest/diff-phases.js';
import type { ParsedEpicBody } from '../manifest/parse-epic-body.js';

function makeParsed(overrides: Partial<ParsedEpicBody> & { phases: ParsedEpicBody['phases'] }): ParsedEpicBody {
  return {
    plan: overrides.plan ?? 'docs/plan.md',
    phases: overrides.phases,
  };
}

function makeManifest(overrides: Partial<EpicManifest> = {}): EpicManifest {
  return {
    epic: {
      repo: 'owner/repo',
      issue: 1,
      slug: 'cockpit',
      plan: 'docs/plan.md',
      ...(overrides.epic ?? {}),
    },
    autonomy: overrides.autonomy ?? {},
    phases: overrides.phases ?? [],
  };
}

describe('diffPhases', () => {
  it('reports rename + added/removed issues for a matched phase', () => {
    const parsed = makeParsed({
      phases: [
        {
          index: 3,
          name: 'P3 — Manifest',
          tier: 'v2',
          issues: ['owner/repo#10', 'owner/repo#11'],
        },
      ],
    });
    const manifest = makeManifest({
      phases: [
        {
          name: 'P3 Manifest',
          tier: 'v2',
          repos: [],
          issues: ['owner/repo#10', 'owner/repo#9'],
        },
      ],
    });
    const diff = diffPhases(parsed, manifest);
    expect(diff.phasesRenamed).toEqual([
      { index: 3, from: 'P3 Manifest', to: 'P3 — Manifest' },
    ]);
    expect(diff.issuesAdded).toEqual({ P3: ['owner/repo#11'] });
    expect(diff.issuesRemoved).toEqual({ P3: ['owner/repo#9'] });
    expect(diff.phasesAdded).toEqual([]);
    expect(diff.phasesRemoved).toEqual([]);
    expect(diff.planChanged).toBeNull();
    expect(isEmpty(diff)).toBe(false);
  });

  it('reports phasesAdded and phasesRemoved correctly', () => {
    const parsed = makeParsed({
      phases: [
        { index: 0, name: 'P0 — Foundation', tier: 'v1', issues: [] },
        { index: 4, name: 'P4 — Queue', tier: 'v3', issues: ['owner/repo#42'] },
      ],
    });
    const manifest = makeManifest({
      phases: [
        { name: 'P0 — Foundation', tier: 'v1', repos: [], issues: [] },
        { name: 'P5 — Reporting', tier: 'v4', repos: [], issues: ['owner/repo#99'] },
      ],
    });
    const diff = diffPhases(parsed, manifest);
    expect(diff.phasesAdded.map((p) => p.index)).toEqual([4]);
    expect(diff.phasesAdded[0]!.tier).toBe('v3');
    expect(diff.phasesAdded[0]!.issues).toEqual(['owner/repo#42']);
    expect(diff.phasesRemoved.map((p) => p.name)).toEqual(['P5 — Reporting']);
  });

  it('populates `planChanged` when body and manifest disagree', () => {
    const parsed = makeParsed({
      plan: 'docs/new-plan.md',
      phases: [{ index: 1, name: 'P1', issues: [] }],
    });
    const manifest = makeManifest({
      epic: {
        repo: 'owner/repo',
        issue: 1,
        slug: 'cockpit',
        plan: 'docs/old-plan.md',
      },
      phases: [{ name: 'P1', repos: [], issues: [] }],
    });
    const diff = diffPhases(parsed, manifest);
    expect(diff.planChanged).toEqual({ from: 'docs/old-plan.md', to: 'docs/new-plan.md' });
  });

  it('returns isEmpty=true for an identity diff', () => {
    const parsed = makeParsed({
      phases: [{ index: 1, name: 'P1 — One', tier: 'v1', issues: ['owner/repo#1'] }],
    });
    const manifest = makeManifest({
      phases: [{ name: 'P1 — One', tier: 'v1', repos: [], issues: ['owner/repo#1'] }],
    });
    expect(isEmpty(diffPhases(parsed, manifest))).toBe(true);
  });
});

describe('applyChangeSet', () => {
  it('preserves `autonomy` and unknown top-level keys', () => {
    const parsed = makeParsed({
      phases: [
        { index: 3, name: 'P3 — Manifest', tier: 'v2', issues: ['owner/repo#10', 'owner/repo#11'] },
        { index: 4, name: 'P4 — Queue', tier: 'v3', issues: ['owner/repo#42'] },
      ],
    });
    const manifestObj = {
      epic: { repo: 'owner/repo', issue: 1, slug: 'cockpit', plan: 'docs/plan.md' },
      autonomy: { gate: 'human' },
      phases: [
        { name: 'P3 Manifest', tier: 'v2', repos: [], issues: ['owner/repo#10'] },
      ],
      customField: { hello: 'world' },
    } as EpicManifest & { customField: { hello: string } };

    const diff = diffPhases(parsed, manifestObj);
    const result = applyChangeSet(manifestObj, diff, parsed) as EpicManifest & {
      customField: { hello: string };
    };

    expect(result.autonomy).toEqual({ gate: 'human' });
    expect(result.customField).toEqual({ hello: 'world' });
    expect(result.phases).toHaveLength(2);
    expect(result.phases[0]!.name).toBe('P3 — Manifest');
    expect(result.phases[0]!.issues).toEqual(['owner/repo#10', 'owner/repo#11']);
    expect(result.phases[1]!.name).toBe('P4 — Queue');
    expect(result.phases[1]!.repos).toEqual([]);
    expect(result.phases[1]!.tier).toBe('v3');
    expect(result.phases[1]!.issues).toEqual(['owner/repo#42']);
  });

  it('removes vanished phases and updates plan', () => {
    const parsed = makeParsed({
      plan: 'docs/new.md',
      phases: [{ index: 1, name: 'P1', tier: 'v1', issues: [] }],
    });
    const manifest = makeManifest({
      epic: { repo: 'owner/repo', issue: 1, slug: 'cockpit', plan: 'docs/old.md' },
      phases: [
        { name: 'P1', tier: 'v1', repos: [], issues: [] },
        { name: 'P2 Removed', tier: 'v2', repos: [], issues: [] },
      ],
    });
    const diff = diffPhases(parsed, manifest);
    applyChangeSet(manifest, diff, parsed);
    expect(manifest.phases.map((p) => p.name)).toEqual(['P1']);
    expect(manifest.epic.plan).toBe('docs/new.md');
  });
});
