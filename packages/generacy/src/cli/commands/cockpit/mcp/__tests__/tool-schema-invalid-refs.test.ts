import { describe, it, expect } from 'vitest';
import {
  CockpitStatusInputSchema,
  CockpitContextInputSchema,
  CockpitAdvanceInputSchema,
  CockpitResumeInputSchema,
  CockpitQueueInputSchema,
  CockpitMergeInputSchema,
  GateNameInputSchema,
} from '../schemas.js';

describe('tool input schemas: invalid refs', () => {
  it('cockpit_status: empty object → invalid-args', () => {
    expect(CockpitStatusInputSchema.safeParse({}).success).toBe(false);
  });

  it('cockpit_context: missing issue field → invalid-args', () => {
    expect(CockpitContextInputSchema.safeParse({ notIssue: 1 }).success).toBe(false);
  });

  it('cockpit_advance: unknown gate → invalid-args (rejected at schema layer)', () => {
    const result = CockpitAdvanceInputSchema.safeParse({
      issue: { owner: 'a', repo: 'b', number: 1 },
      gate: 'this-gate-does-not-exist',
    });
    expect(result.success).toBe(false);
  });

  it('cockpit_advance: known gate → accepted', () => {
    const result = CockpitAdvanceInputSchema.safeParse({
      issue: { owner: 'a', repo: 'b', number: 1 },
      gate: 'clarification',
    });
    expect(result.success).toBe(true);
  });

  it('cockpit_resume: accepts bare object ref', () => {
    const result = CockpitResumeInputSchema.safeParse({
      issue: { owner: 'a', repo: 'b', number: 1 },
    });
    expect(result.success).toBe(true);
  });

  it('cockpit_queue: rejects missing phase', () => {
    const result = CockpitQueueInputSchema.safeParse({
      epic: { owner: 'a', repo: 'b', number: 1 },
    });
    expect(result.success).toBe(false);
  });

  it('cockpit_merge: rejects missing issue', () => {
    // #928: field renamed from `pr` to `issue`; bare number is rejected because
    // IssueRefInputSchema requires either a qualified string or an object.
    expect(CockpitMergeInputSchema.safeParse({}).success).toBe(false);
    expect(
      CockpitMergeInputSchema.safeParse({
        pr: 15,
      }).success,
    ).toBe(false);
  });

  it('cockpit_merge: accepts { issue: <object>, pr: <positive int> }', () => {
    expect(
      CockpitMergeInputSchema.safeParse({
        issue: { owner: 'a', repo: 'b', number: 2 },
        pr: 15,
      }).success,
    ).toBe(true);
  });

  it('cockpit_merge: accepts issue-only', () => {
    expect(
      CockpitMergeInputSchema.safeParse({
        issue: { owner: 'a', repo: 'b', number: 2 },
      }).success,
    ).toBe(true);
  });

  it('GateNameInputSchema is built from a non-empty gate vocabulary', () => {
    const options = GateNameInputSchema.options;
    expect(options.length).toBeGreaterThan(0);
    expect(options).toContain('clarification');
  });

  it('object ref: owner with slash rejected', () => {
    expect(
      CockpitStatusInputSchema.safeParse({
        epic: { owner: 'a/b', repo: 'r', number: 1 },
      }).success,
    ).toBe(false);
  });

  it('object ref: number must be positive integer', () => {
    expect(
      CockpitStatusInputSchema.safeParse({
        epic: { owner: 'a', repo: 'b', number: -1 },
      }).success,
    ).toBe(false);
    expect(
      CockpitStatusInputSchema.safeParse({
        epic: { owner: 'a', repo: 'b', number: 1.5 },
      }).success,
    ).toBe(false);
  });
});
