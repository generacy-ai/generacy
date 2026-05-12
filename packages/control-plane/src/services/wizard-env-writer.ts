import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { getCredentialBackend } from './credential-writer.js';
import { getRelayPushEvent } from '../relay-events.js';

export interface WriteWizardEnvFileOptions {
  /** Path to .agency directory containing credentials.yaml */
  agencyDir: string;
  /** Output path for the env file (default: /var/lib/generacy/wizard-credentials.env) */
  envFilePath?: string;
}

export interface WriteWizardEnvFileResult {
  /** Credential IDs successfully written to env file */
  written: string[];
  /** Credential IDs that failed to unseal */
  failed: string[];
}

interface EnvEntry {
  key: string;
  value: string;
}

const DEFAULT_ENV_FILE_PATH = '/var/lib/generacy/wizard-credentials.env';

export function idToEnvName(id: string): string {
  return id.toUpperCase().replace(/-/g, '_');
}

export function mapCredentialToEnvEntries(
  id: string,
  type: string,
  value: string,
): EnvEntry[] {
  if (type === 'github-app' || type === 'github-pat') {
    return [{ key: 'GH_TOKEN', value }];
  }
  if (/anthropic/i.test(id) && type === 'api-key') {
    return [{ key: 'ANTHROPIC_API_KEY', value }];
  }
  return [{ key: idToEnvName(id), value }];
}

export function formatEnvFile(entries: EnvEntry[]): string {
  if (entries.length === 0) return '';
  return entries.map((e) => `${e.key}=${e.value}`).join('\n');
}

export async function writeWizardEnvFile(
  options: WriteWizardEnvFileOptions,
): Promise<WriteWizardEnvFileResult> {
  const { agencyDir, envFilePath = DEFAULT_ENV_FILE_PATH } = options;
  const yamlPath = path.join(agencyDir, 'credentials.yaml');

  // Read credentials.yaml to enumerate stored credentials
  let credentialsMap: Record<string, { type: string }> = {};
  try {
    const raw = await fs.readFile(yamlPath, 'utf8');
    const parsed = YAML.parse(raw);
    if (parsed?.credentials && typeof parsed.credentials === 'object') {
      credentialsMap = parsed.credentials;
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No credentials.yaml — write empty env file, no error
      await fs.writeFile(envFilePath, '', { mode: 0o600 });
      return { written: [], failed: [] };
    }
    throw err;
  }

  const credentialIds = Object.keys(credentialsMap);
  if (credentialIds.length === 0) {
    await fs.writeFile(envFilePath, '', { mode: 0o600 });
    return { written: [], failed: [] };
  }

  const backend = getCredentialBackend();
  if (!backend) {
    throw new Error('ClusterLocalBackend not initialized — call setCredentialBackend() first');
  }

  const entries: EnvEntry[] = [];
  const written: string[] = [];
  const failed: string[] = [];

  for (const id of credentialIds) {
    const entry = credentialsMap[id];
    if (!entry) continue;
    const { type } = entry;
    try {
      const value = await backend.fetchSecret(id);
      const envEntries = mapCredentialToEnvEntries(id, type, value);
      entries.push(...envEntries);
      written.push(id);
    } catch {
      failed.push(id);
    }
  }

  // Write env file (mode 0600) — partial file on partial failure
  await fs.writeFile(envFilePath, formatEnvFile(entries), { mode: 0o600 });

  return { written, failed };
}
