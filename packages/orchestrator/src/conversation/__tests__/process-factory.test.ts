import { EventEmitter } from 'node:events';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const { mockSpawn } = vi.hoisted(() => {
  const mockSpawn = vi.fn();
  return { mockSpawn };
});

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

import { conversationProcessFactory } from '../process-factory.js';

function createMockChildProcess() {
  const child = new EventEmitter();
  (child as any).stdout = new EventEmitter();
  (child as any).stderr = new EventEmitter();
  (child as any).stdin = new EventEmitter();
  (child as any).pid = 12345;
  (child as any).kill = vi.fn(() => true);
  return child;
}

describe('conversationProcessFactory', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(createMockChildProcess());
  });

  it('forwards uid when provided', () => {
    conversationProcessFactory.spawn('claude', ['--version'], {
      cwd: '/workspace',
      env: {},
      uid: 1000,
    });

    const spawnOptions = mockSpawn.mock.calls[0][2];
    expect(spawnOptions.uid).toBe(1000);
  });

  it('forwards gid when provided', () => {
    conversationProcessFactory.spawn('claude', ['--version'], {
      cwd: '/workspace',
      env: {},
      gid: 2000,
    });

    const spawnOptions = mockSpawn.mock.calls[0][2];
    expect(spawnOptions.gid).toBe(2000);
  });

  it('forwards both uid and gid when provided', () => {
    conversationProcessFactory.spawn('claude', ['--version'], {
      cwd: '/workspace',
      env: {},
      uid: 1000,
      gid: 2000,
    });

    const spawnOptions = mockSpawn.mock.calls[0][2];
    expect(spawnOptions.uid).toBe(1000);
    expect(spawnOptions.gid).toBe(2000);
  });

  it('does not include uid/gid keys in spawn options when omitted', () => {
    conversationProcessFactory.spawn('claude', ['--version'], {
      cwd: '/workspace',
      env: {},
    });

    const spawnOptions = mockSpawn.mock.calls[0][2];
    expect(Object.keys(spawnOptions)).not.toContain('uid');
    expect(Object.keys(spawnOptions)).not.toContain('gid');
  });
});
