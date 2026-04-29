import http from 'node:http';
import path from 'node:path';

/** A Docker mount entry in HostConfig.Mounts format. */
export interface DockerMountEntry {
  Type?: string;
  Source?: string;
  Target?: string;
  ReadOnly?: boolean;
}

/** Relevant fields from a POST /containers/create body. */
export interface DockerCreateBody {
  HostConfig?: {
    Binds?: string[];
    Mounts?: DockerMountEntry[];
  };
}

/** A single bind-mount violation. */
export interface BindMountViolation {
  source: string;
  resolved: string;
  reason: string;
}

/** Result of bind-mount validation. */
export interface BindMountValidationResult {
  valid: boolean;
  violations: BindMountViolation[];
}

/** Maximum request body size for POST /containers/create (10 MB). */
const MAX_BODY_SIZE = 10 * 1024 * 1024;

/**
 * Validate that all bind mounts in a Docker container create request
 * point to paths under the allowed scratchDir.
 *
 * Inspects both HostConfig.Binds (string format "src:dst[:opts]")
 * and HostConfig.Mounts (object format with Type === "bind").
 * Uses path.resolve() for canonicalization to prevent ../ traversal.
 */
export function validateBindMounts(
  body: DockerCreateBody,
  scratchDir: string,
): BindMountValidationResult {
  const violations: BindMountViolation[] = [];
  const resolvedScratch = path.resolve(scratchDir);

  // Check HostConfig.Binds: array of "source:dest[:options]"
  if (body.HostConfig?.Binds) {
    for (const bind of body.HostConfig.Binds) {
      const source = bind.split(':')[0] ?? '';
      const resolved = path.resolve(source);
      if (!resolved.startsWith(resolvedScratch + '/') && resolved !== resolvedScratch) {
        violations.push({
          source,
          resolved,
          reason: `Bind mount source "${source}" resolves to "${resolved}" which is outside scratch dir "${resolvedScratch}"`,
        });
      }
    }
  }

  // Check HostConfig.Mounts: array of { Type, Source, Target }
  if (body.HostConfig?.Mounts) {
    for (const mount of body.HostConfig.Mounts) {
      if (mount.Type !== 'bind') continue;
      const source = mount.Source ?? '';
      const resolved = path.resolve(source);
      if (!resolved.startsWith(resolvedScratch + '/') && resolved !== resolvedScratch) {
        violations.push({
          source,
          resolved,
          reason: `Mount source "${source}" resolves to "${resolved}" which is outside scratch dir "${resolvedScratch}"`,
        });
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Buffer an incoming HTTP request body, enforcing a max size limit.
 * Returns the raw body string, or throws if the limit is exceeded.
 */
export function bufferRequestBody(
  req: http.IncomingMessage,
  maxBytes: number = MAX_BODY_SIZE,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      totalSize += chunk.length;
      if (totalSize > maxBytes) {
        rejected = true;
        reject(new Error(`Request body exceeds maximum size of ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    req.on('error', reject);
  });
}
