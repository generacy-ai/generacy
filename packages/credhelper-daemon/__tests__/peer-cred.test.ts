import net from 'node:net';

import { extractPeerCredentials, verifyPeer } from '../src/peer-cred.js';

describe('extractPeerCredentials', () => {
  it('returns null for a socket without _handle', () => {
    const socket = {} as any as net.Socket;
    expect(extractPeerCredentials(socket)).toBeNull();
  });

  it('returns null for a socket with _handle but no fd', () => {
    const socket = { _handle: {} } as any as net.Socket;
    expect(extractPeerCredentials(socket)).toBeNull();
  });
});

describe('verifyPeer', () => {
  it('does nothing when enablePeerCred is false', () => {
    const socket = {} as any as net.Socket;
    // Should not throw or warn
    expect(() => verifyPeer(socket, 1000, false)).not.toThrow();
  });

  it('logs warning and allows connection when SO_PEERCRED is unavailable', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const socket = {} as any as net.Socket;

    expect(() => verifyPeer(socket, 1000, true)).not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      '[credhelper] SO_PEERCRED unavailable, relying on DAC (filesystem permissions) only',
    );

    warnSpy.mockRestore();
  });

  it('calls console.warn with the DAC fallback message', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const socket = { _handle: { fd: 5 } } as any as net.Socket;

    verifyPeer(socket, 1000, true);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('DAC'),
    );

    warnSpy.mockRestore();
  });
});
