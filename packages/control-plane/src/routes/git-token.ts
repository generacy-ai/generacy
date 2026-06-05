import type http from 'node:http';
import type { ActorContext } from '../context.js';
import { readBody } from '../util/read-body.js';
import { GitTokenRequestSchema } from '../schemas.js';
import { GitHelperError } from '../types/git-token.js';
import type { GitHelperErrorCode, GitTokenCacheEntry } from '../types/git-token.js';

export interface GitTokenManagerLike {
  getToken(credentialId: string): Promise<GitTokenCacheEntry>;
}

export interface CreateGitTokenHandlerOptions {
  gitTokenManager: GitTokenManagerLike;
  defaultCredentialId: string;
}

export type GitTokenRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actor: ActorContext,
  params: Record<string, string>,
) => Promise<void>;

let bound: { manager: GitTokenManagerLike; defaultCredentialId: string } | undefined;

export function setGitTokenManager(manager: GitTokenManagerLike, defaultCredentialId: string): void {
  bound = { manager, defaultCredentialId };
}

const HTTP_STATUS_BY_CODE: Record<GitHelperErrorCode, number> = {
  CLUSTER_API_KEY_MISSING: 503,
  CREDENTIAL_NOT_CONFIGURED: 400,
  CLOUD_UNREACHABLE: 502,
  CLOUD_AUTH_REJECTED: 502,
  CLOUD_REQUEST_INVALID: 502,
  CLOUD_UPSTREAM_ERROR: 502,
  CLOUD_RESPONSE_INVALID: 502,
};

function sendError(res: http.ServerResponse, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  const body: Record<string, unknown> = { error: message, code };
  if (details !== undefined) body.details = details;
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

export function createGitTokenHandler(options: CreateGitTokenHandlerOptions): GitTokenRouteHandler {
  return async function handlePostGitToken(req, res) {
    let raw = '';
    try {
      raw = await readBody(req);
    } catch {
      // Treat read failure as empty body — fall through to default credential.
    }

    let credentialId = options.defaultCredentialId;
    if (raw.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Malformed JSON → fall back to default credential (FR: missing/invalid body still produces a token).
        parsed = {};
      }
      const validated = GitTokenRequestSchema.safeParse(parsed);
      if (!validated.success) {
        sendError(res, 400, 'INVALID_REQUEST', 'Invalid request body', { issues: validated.error.issues });
        return;
      }
      if (validated.data.credentialId !== undefined) {
        credentialId = validated.data.credentialId;
      }
    }

    let entry: GitTokenCacheEntry;
    try {
      entry = await options.gitTokenManager.getToken(credentialId);
    } catch (err) {
      if (err instanceof GitHelperError) {
        const status = HTTP_STATUS_BY_CODE[err.code] ?? 500;
        sendError(res, status, err.code, err.message, err.details);
        return;
      }
      sendError(res, 500, 'INTERNAL_ERROR', 'git-token request failed');
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({
      token: entry.token,
      expiresAt: entry.expiresAt.toISOString(),
    }));
  };
}

export async function handlePostGitToken(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actor: ActorContext,
  params: Record<string, string>,
): Promise<void> {
  if (!bound) {
    sendError(res, 503, 'SERVICE_UNAVAILABLE', 'git-token manager not initialized');
    return;
  }
  const handler = createGitTokenHandler({
    gitTokenManager: bound.manager,
    defaultCredentialId: bound.defaultCredentialId,
  });
  await handler(req, res, actor, params);
}
