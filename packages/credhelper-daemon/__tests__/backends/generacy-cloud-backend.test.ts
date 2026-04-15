import { GeneracyCloudBackend } from '../../src/backends/generacy-cloud-backend.js';
import type { SessionTokenProvider } from '../../src/auth/session-token-store.js';
import type { SessionTokenClaims } from '../../src/auth/jwt-parser.js';
import { CredhelperError } from '../../src/errors.js';

const API_URL = 'https://api.generacy.test';

const MOCK_CLAIMS: SessionTokenClaims = {
  sub: 'user-123',
  org_id: 'org-456',
  scope: 'credhelper',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
};

const MOCK_TOKEN = {
  value: 'eyJhbGciOiJIUzI1NiJ9.test.sig',
  claims: MOCK_CLAIMS,
};

function makeTokenProvider(
  token: typeof MOCK_TOKEN | null = MOCK_TOKEN,
): SessionTokenProvider {
  return { getToken: vi.fn().mockResolvedValue(token) };
}

function jsonResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('GeneracyCloudBackend', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('successful fetch', () => {
    it('returns the secret value on 200', async () => {
      mockFetch.mockResolvedValue(jsonResponse(200, { value: 'secret-value' }));

      const backend = new GeneracyCloudBackend(API_URL, makeTokenProvider());
      const result = await backend.fetchSecret('MY_SECRET');

      expect(result).toBe('secret-value');
    });
  });

  describe('auth required (no token)', () => {
    it('throws BACKEND_AUTH_REQUIRED when getToken returns null', async () => {
      const backend = new GeneracyCloudBackend(API_URL, makeTokenProvider(null));

      await expect(backend.fetchSecret('MY_SECRET')).rejects.toThrow(CredhelperError);
      try {
        await backend.fetchSecret('MY_SECRET');
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('BACKEND_AUTH_REQUIRED');
      }
    });

    it('does not call fetch when no token is available', async () => {
      const backend = new GeneracyCloudBackend(API_URL, makeTokenProvider(null));

      await expect(backend.fetchSecret('MY_SECRET')).rejects.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('auth expired (401)', () => {
    it('throws BACKEND_AUTH_EXPIRED when cloud returns 401', async () => {
      mockFetch.mockResolvedValue(jsonResponse(401));

      const backend = new GeneracyCloudBackend(API_URL, makeTokenProvider());

      await expect(backend.fetchSecret('MY_SECRET')).rejects.toThrow(CredhelperError);
      try {
        await backend.fetchSecret('MY_SECRET');
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('BACKEND_AUTH_EXPIRED');
      }
    });
  });

  describe('not found (404)', () => {
    it('throws CREDENTIAL_NOT_FOUND when cloud returns 404', async () => {
      mockFetch.mockResolvedValue(jsonResponse(404));

      const backend = new GeneracyCloudBackend(API_URL, makeTokenProvider());

      await expect(backend.fetchSecret('MISSING_KEY')).rejects.toThrow(CredhelperError);
      try {
        await backend.fetchSecret('MISSING_KEY');
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('CREDENTIAL_NOT_FOUND');
        expect((err as CredhelperError).message).toContain('MISSING_KEY');
      }
    });
  });

  describe('server error (500)', () => {
    it('throws BACKEND_UNREACHABLE when cloud returns 500', async () => {
      mockFetch.mockResolvedValue(jsonResponse(500));

      const backend = new GeneracyCloudBackend(API_URL, makeTokenProvider());

      await expect(backend.fetchSecret('MY_SECRET')).rejects.toThrow(CredhelperError);
      try {
        await backend.fetchSecret('MY_SECRET');
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('BACKEND_UNREACHABLE');
        expect((err as CredhelperError).message).toContain('500');
      }
    });
  });

  describe('URL construction', () => {
    it('encodes special characters in the key', async () => {
      mockFetch.mockResolvedValue(jsonResponse(200, { value: 'val' }));

      const backend = new GeneracyCloudBackend(API_URL, makeTokenProvider());
      await backend.fetchSecret('my/secret key');

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toBe(
        `${API_URL}/api/organizations/${MOCK_CLAIMS.org_id}/credentials/${encodeURIComponent('my/secret key')}/resolve`,
      );
      expect(calledUrl).toContain('my%2Fsecret%20key');
    });
  });

  describe('Authorization header', () => {
    it('sends Bearer token in the Authorization header', async () => {
      mockFetch.mockResolvedValue(jsonResponse(200, { value: 'val' }));

      const backend = new GeneracyCloudBackend(API_URL, makeTokenProvider());
      await backend.fetchSecret('MY_SECRET');

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${MOCK_TOKEN.value}`);
    });

    it('uses POST method', async () => {
      mockFetch.mockResolvedValue(jsonResponse(200, { value: 'val' }));

      const backend = new GeneracyCloudBackend(API_URL, makeTokenProvider());
      await backend.fetchSecret('MY_SECRET');

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1].method).toBe('POST');
    });
  });
});
