import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { deriveSlug, resolveTargetPath } from '../manifest/derive-slug.js';

describe('deriveSlug', () => {
  it('strips leading `Epic:` and lowercases', () => {
    expect(deriveSlug('Epic: Cockpit', 1)).toBe('cockpit');
  });

  it('strips leading `EPIC:` (uppercase) and kebab-cases punctuation', () => {
    expect(deriveSlug('EPIC: Foo Bar!', 1)).toBe('foo-bar');
  });

  it('falls back to `epic-<number>` for punctuation-only titles', () => {
    expect(deriveSlug('%%%', 85)).toBe('epic-85');
  });

  it('collapses repeated separators', () => {
    expect(deriveSlug('Hello   ---   World', 1)).toBe('hello-world');
  });
});

describe('resolveTargetPath', () => {
  it('uses the --slug flag and reports `source: flag`', () => {
    expect(
      resolveTargetPath({
        manifestRoot: '/tmp/.generacy/epics',
        slug: 'epic-cockpit',
        derivedFromTitle: 'cockpit',
      }),
    ).toEqual({
      source: 'flag',
      slug: 'epic-cockpit',
      path: join('/tmp/.generacy/epics', 'epic-cockpit.yaml'),
    });
  });

  it('falls back to derivedFromTitle and reports `source: derived`', () => {
    expect(
      resolveTargetPath({
        manifestRoot: '/tmp/.generacy/epics',
        derivedFromTitle: 'cockpit',
      }),
    ).toEqual({
      source: 'derived',
      slug: 'cockpit',
      path: join('/tmp/.generacy/epics', 'cockpit.yaml'),
    });
  });
});
