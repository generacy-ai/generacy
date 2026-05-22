import { describe, it, expect } from 'vitest';
import { addLinkedPR } from './linked-pr.js';
import type { WorkflowState } from '../types/store.js';

const baseState: WorkflowState = {
  version: '1.0',
  workflowId: 'test-workflow',
  workflowFile: 'workflows/test.yaml',
  currentPhase: 'implement',
  currentStep: 'code',
  inputs: {},
  stepOutputs: {},
  startedAt: '2024-01-15T10:00:00Z',
  updatedAt: '2024-01-15T10:00:00Z',
};

const prA = {
  repo: 'generacy-cloud',
  number: 42,
  branch: 'feat/cross-repo',
  url: 'https://github.com/generacy-ai/generacy-cloud/pull/42',
};

const prB = {
  repo: 'cluster-base',
  number: 7,
  branch: 'feat/cluster-fix',
  url: 'https://github.com/generacy-ai/cluster-base/pull/7',
};

describe('addLinkedPR', () => {
  it('should append to undefined linkedPRs', () => {
    const result = addLinkedPR(baseState, prA);
    expect(result.linkedPRs).toEqual([prA]);
  });

  it('should append to empty linkedPRs', () => {
    const state = { ...baseState, linkedPRs: [] };
    const result = addLinkedPR(state, prA);
    expect(result.linkedPRs).toEqual([prA]);
  });

  it('should append distinct entries', () => {
    const state = addLinkedPR(baseState, prA);
    const result = addLinkedPR(state, prB);
    expect(result.linkedPRs).toEqual([prA, prB]);
  });

  it('should de-duplicate on repo + number', () => {
    const state = addLinkedPR(baseState, prA);
    const duplicate = { ...prA, branch: 'other-branch' };
    const result = addLinkedPR(state, duplicate);
    expect(result.linkedPRs).toHaveLength(1);
    expect(result.linkedPRs![0].branch).toBe('other-branch');
  });

  it('should update URL on duplicate', () => {
    const state = addLinkedPR(baseState, prA);
    const updated = { ...prA, url: 'https://example.com/new-url' };
    const result = addLinkedPR(state, updated);
    expect(result.linkedPRs).toHaveLength(1);
    expect(result.linkedPRs![0].url).toBe('https://example.com/new-url');
  });

  it('should not mutate the original state', () => {
    const state = { ...baseState, linkedPRs: [prA] };
    const originalLinkedPRs = [...state.linkedPRs];
    addLinkedPR(state, prB);
    expect(state.linkedPRs).toEqual(originalLinkedPRs);
  });
});
