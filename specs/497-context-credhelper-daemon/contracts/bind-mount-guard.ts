/**
 * Contract: docker-bind-mount-guard.ts
 *
 * Public API for the bind-mount validation module.
 * Validates that POST /containers/create bind mounts
 * only reference paths under the session scratch directory.
 */

// --- Types ---

export interface BindMountViolation {
  /** Raw source path from the Docker API request */
  source: string;
  /** Canonicalized source path after path.resolve() */
  resolvedSource: string;
  /** Which field the mount was found in */
  field: 'Binds' | 'Mounts';
}

export interface BindMountValidationResult {
  valid: boolean;
  violations: BindMountViolation[];
}

/** Partial Docker mount entry — only fields we inspect */
export interface DockerMountEntry {
  Type: 'bind' | 'volume' | 'tmpfs' | 'npipe' | 'cluster';
  Source?: string;
  Target?: string;
}

/** Partial Docker create request body — only fields we inspect */
export interface DockerCreateBody {
  HostConfig?: {
    Binds?: string[];
    Mounts?: DockerMountEntry[];
  };
}

// --- Functions ---

/**
 * Validate that all bind mounts in a Docker container create request
 * reference paths under the allowed scratch directory.
 *
 * @param body - Parsed JSON body from POST /containers/create
 * @param scratchDir - Absolute path to the allowed scratch directory
 * @returns Validation result with any violations
 *
 * Behavior:
 * - Extracts source paths from HostConfig.Binds (format "src:dst[:opts]")
 * - Extracts source paths from HostConfig.Mounts (Type === "bind" only)
 * - Canonicalizes each source with path.resolve()
 * - Checks that resolved path starts with scratchDir + "/" or equals scratchDir
 * - Returns {valid: true} if no bind mounts or all are under scratchDir
 * - Returns {valid: false, violations: [...]} if any are outside
 */
export declare function validateBindMounts(
  body: DockerCreateBody,
  scratchDir: string,
): BindMountValidationResult;

/**
 * Buffer an incoming HTTP request body up to maxBytes.
 * Rejects with DOCKER_ACCESS_DENIED if the body exceeds the limit.
 *
 * @param req - Node.js IncomingMessage
 * @param maxBytes - Maximum body size (default: 10MB)
 * @returns The buffered body as a string
 */
export declare function bufferRequestBody(
  req: import('node:http').IncomingMessage,
  maxBytes?: number,
): Promise<string>;
