import { CredhelperError, sendError } from '../src/errors.js';

describe('CredhelperError', () => {
  describe('construction', () => {
    it('sets code, message, and details', () => {
      const details = { field: 'role', reason: 'missing' };
      const err = new CredhelperError('INVALID_REQUEST', 'bad request', details);

      expect(err.code).toBe('INVALID_REQUEST');
      expect(err.message).toBe('bad request');
      expect(err.details).toEqual(details);
    });

    it('leaves details undefined when not provided', () => {
      const err = new CredhelperError('INTERNAL_ERROR', 'something broke');

      expect(err.code).toBe('INTERNAL_ERROR');
      expect(err.message).toBe('something broke');
      expect(err.details).toBeUndefined();
    });

    it('has name "CredhelperError"', () => {
      const err = new CredhelperError('INTERNAL_ERROR', 'oops');
      expect(err.name).toBe('CredhelperError');
    });

    it('is an instance of Error', () => {
      const err = new CredhelperError('INTERNAL_ERROR', 'oops');
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('toResponse()', () => {
    it('returns response with error and code', () => {
      const err = new CredhelperError('SESSION_NOT_FOUND', 'no such session');
      const response = err.toResponse();

      expect(response).toEqual({
        error: 'no such session',
        code: 'SESSION_NOT_FOUND',
      });
    });

    it('includes details when present', () => {
      const details = { sessionId: 'abc-123' };
      const err = new CredhelperError('SESSION_EXPIRED', 'session expired', details);
      const response = err.toResponse();

      expect(response).toEqual({
        error: 'session expired',
        code: 'SESSION_EXPIRED',
        details: { sessionId: 'abc-123' },
      });
    });

    it('omits details key when not provided', () => {
      const err = new CredhelperError('INTERNAL_ERROR', 'fail');
      const response = err.toResponse();

      expect(response).not.toHaveProperty('details');
    });
  });

  describe('httpStatus getter', () => {
    const statusCases: [string, number][] = [
      ['INVALID_REQUEST', 400],
      ['INVALID_ROLE', 400],
      ['UNSUPPORTED_EXPOSURE', 400],
      ['ROLE_NOT_FOUND', 404],
      ['PLUGIN_NOT_FOUND', 404],
      ['SESSION_NOT_FOUND', 404],
      ['CREDENTIAL_NOT_FOUND', 404],
      ['SESSION_EXPIRED', 410],
      ['CREDENTIAL_EXPIRED', 410],
      ['PEER_REJECTED', 403],
      ['INTERNAL_ERROR', 500],
      ['NOT_IMPLEMENTED', 501],
      ['PLUGIN_MINT_FAILED', 502],
      ['PLUGIN_RESOLVE_FAILED', 502],
      ['BACKEND_UNREACHABLE', 502],
    ];

    it.each(statusCases)('%s → %i', (code, expectedStatus) => {
      const err = new CredhelperError(code as any, 'test');
      expect(err.httpStatus).toBe(expectedStatus);
    });
  });
});

describe('sendError()', () => {
  function createMockResponse() {
    return {
      setHeader: vi.fn(),
      writeHead: vi.fn(),
      end: vi.fn(),
    };
  }

  it('sets Content-Type to application/json', () => {
    const res = createMockResponse();
    const err = new CredhelperError('INTERNAL_ERROR', 'boom');

    sendError(res as any, err);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
  });

  it('writes the correct HTTP status code', () => {
    const res = createMockResponse();
    const err = new CredhelperError('SESSION_NOT_FOUND', 'not found');

    sendError(res as any, err);

    expect(res.writeHead).toHaveBeenCalledWith(404);
  });

  it('sends the JSON-serialized error response', () => {
    const res = createMockResponse();
    const details = { pluginId: 'gcp' };
    const err = new CredhelperError('PLUGIN_MINT_FAILED', 'mint failed', details);

    sendError(res as any, err);

    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body).toEqual({
      error: 'mint failed',
      code: 'PLUGIN_MINT_FAILED',
      details: { pluginId: 'gcp' },
    });
  });

  it('sends response without details when not provided', () => {
    const res = createMockResponse();
    const err = new CredhelperError('PEER_REJECTED', 'rejected');

    sendError(res as any, err);

    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body).toEqual({
      error: 'rejected',
      code: 'PEER_REJECTED',
    });
    expect(body).not.toHaveProperty('details');
  });
});
