import type http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { type ActorContext, requireActor } from '../context.js';
import { readBody } from '../util/read-body.js';

const DEFAULT_AGENCY_DIR = '.agency';

export async function handleListRoles(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _actor: ActorContext,
  _params: Record<string, string>,
): Promise<void> {
  const agencyDir = process.env['CREDHELPER_AGENCY_DIR'] ?? DEFAULT_AGENCY_DIR;
  const rolesDir = path.join(agencyDir, 'roles');

  let files: string[];
  try {
    const entries = await fs.readdir(rolesDir);
    files = entries.filter((f) => f.endsWith('.yaml'));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      files = [];
    } else {
      throw err;
    }
  }

  const roles: Array<{ id: string; description?: string }> = [];
  for (const file of files) {
    const id = file.replace(/\.yaml$/, '');
    try {
      const raw = await fs.readFile(path.join(rolesDir, file), 'utf8');
      const parsed = YAML.parse(raw);
      const entry: { id: string; description?: string } = { id };
      if (parsed && typeof parsed === 'object' && typeof parsed.description === 'string') {
        entry.description = parsed.description;
      }
      roles.push(entry);
    } catch {
      roles.push({ id });
    }
  }

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify({ roles }));
}

export async function handleGetRole(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _actor: ActorContext,
  params: Record<string, string>,
): Promise<void> {
  const id = params['id'] ?? 'unknown';
  const agencyDir = process.env['CREDHELPER_AGENCY_DIR'] ?? DEFAULT_AGENCY_DIR;
  const rolePath = path.join(agencyDir, 'roles', `${id}.yaml`);

  let raw: string;
  try {
    raw = await fs.readFile(rolePath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(404);
      res.end(JSON.stringify({ error: `Role '${id}' not found`, code: 'NOT_FOUND' }));
      return;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Failed to parse role file', code: 'INTERNAL_ERROR' }));
    return;
  }

  const body: Record<string, unknown> = { id };
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.description === 'string') {
      body.description = obj.description;
    }
    if (Array.isArray(obj.credentials)) {
      body.credentials = obj.credentials;
    }
  }

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify(body));
}

export async function handlePutRole(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actor: ActorContext,
  _params: Record<string, string>,
): Promise<void> {
  requireActor(actor);
  await readBody(req);

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify({ ok: true }));
}
