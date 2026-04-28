import { Readable } from 'node:stream';
import type http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { ActorContext } from '../../src/context.js';
import {
  handleGetCredential,
  handlePutCredential,
} from '../../src/routes/credentials.js';

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

describe('handleGetCredential', () => {
  it('returns 200 with the expected JSON body', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetCredential(req, res as any, stubActor, { id: 'cred-42' });

    expect(res.writeHead).toHaveBeenCalledWith(200);

    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body).toMatchObject({
      id: 'cred-42',
      type: 'api-key',
      backend: 'env',
      backendKey: 'API_KEY',
      status: 'active',
    });
    expect(body).toHaveProperty('createdAt');
  });

  it('echoes the id param back in the response', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetCredential(req, res as any, stubActor, { id: 'my-cred-99' });

    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.id).toBe('my-cred-99');
  });

  it('returns a valid ISO datetime in createdAt', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetCredential(req, res as any, stubActor, { id: 'cred-1' });

    const body = JSON.parse(res.end.mock.calls[0][0]);
    const parsed = new Date(body.createdAt);
    expect(parsed.toISOString()).toBe(body.createdAt);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
  });

  it('sets Content-Type to application/json', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetCredential(req, res as any, stubActor, { id: 'cred-1' });

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
  });
});

describe('handlePutCredential', () => {
  it('returns 200 with { ok: true }', async () => {
    const req = createBodyReq({ type: 'api-key', backend: 'env' });
    const res = createMockResponse();

    await handlePutCredential(req, res as any, stubActor, { id: 'cred-42' });

    expect(res.writeHead).toHaveBeenCalledWith(200);

    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body).toEqual({ ok: true });
  });

  it('sets Content-Type to application/json', async () => {
    const req = createBodyReq({ type: 'api-key' });
    const res = createMockResponse();

    await handlePutCredential(req, res as any, stubActor, { id: 'cred-42' });

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
  });
});
