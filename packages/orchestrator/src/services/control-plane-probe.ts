import net from 'node:net';

const DEFAULT_SOCKET_PATH = '/run/generacy-control-plane/control.sock';
const DEFAULT_TIMEOUT_MS = 500;

/**
 * Probes whether the control-plane daemon is alive by attempting a unix socket connection.
 * Returns true if the socket accepts a connection within the timeout period.
 */
export function probeControlPlaneSocket(
  socketPath?: string,
  timeoutMs?: number,
): Promise<boolean> {
  const path = socketPath ?? process.env['CONTROL_PLANE_SOCKET_PATH'] ?? DEFAULT_SOCKET_PATH;
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const sock = net.connect(path);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeout);

    sock.once('connect', () => {
      clearTimeout(timer);
      sock.end();
      resolve(true);
    });

    sock.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
