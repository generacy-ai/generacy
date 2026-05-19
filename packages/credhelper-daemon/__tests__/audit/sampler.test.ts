import { describe, it, expect } from 'vitest';
import { AuditSampler } from '../../src/audit/sampler.js';

describe('AuditSampler', () => {
  it('fires on every 100th request by default', () => {
    const sampler = new AuditSampler();
    let fires = 0;
    for (let i = 0; i < 200; i++) {
      if (sampler.shouldRecord()) fires++;
    }
    expect(fires).toBe(2);
  });

  it('fires on every Nth request with custom rate', () => {
    const sampler = new AuditSampler(10);
    let fires = 0;
    for (let i = 0; i < 30; i++) {
      if (sampler.shouldRecord()) fires++;
    }
    expect(fires).toBe(3);
  });

  it('overrides to 100% when recordAllProxy is true', () => {
    const sampler = new AuditSampler(100);
    let fires = 0;
    for (let i = 0; i < 50; i++) {
      if (sampler.shouldRecord(true)) fires++;
    }
    expect(fires).toBe(50);
  });

  it('uses default rate when recordAllProxy is false', () => {
    const sampler = new AuditSampler(10);
    let fires = 0;
    for (let i = 0; i < 20; i++) {
      if (sampler.shouldRecord(false)) fires++;
    }
    expect(fires).toBe(2);
  });

  it('resets counter', () => {
    const sampler = new AuditSampler(5);
    // Advance counter partway
    sampler.shouldRecord();
    sampler.shouldRecord();
    sampler.reset();
    // After reset, should need 5 more calls to fire
    let fires = 0;
    for (let i = 0; i < 5; i++) {
      if (sampler.shouldRecord()) fires++;
    }
    expect(fires).toBe(1);
  });
});
