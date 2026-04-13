import net from 'node:net';

import type { PeerCredentials } from './types.js';
import { CredhelperError } from './errors.js';

/**
 * Attempt to extract peer credentials from a Unix socket.
 * Falls back to DAC-only protection with a warning if SO_PEERCRED is unavailable.
 */
export function extractPeerCredentials(socket: net.Socket): PeerCredentials | null {
  // Try to access the socket's underlying handle for fd
  // Node.js doesn't expose SO_PEERCRED natively, so we fall back
  // to DAC-only protection (filesystem permissions on the socket)
  const handle = (socket as any)._handle;
  if (!handle || typeof handle.fd !== 'number' || handle.fd < 0) {
    return null;
  }
  // SO_PEERCRED would require a native addon - return null to signal DAC-only fallback
  return null;
}

/**
 * Verify that the connecting peer has the expected UID.
 * If peer credentials cannot be extracted, logs a warning and allows
 * the connection (DAC-only fallback — filesystem permissions are the primary gate).
 */
export function verifyPeer(
  socket: net.Socket,
  expectedUid: number,
  enablePeerCred: boolean,
): void {
  if (!enablePeerCred) return;

  const creds = extractPeerCredentials(socket);
  if (creds === null) {
    // DAC-only fallback: filesystem permissions protect the socket
    console.warn('[credhelper] SO_PEERCRED unavailable, relying on DAC (filesystem permissions) only');
    return;
  }

  if (creds.uid !== expectedUid) {
    throw new CredhelperError(
      'PEER_REJECTED',
      `Peer UID ${creds.uid} does not match expected UID ${expectedUid}`,
      { peerUid: creds.uid, expectedUid },
    );
  }
}
