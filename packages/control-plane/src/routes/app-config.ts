import type http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { type ActorContext, requireActor } from '../context.js';
import { readBody } from '../util/read-body.js';
import { getRelayPushEvent } from '../relay-events.js';
import {
  AppConfigSchema,
  PutAppConfigEnvBodySchema,
  PostAppConfigFileBodySchema,
  type AppConfig,
} from '../schemas.js';
import type { AppConfigEnvStore } from '../services/app-config-env-store.js';
import type { AppConfigFileStore } from '../services/app-config-file-store.js';
import type { ClusterLocalBackend } from '@generacy-ai/credhelper';

// Inline denylist check (same logic as credhelper-daemon)
const DENIED_PREFIXES = [
  '/etc/', '/usr/', '/bin/', '/sbin/', '/lib/', '/lib64/',
  '/proc/', '/sys/', '/dev/', '/boot/',
  '/run/generacy-credhelper/', '/var/lib/generacy-credhelper/',
  '/run/generacy-control-plane/',
] as const;

function isPathDenied(absPath: string): boolean {
  const resolved = path.resolve(absPath);
  if (resolved === '/') return true;
  const withSlash = resolved.endsWith('/') ? resolved : resolved + '/';
  for (const prefix of DENIED_PREFIXES) {
    if (withSlash.startsWith(prefix) || resolved === prefix.slice(0, -1)) {
      return true;
    }
  }
  return false;
}

const DEFAULT_GENERACY_DIR = '.generacy';

function getGeneracyDir(): string {
  return process.env['GENERACY_PROJECT_DIR']
    ? path.join(process.env['GENERACY_PROJECT_DIR'], '.generacy')
    : DEFAULT_GENERACY_DIR;
}

/** Read and parse appConfig from cluster.yaml in the working tree. */
async function readManifest(): Promise<AppConfig | null> {
  const generacyDir = getGeneracyDir();
  const yamlPath = path.join(generacyDir, 'cluster.yaml');

  let raw: string;
  try {
    raw = await fs.readFile(yamlPath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== 'object' || !('appConfig' in parsed)) {
    return null;
  }

  return AppConfigSchema.parse((parsed as Record<string, unknown>).appConfig);
}

// --- Store instances (injected from bin/control-plane.ts) ---

let envStoreInstance: AppConfigEnvStore | undefined;
let fileStoreInstance: AppConfigFileStore | undefined;
let backendInstance: ClusterLocalBackend | undefined;

export function setAppConfigStores(
  envStore: AppConfigEnvStore,
  fileStore: AppConfigFileStore,
  backend: ClusterLocalBackend,
): void {
  envStoreInstance = envStore;
  fileStoreInstance = fileStore;
  backendInstance = backend;
}

function requireEnvStore(): AppConfigEnvStore {
  if (!envStoreInstance) throw new Error('AppConfigEnvStore not initialized');
  return envStoreInstance;
}

function requireFileStore(): AppConfigFileStore {
  if (!fileStoreInstance) throw new Error('AppConfigFileStore not initialized');
  return fileStoreInstance;
}

function requireBackend(): ClusterLocalBackend {
  if (!backendInstance) throw new Error('ClusterLocalBackend not initialized');
  return backendInstance;
}

// --- Route Handlers ---

export async function handleGetManifest(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _actor: ActorContext,
  _params: Record<string, string>,
): Promise<void> {
  try {
    const appConfig = await readManifest();
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(appConfig));
  } catch (err: unknown) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(500);
    res.end(JSON.stringify({
      error: 'Failed to parse cluster.yaml',
      code: 'MANIFEST_PARSE_ERROR',
      details: (err as Error).message,
    }));
  }
}

export async function handleGetValues(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _actor: ActorContext,
  _params: Record<string, string>,
): Promise<void> {
  const fileStore = requireFileStore();
  const meta = await fileStore.getMetadata();

  // Read manifest to check inManifest flag
  let manifest: AppConfig | null = null;
  try {
    manifest = await readManifest();
  } catch {
    // Best-effort: proceed without manifest
  }

  const manifestEnvNames = new Set(manifest?.env?.map(e => e.name) ?? []);

  const envEntries = Object.entries(meta.env).map(([name, entry]) => ({
    name,
    secret: entry.secret,
    updatedAt: entry.updatedAt,
    inManifest: manifestEnvNames.has(name),
  }));

  const fileEntries = Object.entries(meta.files).map(([id, entry]) => ({
    id,
    updatedAt: entry.updatedAt,
    size: entry.size,
  }));

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify({ env: envEntries, files: fileEntries }));
}

