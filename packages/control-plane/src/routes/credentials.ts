import type http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { type ActorContext, requireActor } from '../context.js';
import { readBody } from '../util/read-body.js';
import { writeCredential } from '../services/credential-writer.js';

const PutCredentialBodySchema = z.object({
  type: z.string().min(1),
  value: z.string().min(1),
});

const DEFAULT_AGENCY_DIR = '.agency';

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

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify({ ok: true }));
}
