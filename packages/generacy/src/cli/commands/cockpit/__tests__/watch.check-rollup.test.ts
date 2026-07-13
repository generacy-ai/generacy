import { describe, expect, it } from 'vitest';
import type { CheckRunSummary } from '@generacy-ai/cockpit';
import { rollup } from '../watch/check-rollup.js';

function check(state: CheckRunSummary['state']): CheckRunSummary {
  return { name: state, state };
}

describe('rollup', () => {
  it('empty → none (was pending pre-#857)', () => {
    expect(rollup([])).toBe('none');
  });

  it('all SUCCESS → success', () => {
    expect(rollup([check('SUCCESS'), check('SUCCESS')])).toBe('success');
  });

  it('single PENDING → pending (non-empty behavior unchanged)', () => {
    expect(rollup([check('PENDING')])).toBe('pending');
  });

  it('single SUCCESS → success (non-empty behavior unchanged)', () => {
    expect(rollup([check('SUCCESS')])).toBe('success');
  });

  it('single FAILURE → failure (non-empty behavior unchanged)', () => {
    expect(rollup([check('FAILURE')])).toBe('failure');
  });

  it('mix of SUCCESS/NEUTRAL/SKIPPED → success', () => {
    expect(rollup([check('SUCCESS'), check('NEUTRAL'), check('SKIPPED')])).toBe('success');
  });

  it('any FAILURE → failure (precedes pending)', () => {
    expect(rollup([check('SUCCESS'), check('FAILURE'), check('PENDING')])).toBe('failure');
  });

  it('any CANCELLED → failure', () => {
    expect(rollup([check('SUCCESS'), check('CANCELLED')])).toBe('failure');
  });

  it('mix with PENDING but no FAILURE → pending', () => {
    expect(rollup([check('SUCCESS'), check('PENDING')])).toBe('pending');
  });
});
