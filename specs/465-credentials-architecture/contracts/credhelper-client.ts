/**
 * Contract: CredhelperClient interface
 *
 * HTTP-over-Unix-socket client for the credhelper daemon's control API.
 * Used by the credentials interceptor in AgentLauncher.
 */

// --- Client Interface ---

export interface CredhelperClient {
  /**
   * Begin a credhelper session for the given role.
   * Calls POST /sessions on the daemon control socket.
   *
   * @throws CredhelperUnavailableError if daemon is not responding
   * @throws CredhelperSessionError if session creation fails (e.g., unknown role)
   */
  beginSession(role: string, sessionId: string): Promise<BeginSessionResult>;

  /**
   * End a credhelper session. Calls DELETE /sessions/:id on the daemon.
   * Fire-and-forget semantics — callers should catch and log errors.
   *
   * @throws CredhelperUnavailableError if daemon is not responding
   * @throws CredhelperSessionError if session not found
   */
  endSession(sessionId: string): Promise<void>;
}

export interface BeginSessionResult {
  /** Absolute path to the session directory (e.g., /run/generacy-credhelper/sessions/<id>) */
  sessionDir: string;
  /** When the session expires (daemon auto-cleans after this) */
  expiresAt: Date;
}

export interface CredhelperClientOptions {
  /** Unix socket path. Default: /run/generacy-credhelper/control.sock */
  socketPath?: string;
  /** Connection timeout in ms. Default: 5000 */
  connectTimeout?: number;
  /** Request timeout in ms. Default: 30000 */
  requestTimeout?: number;
}

// --- Session Environment Contract ---

/**
 * Environment variables injected into the spawn env when a credhelper session is active.
 * These are merged after the 3-layer env merge (process.env ← plugin ← caller)
 * but before the entrypoint wrapper.
 */
export interface SessionEnvVars {
  GENERACY_SESSION_DIR: string;
  GIT_CONFIG_GLOBAL: string;
  GOOGLE_APPLICATION_CREDENTIALS: string;
  DOCKER_HOST: string;
}

/**
 * Build session env vars from a session directory path.
 */
export function buildSessionEnv(sessionDir: string): SessionEnvVars {
  return {
    GENERACY_SESSION_DIR: sessionDir,
    GIT_CONFIG_GLOBAL: `${sessionDir}/git/config`,
    GOOGLE_APPLICATION_CREDENTIALS: `${sessionDir}/gcp/external-account.json`,
    DOCKER_HOST: `unix://${sessionDir}/docker.sock`,
  };
}

// --- Command Wrapping Contract ---

/**
 * Wrap a command in an entrypoint that sources the session env file.
 * Uses positional parameters to avoid shell escaping.
 *
 * Input:  command='claude', args=['--model', 'opus']
 * Output: command='sh', args=['-c', '. "$GENERACY_SESSION_DIR/env" && exec "$@"', '_', 'claude', '--model', 'opus']
 */
export function wrapCommand(command: string, args: string[]): { command: string; args: string[] } {
  return {
    command: 'sh',
    args: [
      '-c',
      '. "$GENERACY_SESSION_DIR/env" && exec "$@"',
      '_',
      command,
      ...args,
    ],
  };
}

// --- Error Types Contract ---

export class CredhelperUnavailableError extends Error {
  readonly socketPath: string;

  constructor(socketPath: string, cause?: Error) {
    super(
      `Cannot begin session — credhelper not responding at ${socketPath}\n` +
      '(is the credhelper daemon running? check worker container entrypoint)',
    );
    this.name = 'CredhelperUnavailableError';
    this.socketPath = socketPath;
    this.cause = cause;
  }
}

export class CredhelperSessionError extends Error {
  readonly code: string;
  readonly role: string;
  readonly sessionId: string;

  constructor(code: string, message: string, role: string, sessionId: string) {
    super(`Credhelper session error [${code}] for role '${role}' (session ${sessionId}): ${message}`);
    this.name = 'CredhelperSessionError';
    this.code = code;
    this.role = role;
    this.sessionId = sessionId;
  }
}
