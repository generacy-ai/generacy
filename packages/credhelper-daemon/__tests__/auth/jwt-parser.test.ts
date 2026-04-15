import { JwtParser } from '../../src/auth/jwt-parser.js';
import { CredhelperError } from '../../src/errors.js';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = Buffer.from('fake-signature').toString('base64url');
  return `${header}.${body}.${sig}`;
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'user-123',
    org_id: 'org-456',
    scope: 'credhelper',
    iat: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

describe('JwtParser', () => {
  let parser: JwtParser;

  beforeEach(() => {
    parser = new JwtParser();
  });

  describe('valid token', () => {
    it('returns SessionTokenClaims for a well-formed token', () => {
      const payload = validPayload();
      const token = makeJwt(payload);

      const claims = parser.parse(token);

      expect(claims).toEqual({
        sub: 'user-123',
        org_id: 'org-456',
        scope: 'credhelper',
        iat: payload['iat'],
        exp: payload['exp'],
      });
    });
  });

  describe('expired token', () => {
    it('throws EXPIRED_TOKEN when exp is in the past', () => {
      const pastExp = Math.floor(Date.now() / 1000) - 3600;
      const token = makeJwt(validPayload({ exp: pastExp }));

      expect(() => parser.parse(token)).toThrow(CredhelperError);
      try {
        parser.parse(token);
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('EXPIRED_TOKEN');
      }
    });
  });

  describe('wrong scope', () => {
    it('throws INVALID_SCOPE when scope is not "credhelper"', () => {
      const token = makeJwt(validPayload({ scope: 'admin' }));

      expect(() => parser.parse(token)).toThrow(CredhelperError);
      try {
        parser.parse(token);
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('INVALID_SCOPE');
      }
    });
  });

  describe('missing required claims', () => {
    it('throws INVALID_TOKEN when sub is missing', () => {
      const payload = validPayload();
      delete payload['sub'];
      const token = makeJwt(payload);

      expect(() => parser.parse(token)).toThrow(CredhelperError);
      try {
        parser.parse(token);
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('INVALID_TOKEN');
      }
    });

    it('throws INVALID_TOKEN when org_id is missing', () => {
      const payload = validPayload();
      delete payload['org_id'];
      const token = makeJwt(payload);

      expect(() => parser.parse(token)).toThrow(CredhelperError);
      try {
        parser.parse(token);
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('INVALID_TOKEN');
      }
    });

    it('throws INVALID_TOKEN when exp is missing', () => {
      const payload = validPayload();
      delete payload['exp'];
      const token = makeJwt(payload);

      expect(() => parser.parse(token)).toThrow(CredhelperError);
      try {
        parser.parse(token);
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('INVALID_TOKEN');
      }
    });

    it('throws INVALID_TOKEN when iat is missing', () => {
      const payload = validPayload();
      delete payload['iat'];
      const token = makeJwt(payload);

      expect(() => parser.parse(token)).toThrow(CredhelperError);
      try {
        parser.parse(token);
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('INVALID_TOKEN');
      }
    });
  });

  describe('malformed input', () => {
    it('throws INVALID_TOKEN for a string that is not 3 segments', () => {
      expect(() => parser.parse('not-a-jwt')).toThrow(CredhelperError);
      try {
        parser.parse('not-a-jwt');
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('INVALID_TOKEN');
      }
    });

    it('throws INVALID_TOKEN for an empty string', () => {
      expect(() => parser.parse('')).toThrow(CredhelperError);
      try {
        parser.parse('');
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('INVALID_TOKEN');
      }
    });
  });
});
