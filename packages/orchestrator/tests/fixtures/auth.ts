import type {
  ApiKeyCredential,
  ApiScope,
  JWTPayload,
  GitHubUser,
} from '../../src/types/index.js';

/**
 * Sample API keys for testing
 */
export const sampleApiKeys: Array<{
  plainKey: string;
  credential: Omit<ApiKeyCredential, 'key'>;
}> = [
  {
    plainKey: 'test-api-key-admin-00000001',
    credential: {
      name: 'Admin Key',
      createdAt: new Date().toISOString(),
      scopes: ['admin'],
    },
  },
  {
    plainKey: 'test-api-key-readonly-00002',
    credential: {
      name: 'Read-Only Key',
      createdAt: new Date().toISOString(),
      scopes: ['workflows:read', 'queue:read', 'agents:read'],
    },
  },
  {
    plainKey: 'test-api-key-workflow-0003',
    credential: {
      name: 'Workflow Manager Key',
      createdAt: new Date().toISOString(),
      scopes: ['workflows:read', 'workflows:write'],
    },
  },
  {
    plainKey: 'test-api-key-expired-0004',
    credential: {
      name: 'Expired Key',
      createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      scopes: ['workflows:read'],
    },
  },
  {
    plainKey: 'test-api-key-ratelim-0005',
    credential: {
      name: 'Rate Limited Key',
      createdAt: new Date().toISOString(),
      scopes: ['workflows:read'],
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
  },
];

/**
 * Get a specific sample API key by name
 */
export function getSampleApiKey(name: string): {
  plainKey: string;
  credential: Omit<ApiKeyCredential, 'key'>;
} | undefined {
  return sampleApiKeys.find((k) => k.credential.name === name);
}

/**
 * Sample GitHub users for testing OAuth
 */
export const sampleGitHubUsers: GitHubUser[] = [
  {
    id: 12345,
    login: 'testuser',
    name: 'Test User',
    email: 'test@example.com',
    avatar_url: 'https://github.com/images/testuser.png',
  },
  {
    id: 67890,
    login: 'developer',
    name: 'Developer User',
    email: 'developer@example.com',
    avatar_url: 'https://github.com/images/developer.png',
  },
  {
    id: 11111,
    login: 'noemail',
    name: 'No Email User',
    email: '',
    avatar_url: 'https://github.com/images/noemail.png',
  },
];

/**
 * Create a sample JWT payload
 */
export function createSampleJWTPayload(
  overrides: Partial<JWTPayload> = {}
): JWTPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: 'github:12345',
    name: 'Test User',
    email: 'test@example.com',
    provider: 'github',
    scopes: ['workflows:read', 'queue:read', 'agents:read'],
    iat: now,
    exp: now + 3600, // 1 hour
    ...overrides,
  };
}

/**
 * Create JWT payloads with different scopes
 */
export function createJWTPayloadsWithScopes(): JWTPayload[] {
  const scopeSets: ApiScope[][] = [
    ['admin'],
    ['workflows:read', 'workflows:write'],
    ['queue:read', 'queue:write'],
    ['agents:read'],
    ['workflows:read', 'queue:read', 'agents:read'],
  ];

  return scopeSets.map((scopes, index) =>
    createSampleJWTPayload({
      sub: `user:${index}`,
      name: `User ${index}`,
      scopes,
    })
  );
}

/**
 * Create an expired JWT payload
 */
export function createExpiredJWTPayload(): JWTPayload {
  const past = Math.floor(Date.now() / 1000) - 7200; // 2 hours ago
  return createSampleJWTPayload({
    iat: past,
    exp: past + 3600, // Expired 1 hour ago
  });
}

/**
 * Test authentication scenarios
 */
export const authTestScenarios = {
  validApiKey: {
    header: { 'x-api-key': 'test-api-key-admin-00000001' },
    expectedStatus: 200,
  },
  invalidApiKey: {
    header: { 'x-api-key': 'invalid-key' },
    expectedStatus: 401,
  },
  noAuth: {
    header: {},
    expectedStatus: 401,
  },
  expiredApiKey: {
    header: { 'x-api-key': 'test-api-key-expired-0004' },
    expectedStatus: 401,
  },
};

/**
 * Create mock authorization header
 */
export function createAuthHeader(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/**
 * Create mock API key header
 */
export function createApiKeyHeader(key: string): { 'x-api-key': string } {
  return { 'x-api-key': key };
}
