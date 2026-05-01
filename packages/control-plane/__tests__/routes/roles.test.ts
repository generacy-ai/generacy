import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import type http from 'node:http';
import type { IncomingMessage } from 'node:http';
import { handleGetRole, handlePutRole } from '../../src/routes/roles.js';
import type { ActorContext } from '../../src/context.js';
import { ControlPlaneError } from '../../src/errors.js';

function createMockResponse() {
  return {
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    end: vi.fn(),
  };
}

function createBodyReq(body: object): http.IncomingMessage {
  const readable = new Readable({ read() {} });
  readable.push(JSON.stringify(body));
  readable.push(null);
  return readable as unknown as http.IncomingMessage;
}

const stubActor: ActorContext = { userId: 'u-test', sessionId: 's-test' };

describe('handleGetRole', () => {
  it('returns 200 with JSON body containing id, description, and credentials', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetRole(req, res as any, stubActor, { id: 'role-1' });

    expect(res.writeHead).toHaveBeenCalledWith(200);

    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body).toEqual({
      id: 'role-1',
      description: 'Stub role',
      credentials: [],
    });
  });

  it('returns an id that matches the id param passed in', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetRole(req, res as any, stubActor, { id: 'my-custom-role' });

    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.id).toBe('my-custom-role');
  });

  it('sets Content-Type to application/json', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetRole(req, res as any, stubActor, { id: 'role-1' });

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
  });
});

describe('handlePutRole', () => {
  it('returns 200 with { ok: true }', async () => {
    const req = createBodyReq({ description: 'Updated role' });
    const res = createMockResponse();

    await handlePutRole(req, res as any, stubActor, { id: 'role-1' });

    expect(res.writeHead).toHaveBeenCalledWith(200);

    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body).toEqual({ ok: true });
  });

  it('sets Content-Type to application/json', async () => {
    const req = createBodyReq({ description: 'Updated role' });
    const res = createMockResponse();

    await handlePutRole(req, res as any, stubActor, { id: 'role-1' });

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
  });

  it('throws UNAUTHORIZED when actor userId is missing', async () => {
    const req = createBodyReq({ description: 'Updated role' });
    const res = createMockResponse();
    const noActor: ActorContext = {};

    await expect(
      handlePutRole(req, res as any, noActor, { id: 'role-1' }),
    ).rejects.toThrow(ControlPlaneError);

    try {
      const req2 = createBodyReq({ description: 'Updated role' });
      await handlePutRole(req2, res as any, noActor, { id: 'role-1' });
    } catch (err) {
      expect((err as ControlPlaneError).code).toBe('UNAUTHORIZED');
      expect((err as ControlPlaneError).message).toBe('Missing actor identity');
    }
  });
});
