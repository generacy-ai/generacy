import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import type http from 'node:http';
import {
  createGitTokenHandler,
  type GitTokenManagerLike,
} from '../../src/routes/git-token.js';
import type { ActorContext } from '../../src/context.js';
import { GitHelperError } from '../../src/types/git-token.js';

function createMockResponse() {
  return {
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    end: vi.fn(),
  };
}

function bodyReq(body: string | object | undefined): http.IncomingMessage {
  const readable = new Readable({ read() {} });
  if (body === undefined) {
    readable.push(null);
  } else {
    readable.push(typeof body === 'string' ? body : JSON.stringify(body));
    readable.push(null);
  }
  return readable as unknown as http.IncomingMessage;
}

const stubActor: ActorContext = { userId: 'u-test', sessionId: 's-test' };

describe('handlePostGitToken', () => {
  let manager: GitTokenManagerLike;

  beforeEach(() => {
    manager = {
      getToken: vi.fn(async (credentialId: string) => ({
        token: `token-for-${credentialId}`,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        credentialId,
        fetchedAt: new Date(),
      })),
    };
  });

  it('returns 200 + { token, expiresAt } on success', async () => {
    const handler = createGitTokenHandler({ gitTokenManager: manager, defaultCredentialId: 'github-app' });
    const req = bodyReq({ credentialId: 'github-app' });
    const res = createMockResponse();

    await handler(req, res as any, stubActor, {});

    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.token).toBe('token-for-github-app');
    expect(typeof body.expiresAt).toBe('string');
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('uses default credentialId when body omits it', async () => {
    const handler = createGitTokenHandler({ gitTokenManager: manager, defaultCredentialId: 'default-app' });
    const req = bodyReq({});
    const res = createMockResponse();

    await handler(req, res as any, stubActor, {});

    expect(manager.getToken).toHaveBeenCalledWith('default-app');
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.token).toBe('token-for-default-app');
  });

  it('uses default credentialId when body is empty / malformed JSON', async () => {
    const handler = createGitTokenHandler({ gitTokenManager: manager, defaultCredentialId: 'github-app' });
    const req = bodyReq('');
    const res = createMockResponse();

    await handler(req, res as any, stubActor, {});

    expect(manager.getToken).toHaveBeenCalledWith('github-app');
    expect(res.writeHead).toHaveBeenCalledWith(200);
  });

  it('maps CLUSTER_API_KEY_MISSING to 503 with error envelope', async () => {
    manager.getToken = vi.fn(async () => {
      throw new GitHelperError('CLUSTER_API_KEY_MISSING', 'no key');
    });
    const handler = createGitTokenHandler({ gitTokenManager: manager, defaultCredentialId: 'github-app' });
    const req = bodyReq({});
    const res = createMockResponse();

    await handler(req, res as any, stubActor, {});

    expect(res.writeHead).toHaveBeenCalledWith(503);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body).toMatchObject({ code: 'CLUSTER_API_KEY_MISSING' });
    expect(typeof body.error).toBe('string');
  });

  it('maps CLOUD_UNREACHABLE to 502', async () => {
    manager.getToken = vi.fn(async () => {
      throw new GitHelperError('CLOUD_UNREACHABLE', 'down');
    });
    const handler = createGitTokenHandler({ gitTokenManager: manager, defaultCredentialId: 'github-app' });
    const res = createMockResponse();

    await handler(bodyReq({}), res as any, stubActor, {});

    expect(res.writeHead).toHaveBeenCalledWith(502);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.code).toBe('CLOUD_UNREACHABLE');
  });

  it('maps CLOUD_AUTH_REJECTED to 502', async () => {
    manager.getToken = vi.fn(async () => {
      throw new GitHelperError('CLOUD_AUTH_REJECTED', 'no');
    });
    const handler = createGitTokenHandler({ gitTokenManager: manager, defaultCredentialId: 'github-app' });
    const res = createMockResponse();

    await handler(bodyReq({}), res as any, stubActor, {});

    expect(res.writeHead).toHaveBeenCalledWith(502);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.code).toBe('CLOUD_AUTH_REJECTED');
  });

  it('maps CLOUD_UPSTREAM_ERROR to 502', async () => {
    manager.getToken = vi.fn(async () => {
      throw new GitHelperError('CLOUD_UPSTREAM_ERROR', 'oops');
    });
    const handler = createGitTokenHandler({ gitTokenManager: manager, defaultCredentialId: 'github-app' });
    const res = createMockResponse();

    await handler(bodyReq({}), res as any, stubActor, {});

    expect(res.writeHead).toHaveBeenCalledWith(502);
  });

  it('maps CLOUD_RESPONSE_INVALID to 502', async () => {
    manager.getToken = vi.fn(async () => {
      throw new GitHelperError('CLOUD_RESPONSE_INVALID', 'bad body');
    });
    const handler = createGitTokenHandler({ gitTokenManager: manager, defaultCredentialId: 'github-app' });
    const res = createMockResponse();

    await handler(bodyReq({}), res as any, stubActor, {});

    expect(res.writeHead).toHaveBeenCalledWith(502);
  });

  it('maps CREDENTIAL_NOT_CONFIGURED to 400', async () => {
    manager.getToken = vi.fn(async () => {
      throw new GitHelperError('CREDENTIAL_NOT_CONFIGURED', 'missing');
    });
    const handler = createGitTokenHandler({ gitTokenManager: manager, defaultCredentialId: 'github-app' });
    const res = createMockResponse();

    await handler(bodyReq({}), res as any, stubActor, {});

    expect(res.writeHead).toHaveBeenCalledWith(400);
  });

  it('rejects invalid body (credentialId not a string) with 400', async () => {
    const handler = createGitTokenHandler({ gitTokenManager: manager, defaultCredentialId: 'github-app' });
    const req = bodyReq({ credentialId: 42 });
    const res = createMockResponse();

    await handler(req, res as any, stubActor, {});

    expect(res.writeHead).toHaveBeenCalledWith(400);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.code).toBe('INVALID_REQUEST');
  });

  it('emits Content-Type application/json on success', async () => {
    const handler = createGitTokenHandler({ gitTokenManager: manager, defaultCredentialId: 'github-app' });
    const res = createMockResponse();

    await handler(bodyReq({}), res as any, stubActor, {});

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
  });
});
