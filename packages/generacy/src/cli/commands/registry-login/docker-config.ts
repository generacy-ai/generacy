import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface DockerAuthEntry {
  auth: string;
}

export interface DockerConfig {
  auths: Record<string, DockerAuthEntry>;
}

export function getDockerConfigDir(generacyDir: string): string {
  return join(generacyDir, '.docker');
}

export function dockerConfigExists(generacyDir: string): boolean {
  return existsSync(join(getDockerConfigDir(generacyDir), 'config.json'));
}

export function readDockerConfig(generacyDir: string): DockerConfig {
  const configPath = join(getDockerConfigDir(generacyDir), 'config.json');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as DockerConfig;
  } catch {
    return { auths: {} };
  }
}

export function writeDockerConfig(generacyDir: string, config: DockerConfig): void {
  const dir = getDockerConfigDir(generacyDir);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'config.json');
  const tmpPath = configPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(config, null, 2));
  renameSync(tmpPath, configPath);
}

export function addAuth(config: DockerConfig, host: string, username: string, password: string): DockerConfig {
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  return {
    ...config,
    auths: {
      ...config.auths,
      [host]: { auth },
    },
  };
}

export function removeAuth(config: DockerConfig, host: string): DockerConfig {
  const { [host]: _, ...rest } = config.auths;
  return {
    ...config,
    auths: rest,
  };
}
