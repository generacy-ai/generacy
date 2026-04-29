import { describe, it, expect } from 'vitest';

import { AuditLog } from '../../src/audit/audit-log.js';
import type { AuditConfig } from '../../src/audit/types.js';

const config: AuditConfig = {
  capacity: 100,
  flushIntervalMs: 60000,
  maxBatchSize: 50,
  controlPlaneSocketPath: '/tmp/test.sock',
  clusterId: 'c1',
  workerId: 'w1',
};

describe('dev-mode field length assertion', () => {
  it('rejects credentialId > 256 chars', () => {
    const log = new AuditLog(config);
    expect(() =>
      log.record({
        action: 'credential.mint',
        credentialId: 'x'.repeat(257),
        success: true,
      }),
    ).toThrow(/exceeds 256 chars/);
  });

  it('rejects errorCode > 256 chars', () => {
    const log = new AuditLog(config);
    expect(() =>
      log.record({
        action: 'credential.mint',
        errorCode: 'e'.repeat(257),
        success: false,
      }),
    ).toThrow(/exceeds 256 chars/);
  });

  it('rejects nested proxy.path > 256 chars', () => {
    const log = new AuditLog(config);
    expect(() =>
      log.record({
        action: 'proxy.docker',
        success: true,
        proxy: { method: 'GET', path: '/'.repeat(257), decision: 'allow' },
      }),
    ).toThrow(/exceeds 256 chars/);
  });

  it('allows fields exactly at 256 chars', () => {
    const log = new AuditLog(config);
    expect(() =>
      log.record({
        action: 'credential.mint',
        credentialId: 'x'.repeat(256),
        success: true,
      }),
    ).not.toThrow();
  });

  it('allows normal-length fields', () => {
    const log = new AuditLog(config);
    expect(() =>
      log.record({
        action: 'session.begin',
        sessionId: 'session-123',
        role: 'developer',
        success: true,
      }),
    ).not.toThrow();
  });
});
