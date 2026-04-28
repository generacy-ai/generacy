import { ControlPlaneError, sendError } from '../src/errors.js';

describe('ControlPlaneError', () => {
  describe('construction', () => {
    it('sets code, message, and details', () => {
      const details = { field: 'credentialId', reason: 'missing' };
      const err = new ControlPlaneError('INVALID_REQUEST', 'bad request', details);

      expect(err.code).toBe('INVALID_REQUEST');
      expect(err.message).toBe('bad request');
      expect(err.details).toEqual(details);
    });

    it('leaves details undefined when not provided', () => {
      const err = new ControlPlaneError('INTERNAL_ERROR', 'something broke');

      expect(err.code).toBe('INTERNAL_ERROR');
      expect(err.message).toBe('something broke');
      expect(err.details).toBeUndefined();
    });

    it('has name "ControlPlaneError"', () => {
      const err = new ControlPlaneError('INTERNAL_ERROR', 'oops');
      expect(err.name).toBe('ControlPlaneError');
    });

    it('is an instance of Error', () => {
      const err = new ControlPlaneError('INTERNAL_ERROR', 'oops');
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('httpStatus getter', () => {
    const statusCases: [string, number][] = [
      ['INVALID_REQUEST', 400],
      ['NOT_FOUND', 404],
      ['UNKNOWN_ACTION', 400],
      ['SERVICE_UNAVAILABLE', 503],
      ['INTERNAL_ERROR', 500],
    ];

    it.each(statusCases)('%s → %i', (code, expectedStatus) => {
      const err = new ControlPlaneError(code as any, 'test');
      expect(err.httpStatus).toBe(expectedStatus);
    });
  });

  describe('toResponse()', () => {
    it('returns response with error and code', () => {
      const err = new ControlPlaneError('NOT_FOUND', 'resource not found');
      const response = err.toResponse();

      expect(response).toEqual({
        error: 'resource not found',
        code: 'NOT_FOUND',
      });
    });

    it('includes details when present', () => {
      const details = { credentialId: 'cred-42' };
      const err = new ControlPlaneError('INVALID_REQUEST', 'invalid credential', details);
      const response = err.toResponse();

      expect(response).toEqual({
        error: 'invalid credential',
        code: 'INVALID_REQUEST',
        details: { credentialId: 'cred-42' },
      });
    });

    it('omits details key when not provided', () => {
      const err = new ControlPlaneError('INTERNAL_ERROR', 'fail');
      const response = err.toResponse();

      expect(response).not.toHaveProperty('details');
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
    const err = new ControlPlaneError('INTERNAL_ERROR', 'boom');

    sendError(res as any, err);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
  });

  it('writes the correct HTTP status code', () => {
    const res = createMockResponse();
    const err = new ControlPlaneError('NOT_FOUND', 'not found');

    sendError(res as any, err);

    expect(res.writeHead).toHaveBeenCalledWith(404);
  });

  it('sends the JSON-serialized error response', () => {
    const res = createMockResponse();
    const details = { action: 'deploy' };
    const err = new ControlPlaneError('UNKNOWN_ACTION', 'unknown action', details);

    sendError(res as any, err);

    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body).toEqual({
      error: 'unknown action',
      code: 'UNKNOWN_ACTION',
      details: { action: 'deploy' },
    });
  });

  it('sends response without details when not provided', () => {
    const res = createMockResponse();
    const err = new ControlPlaneError('SERVICE_UNAVAILABLE', 'service down');

    sendError(res as any, err);

    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body).toEqual({
      error: 'service down',
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(body).not.toHaveProperty('details');
  });
});
