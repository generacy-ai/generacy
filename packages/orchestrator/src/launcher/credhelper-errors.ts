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
