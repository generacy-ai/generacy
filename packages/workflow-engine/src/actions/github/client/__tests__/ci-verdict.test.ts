/**
 * Unit tests for aggregateCiVerdict (#1133 T002/T003).
 *
 * Covers the full truth table in specs/1133-context-repo-ci-yml/contracts/ci-verdict.md.
 * Encodes SC-001: empty input and all-skipped input never yield `green`
 * (skipped≠passed).
 */
import { describe, it, expect } from 'vitest';

import { aggregateCiVerdict } from '../ci-verdict.js';
import type { CiConclusion, CiRun } from '../../../../types/github.js';

/** Build a completed run with the given conclusion. */
function completed(conclusion: CiConclusion): CiRun {
  return { status: 'completed', conclusion };
}

/** Build an in-progress run (status not completed, conclusion null). */
function inProgress(): CiRun {
  return { status: 'in_progress', conclusion: null };
}

describe('aggregateCiVerdict', () => {
  it('empty input → pending (SC-001)', () => {
    expect(aggregateCiVerdict([])).toBe('pending');
  });

  it('all-skipped → pending (SC-001, skipped≠passed)', () => {
    expect(
      aggregateCiVerdict([completed('skipped'), completed('skipped')]),
    ).toBe('pending');
  });

  it('all-neutral → pending (neutral is ignored like skipped)', () => {
    expect(aggregateCiVerdict([completed('neutral')])).toBe('pending');
  });

  it('[success] → green', () => {
    expect(aggregateCiVerdict([completed('success')])).toBe('green');
  });

  it('[success, success] → green', () => {
    expect(
      aggregateCiVerdict([completed('success'), completed('success')]),
    ).toBe('green');
  });

  it('[success, skipped] → green (skipped ignored, concrete success present)', () => {
    expect(
      aggregateCiVerdict([completed('success'), completed('skipped')]),
    ).toBe('green');
  });

  it('[failure] → not-passed', () => {
    expect(aggregateCiVerdict([completed('failure')])).toBe('not-passed');
  });

  it('[success, failure] → not-passed (failure wins)', () => {
    expect(
      aggregateCiVerdict([completed('success'), completed('failure')]),
    ).toBe('not-passed');
  });

  it('[cancelled] → not-passed', () => {
    expect(aggregateCiVerdict([completed('cancelled')])).toBe('not-passed');
  });

  it('[timed_out] → not-passed', () => {
    expect(aggregateCiVerdict([completed('timed_out')])).toBe('not-passed');
  });

  it('[action_required] → not-passed', () => {
    expect(aggregateCiVerdict([completed('action_required')])).toBe('not-passed');
  });

  it('[null] (in-progress) → pending', () => {
    expect(aggregateCiVerdict([inProgress()])).toBe('pending');
  });

  it('[success, null] → pending (in-progress run keeps it pending)', () => {
    expect(aggregateCiVerdict([completed('success'), inProgress()])).toBe(
      'pending',
    );
  });

  it('[failure, null] → not-passed (failure outranks in-progress)', () => {
    expect(aggregateCiVerdict([completed('failure'), inProgress()])).toBe(
      'not-passed',
    );
  });

  it('completed status with null conclusion → pending (treated as in-progress)', () => {
    expect(aggregateCiVerdict([{ status: 'completed', conclusion: null }])).toBe(
      'pending',
    );
  });

  it('unknown terminal conclusion → pending (conservative, not green)', () => {
    expect(
      aggregateCiVerdict([completed('stale' as CiConclusion)]),
    ).toBe('pending');
  });

  it('unknown terminal conclusion alongside success → green', () => {
    expect(
      aggregateCiVerdict([
        completed('success'),
        completed('stale' as CiConclusion),
      ]),
    ).toBe('green');
  });
});
