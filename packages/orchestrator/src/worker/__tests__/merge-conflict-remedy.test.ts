/**
 * #898 T002 — Assert the shape of `MERGE_CONFLICT_REMEDY` matches the
 * data-model.md contract:
 *   - `steps` tuple has length 3
 *   - `warning` is non-empty
 *   - `warning` contains the substring `re-pause`
 */
import { describe, it, expect } from 'vitest';
import { MERGE_CONFLICT_REMEDY } from '../merge-conflict-remedy.js';

describe('MERGE_CONFLICT_REMEDY (#898 Ship 1)', () => {
  it('has exactly 3 steps', () => {
    expect(MERGE_CONFLICT_REMEDY.steps).toHaveLength(3);
  });

  it('every step is a non-empty string', () => {
    for (const step of MERGE_CONFLICT_REMEDY.steps) {
      expect(typeof step).toBe('string');
      expect(step.length).toBeGreaterThan(0);
    }
  });

  it('has a non-empty warning', () => {
    expect(typeof MERGE_CONFLICT_REMEDY.warning).toBe('string');
    expect(MERGE_CONFLICT_REMEDY.warning.length).toBeGreaterThan(0);
  });

  it('warning contains the substring `re-pause`', () => {
    expect(MERGE_CONFLICT_REMEDY.warning).toContain('re-pause');
  });

  it('step 1 names the resolve-on-branch-and-push flow', () => {
    expect(MERGE_CONFLICT_REMEDY.steps[0]).toContain('<branch>');
    expect(MERGE_CONFLICT_REMEDY.steps[0]).toContain('<base>');
    expect(MERGE_CONFLICT_REMEDY.steps[0]).toContain('push');
  });

  it('step 2 references `generacy cockpit advance` with the merge-conflicts gate', () => {
    expect(MERGE_CONFLICT_REMEDY.steps[1]).toContain('generacy cockpit advance');
    expect(MERGE_CONFLICT_REMEDY.steps[1]).toContain('--gate merge-conflicts');
  });

  it('step 3 describes the re-run behavior', () => {
    expect(MERGE_CONFLICT_REMEDY.steps[2]).toContain('re-runs');
  });
});
