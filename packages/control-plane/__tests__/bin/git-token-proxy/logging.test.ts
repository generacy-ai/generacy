import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logProxyInit, logUpstreamError } from '../../../src/git-token-proxy/index.js';

describe('logging helpers', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('logProxyInit emits exactly one JSON line with the closed shape', () => {
    logProxyInit({
      listenSocket: '/run/generacy-git-token/control.sock',
      upstreamSocket: '/run/generacy-control-plane/control.sock',
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const arg = logSpy.mock.calls[0]?.[0];
    expect(arg).toBe(
      JSON.stringify({
        event: 'git-token-proxy-init',
        listenSocket: '/run/generacy-git-token/control.sock',
        upstreamSocket: '/run/generacy-control-plane/control.sock',
      }),
    );
  });

  it('logUpstreamError emits exactly one JSON line with the closed shape', () => {
    logUpstreamError({ code: 'CONTROL_SOCKET_UNREACHABLE' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const arg = logSpy.mock.calls[0]?.[0];
    expect(arg).toBe(
      JSON.stringify({
        event: 'git-token-proxy-upstream-error',
        code: 'CONTROL_SOCKET_UNREACHABLE',
      }),
    );
  });

  it('does not invoke other console methods', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    logProxyInit({ listenSocket: '/a', upstreamSocket: '/b' });
    logUpstreamError({ code: 'CONTROL_SOCKET_UNREACHABLE' });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    infoSpy.mockRestore();
  });
});
