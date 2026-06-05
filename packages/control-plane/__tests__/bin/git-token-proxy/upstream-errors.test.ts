import { describe, it, expect } from 'vitest';
import { mapUpstreamErrorToCode } from '../../../src/git-token-proxy/index.js';

describe('mapUpstreamErrorToCode', () => {
  it('maps ECONNREFUSED to CONTROL_SOCKET_UNREACHABLE', () => {
    expect(mapUpstreamErrorToCode(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(
      'CONTROL_SOCKET_UNREACHABLE',
    );
  });

  it('maps ENOENT to CONTROL_SOCKET_UNREACHABLE', () => {
    expect(mapUpstreamErrorToCode(Object.assign(new Error('no entry'), { code: 'ENOENT' }))).toBe(
      'CONTROL_SOCKET_UNREACHABLE',
    );
  });

  it('maps ECONNRESET to CONTROL_SOCKET_UNREACHABLE', () => {
    expect(mapUpstreamErrorToCode(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(
      'CONTROL_SOCKET_UNREACHABLE',
    );
  });

  it('maps EPIPE to CONTROL_SOCKET_UNREACHABLE', () => {
    expect(mapUpstreamErrorToCode(Object.assign(new Error('pipe'), { code: 'EPIPE' }))).toBe(
      'CONTROL_SOCKET_UNREACHABLE',
    );
  });

  it('maps timeout-style errors to CONTROL_SOCKET_UNREACHABLE', () => {
    expect(mapUpstreamErrorToCode(new Error('timeout'))).toBe('CONTROL_SOCKET_UNREACHABLE');
  });

  it('maps a generic Error to CONTROL_SOCKET_UNREACHABLE', () => {
    expect(mapUpstreamErrorToCode(new Error('generic'))).toBe('CONTROL_SOCKET_UNREACHABLE');
  });

  it('maps undefined to CONTROL_SOCKET_UNREACHABLE', () => {
    expect(mapUpstreamErrorToCode(undefined)).toBe('CONTROL_SOCKET_UNREACHABLE');
  });
});
