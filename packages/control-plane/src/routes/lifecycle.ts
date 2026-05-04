import type http from 'node:http';
import { type ActorContext, requireActor } from '../context.js';
import { LifecycleActionSchema, ClonePeerReposBodySchema, SetDefaultRoleBodySchema } from '../schemas.js';
import { ControlPlaneError } from '../errors.js';
import { getCodeServerManager } from '../services/code-server-manager.js';
import { readBody } from '../util/read-body.js';
import { setDefaultRole } from '../services/default-role-writer.js';
import { clonePeerRepos } from '../services/peer-repo-cloner.js';

export async function handlePostLifecycle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actor: ActorContext,
  params: Record<string, string>,
): Promise<void> {
  requireActor(actor);
  const action = params['action'] ?? '';
  const parsed = LifecycleActionSchema.safeParse(action);

  if (!parsed.success) {
    throw new ControlPlaneError('UNKNOWN_ACTION', `Unknown lifecycle action: ${action}`);
  }

  res.setHeader('Content-Type', 'application/json');

  if (parsed.data === 'code-server-start') {
    const manager = getCodeServerManager();
    let result;
    try {
      result = await manager.start();
    } catch (err) {
      throw new ControlPlaneError(
        'SERVICE_UNAVAILABLE',
        err instanceof Error ? err.message : 'Failed to start code-server',
      );
    }
    res.writeHead(200);
    res.end(JSON.stringify(result));
    return;
  }

  if (parsed.data === 'code-server-stop') {
    const manager = getCodeServerManager();
    await manager.stop();
    res.writeHead(200);
    res.end(JSON.stringify({ accepted: true, action: parsed.data }));
    return;
  }

  if (parsed.data === 'set-default-role') {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new ControlPlaneError('INVALID_REQUEST', 'Invalid JSON body');
    }

    const bodyResult = SetDefaultRoleBodySchema.safeParse(body);
    if (!bodyResult.success) {
      throw new ControlPlaneError('INVALID_REQUEST', 'Invalid set-default-role body', {
        errors: bodyResult.error.issues.map((i) => i.message),
      });
    }

    await setDefaultRole({ role: bodyResult.data.role });
    res.writeHead(200);
    res.end(JSON.stringify({ accepted: true, action: parsed.data }));
    return;
  }

  if (parsed.data === 'clone-peer-repos') {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new ControlPlaneError('INVALID_REQUEST', 'Invalid JSON body');
    }

    const bodyResult = ClonePeerReposBodySchema.safeParse(body);
    if (!bodyResult.success) {
      throw new ControlPlaneError('INVALID_REQUEST', 'Invalid clone-peer-repos body', {
        errors: bodyResult.error.issues.map((i) => i.message),
      });
    }

    await clonePeerRepos({ repos: bodyResult.data.repos, token: bodyResult.data.token });
    res.writeHead(200);
    res.end(JSON.stringify({ accepted: true, action: parsed.data }));
    return;
  }

  // 'stop' — stub for v1.5
  res.writeHead(200);
  res.end(JSON.stringify({ accepted: true, action: parsed.data }));
}