export async function handlePutEnv(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actor: ActorContext,
  _params: Record<string, string>,
): Promise<void> {
  requireActor(actor);

  const rawBody = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'Invalid JSON body', code: 'INVALID_REQUEST' }));
    return;
  }

  const result = PutAppConfigEnvBodySchema.safeParse(parsed);
  if (!result.success) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(400);
    res.end(JSON.stringify({
      error: 'Invalid request body',
      code: 'INVALID_REQUEST',
      details: result.error.issues,
    }));
    return;
  }

  const { name, value, secret } = result.data;
  const envStore = requireEnvStore();
  const fileStore = requireFileStore();
  const backend = requireBackend();

  if (secret) {
    // Store encrypted in backend
    const backendKey = `app-config/env/${name}`;
    await backend.setSecret(backendKey, value);
  } else {
    // Write to plaintext env file
    await envStore.set(name, value);
  }

  // Update metadata
  await fileStore.setEnvMetadata(name, secret);

  // Emit relay event
  const pushEvent = getRelayPushEvent();
  if (pushEvent) {
    pushEvent('cluster.app-config', { action: 'env-set', name, secret });
  }

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify({ accepted: true, name, secret }));
}

export async function handleDeleteEnv(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  actor: ActorContext,
  params: Record<string, string>,
): Promise<void> {
  requireActor(actor);

  const name = params['name'];
  if (!name) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'name is required', code: 'INVALID_REQUEST' }));
    return;
  }

  const envStore = requireEnvStore();
  const fileStore = requireFileStore();
  const backend = requireBackend();

  // Check metadata to determine if secret or plaintext
  const meta = await fileStore.getMetadata();
  const entry = meta.env[name];

  if (!entry) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Environment variable not found', code: 'NOT_FOUND' }));
    return;
  }

  if (entry.secret) {
    const backendKey = `app-config/env/${name}`;
    await backend.deleteSecret(backendKey);
  } else {
    await envStore.delete(name);
  }

  await fileStore.deleteEnvMetadata(name);

  // Emit relay event
  const pushEvent = getRelayPushEvent();
  if (pushEvent) {
    pushEvent('cluster.app-config', { action: 'env-deleted', name });
  }

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify({ accepted: true, name }));
}

export async function handlePostFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actor: ActorContext,
  params: Record<string, string>,
): Promise<void> {
  requireActor(actor);

  const id = params['id'];
  if (!id) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'file id is required', code: 'INVALID_REQUEST' }));
    return;
  }

  // Read manifest to find mountPath
  let manifest: AppConfig | null;
  try {
    manifest = await readManifest();
  } catch (err: unknown) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(500);
    res.end(JSON.stringify({
      error: 'Failed to parse cluster.yaml',
      code: 'MANIFEST_PARSE_ERROR',
      details: (err as Error).message,
    }));
    return;
  }

  const fileEntry = manifest?.files?.find(f => f.id === id);
  if (!fileEntry) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(400);
    res.end(JSON.stringify({
      error: `File ID '${id}' not declared in appConfig.files manifest`,
      code: 'INVALID_REQUEST',
    }));
    return;
  }

  // Validate mountPath against denylist
  if (isPathDenied(fileEntry.mountPath)) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(400);
    res.end(JSON.stringify({
      error: `mountPath '${fileEntry.mountPath}' is in a restricted system directory`,
      code: 'INVALID_REQUEST',
    }));
    return;
  }

  // Parse body
  const rawBody = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'Invalid JSON body', code: 'INVALID_REQUEST' }));
    return;
  }

  const result = PostAppConfigFileBodySchema.safeParse(parsed);
  if (!result.success) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(400);
    res.end(JSON.stringify({
      error: 'Invalid request body',
      code: 'INVALID_REQUEST',
      details: result.error.issues,
    }));
    return;
  }

  // Decode base64
  const data = Buffer.from(result.data.data, 'base64');
  const fileStore = requireFileStore();

  await fileStore.setFile(id, fileEntry.mountPath, data);

  // Emit relay event
  const pushEvent = getRelayPushEvent();
  if (pushEvent) {
    pushEvent('cluster.app-config', { action: 'file-set', id, mountPath: fileEntry.mountPath });
  }

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify({
    accepted: true,
    id,
    mountPath: fileEntry.mountPath,
    size: data.length,
  }));
}
