import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { ClusterLocalBackend } from '@generacy-ai/credhelper';
import { getRelayPushEvent } from '../relay-events.js';

export interface WriteCredentialOptions {
  credentialId: string;
  type: string;
  value: string;
  agencyDir: string;
}

export interface WriteCredentialResult {
  ok: true;
}

let backendInstance: ClusterLocalBackend | undefined;

export function setCredentialBackend(backend: ClusterLocalBackend): void {
  backendInstance = backend;
}

export function getCredentialBackend(): ClusterLocalBackend | undefined {
  return backendInstance;
}

export async function writeCredential(options: WriteCredentialOptions): Promise<WriteCredentialResult> {
  const { credentialId, type, value, agencyDir } = options;

  if (!backendInstance) {
    throw new Error('ClusterLocalBackend not initialized — call setCredentialBackend() first');
  }

  // Step 1: Persist secret via ClusterLocalBackend
  try {
    await backendInstance.setSecret(credentialId, value);
  } catch (err) {
    throw Object.assign(
      new Error(`Secret write failed: ${(err as Error).message}`),
      { failedAt: 'secret-write' },
    );
  }

  // Step 2: Write metadata to .agency/credentials.yaml
  try {
    await writeCredentialMetadata(credentialId, type, agencyDir);
  } catch (err) {
    throw Object.assign(
      new Error(`Metadata write failed: ${(err as Error).message}`),
      { failedAt: 'metadata-write' },
    );
  }

  // Step 3: Emit relay event
  const pushEvent = getRelayPushEvent();
  if (pushEvent) {
    pushEvent('cluster.credentials', { credentialId, type, status: 'written' });
  }

  return { ok: true };
}

async function writeCredentialMetadata(
  credentialId: string,
  type: string,
  agencyDir: string,
): Promise<void> {
  const yamlPath = path.join(agencyDir, 'credentials.yaml');

  // Ensure directory exists
  await fs.mkdir(agencyDir, { recursive: true });

  // Read existing or start fresh
  let doc: Record<string, unknown> = {};
  try {
    const existing = await fs.readFile(yamlPath, 'utf8');
    const parsed = YAML.parse(existing);
    if (parsed && typeof parsed === 'object') {
      doc = parsed as Record<string, unknown>;
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  // Ensure credentials map
  if (!doc.credentials || typeof doc.credentials !== 'object') {
    doc.credentials = {};
  }

  // Merge entry
  (doc.credentials as Record<string, unknown>)[credentialId] = {
    type,
    backend: 'cluster-local',
    status: 'active',
    updatedAt: new Date().toISOString(),
  };

  // Atomic write: temp + rename
  const tmpPath = `${yamlPath}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, YAML.stringify(doc), { mode: 0o644 });
  await fs.rename(tmpPath, yamlPath);
}
