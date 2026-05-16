import type http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { StorageError } from '@generacy-ai/credhelper';
import { type ActorContext, requireActor } from '../context.js';
import { readBody } from '../util/read-body.js';
import { writeCredential, getCredentialBackend } from '../services/credential-writer.js';
import { writeWizardEnvFile } from '../services/wizard-env-writer.js';
import { extractGhToken, refreshGhAuth } from '../services/gh-auth-refresh.js';
import { getRelayPushEvent } from '../relay-events.js';

const PutCredentialBodySchema = z.object({
  type: z.string().min(1),
  value: z.string().min(1),
});

const DEFAULT_AGENCY_DIR = '.agency';

export async function handleGetCredentialValue(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _actor: ActorContext,
  params: Record<string, string>,
): Promise<void> {
  const credentialId = params['id'] ?? 'unknown';
  const backend = getCredentialBackend();

  if (!backend) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Credential backend not initialized', code: 'BACKEND_ERROR' }));
    return;
  }

  let value: string;
  try {
    value = await backend.fetchSecret(credentialId);
  } catch (err: unknown) {
    if (err instanceof StorageError && err.code === 'SECRET_NOT_FOUND') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(404);
      res.end(JSON.stringify({ error: `Credential '${credentialId}' not found`, code: 'CREDENTIAL_NOT_FOUND' }));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Failed to fetch credential value', code: 'BACKEND_ERROR' }));
    return;
  }

  // Emit audit relay event
  const pushEvent = getRelayPushEvent();
  if (pushEvent) {
    pushEvent('cluster.credentials', {
      action: 'credential_value_read',
      credentialId,
      timestamp: new Date().toISOString(),
    });
  }

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify({ value }));
}

export async function handleGetCredential(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _actor: ActorContext,
  params: Record<string, string>,
): Promise<void> {
  const credentialId = params['id'] ?? 'unknown';
  const agencyDir = process.env['CREDHELPER_AGENCY_DIR'] ?? DEFAULT_AGENCY_DIR;
  const yamlPath = path.join(agencyDir, 'credentials.yaml');

  let entry: Record<string, unknown> | undefined;
  try {
    const raw = await fs.readFile(yamlPath, 'utf8');
    const parsed = YAML.parse(raw);
    if (parsed?.credentials && typeof parsed.credentials === 'object') {
      entry = (parsed.credentials as Record<string, Record<string, unknown>>)[credentialId];
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to read credential metadata', code: 'INTERNAL_ERROR' }));
      return;
    }
  }

  if (!entry) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(404);
    res.end(JSON.stringify({ error: `Credential '${credentialId}' not found`, code: 'NOT_FOUND' }));
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify({
    id: credentialId,
    type: entry.type,
    backend: entry.backend,
    status: entry.status,
    updatedAt: entry.updatedAt,
  }));
}

export async function handlePutCredential(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actor: ActorContext,
  params: Record<string, string>,
): Promise<void> {
  requireActor(actor);

  const credentialId = params['id'] ?? 'unknown';
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

  const result = PutCredentialBodySchema.safeParse(parsed);
  if (!result.success) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(400);
    res.end(JSON.stringify({
      error: 'Invalid request body',
      code: 'INVALID_REQUEST',
      details: { issues: result.error.issues },
      failedAt: 'validation',
    }));
    return;
  }

  const agencyDir = process.env['CREDHELPER_AGENCY_DIR'] ?? DEFAULT_AGENCY_DIR;

  try {
    await writeCredential({
      credentialId,
      type: result.data.type,
      value: result.data.value,
      agencyDir,
    });
  } catch (err: unknown) {
    const failedAt = (err as { failedAt?: string }).failedAt;
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(500);
    res.end(JSON.stringify({
      error: 'Credential write failed',
      code: 'CREDENTIAL_WRITE_FAILED',
      failedAt: failedAt ?? 'unknown',
    }));
    return;
  }

  // Post-write: refresh GH_TOKEN surface for github credentials (best-effort)
  const { type, value } = result.data;
  if (type === 'github-app' || type === 'github-pat') {
    try {
      await writeWizardEnvFile({ agencyDir });
    } catch (err: unknown) {
      // Non-fatal — env file rewrite failure doesn't fail the PUT
      console.warn('Failed to rewrite wizard env file after credential PUT:', (err as Error).message);
    }

    const token = extractGhToken(type, value);
    if (token) {
      try {
        const ghResult = await refreshGhAuth(token);
        if (!ghResult.ok) {
          console.warn('gh auth refresh failed:', ghResult.error);
        }
      } catch (err: unknown) {
        console.warn('gh auth refresh threw:', (err as Error).message);
      }
    }
  }

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify({ ok: true }));
}
