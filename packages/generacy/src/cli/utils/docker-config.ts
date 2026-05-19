import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';

export interface ScopedDockerConfigOptions {
  projectDir: string;
  host: string;
  username: string;
  password: string;
}

/**
 * Write a scoped Docker config.json with registry auth for a single host.
 */
export function materializeScopedDockerConfig(options: ScopedDockerConfigOptions): void {
  const { projectDir, host, username, password } = options;
  const configDir = getScopedDockerConfigPath(projectDir);
  const configFile = path.join(configDir, 'config.json');

  fs.mkdirSync(configDir, { recursive: true });

  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  const config = {
    auths: {
      [host]: { auth },
    },
  };

  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Remove the scoped Docker config directory.
 */
export function cleanupScopedDockerConfig(projectDir: string): void {
  const configDir = getScopedDockerConfigPath(projectDir);
  fs.rmSync(configDir, { recursive: true, force: true });
}

/**
 * Return the path to the scoped Docker config directory (for DOCKER_CONFIG env).
 */
export function getScopedDockerConfigPath(projectDir: string): string {
  return path.join(projectDir, '.generacy', '.docker');
}

/**
 * Extract the registry host from a Docker image reference.
 * Returns undefined for Docker Hub images (no host prefix).
 */
export function extractImageHost(image: string): string | undefined {
  // Remove digest suffix first
  const ref = image.split('@')[0]!;
  const firstSlash = ref.indexOf('/');
  if (firstSlash === -1) {
    // No slash = Docker Hub library image (e.g., "ubuntu" or "ubuntu:22.04")
    return undefined;
  }

  const firstSegment = ref.slice(0, firstSlash);
  // A registry host contains a dot or colon (port)
  if (firstSegment.includes('.') || firstSegment.includes(':')) {
    return firstSegment;
  }

  // Otherwise it's a Docker Hub user image (e.g., "myuser/myimage")
  return undefined;
}
