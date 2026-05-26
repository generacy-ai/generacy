import { describe, it, expect } from 'vitest';
import { PollResponseSchema } from '../../src/types.js';

describe('PollResponseSchema', () => {
  it('accepts approved response with cloud_url', () => {
    const input = {
      status: 'approved',
      cluster_api_key: 'key-1',
      cluster_api_key_id: 'kid-1',
      cluster_id: 'cl-1',
      project_id: 'pj-1',
      org_id: 'org-1',
      cloud_url: 'https://custom.generacy.example.com',
    };
    const result = PollResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(input);
    }
  });

  it('rejects approved response without cloud_url', () => {
    const input = {
      status: 'approved',
      cluster_api_key: 'key-1',
      cluster_api_key_id: 'kid-1',
      cluster_id: 'cl-1',
      project_id: 'pj-1',
      org_id: 'org-1',
    };
    const result = PollResponseSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects approved response with invalid cloud_url', () => {
    const input = {
      status: 'approved',
      cluster_api_key: 'key-1',
      cluster_api_key_id: 'kid-1',
      cluster_id: 'cl-1',
      project_id: 'pj-1',
      org_id: 'org-1',
      cloud_url: 'not-a-url',
    };
    const result = PollResponseSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('still accepts non-approved statuses without cloud_url', () => {
    expect(PollResponseSchema.safeParse({ status: 'authorization_pending' }).success).toBe(true);
    expect(PollResponseSchema.safeParse({ status: 'slow_down' }).success).toBe(true);
    expect(PollResponseSchema.safeParse({ status: 'expired' }).success).toBe(true);
  });

  it('accepts tier-limit-exceeded response with cap, requested, tier', () => {
    const input = {
      status: 'tier-limit-exceeded',
      cap: 5,
      requested: 10,
      tier: 'basic',
    };
    const result = PollResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(input);
    }
  });

  it('rejects tier-limit-exceeded response missing cap', () => {
    const input = {
      status: 'tier-limit-exceeded',
      requested: 10,
      tier: 'basic',
    };
    const result = PollResponseSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects tier-limit-exceeded response with non-integer requested', () => {
    const input = {
      status: 'tier-limit-exceeded',
      cap: 5,
      requested: 0,
      tier: 'basic',
    };
    const result = PollResponseSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});
