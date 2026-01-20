// API Key Authentication
export {
  API_KEY_HEADER,
  hashApiKey,
  compareApiKeys,
  validateApiKey,
  createAuthContextFromApiKey,
  hasScope,
  hasAnyScope,
  InMemoryApiKeyStore,
  type ApiKeyStore,
  type ApiKeyValidationResult,
} from './api-key.js';

// JWT Authentication
export {
  createJWTPayloadFromGitHubUser,
  signToken,
  verifyToken,
  createAuthContextFromJWT,
  extractBearerToken,
  decodeTokenPayload,
  type JWTConfig,
} from './jwt.js';

// GitHub OAuth
export {
  setupGitHubOAuth,
  fetchGitHubUser,
  buildGitHubAuthUrl,
  exchangeCodeForToken,
} from './github-oauth.js';

// Auth Middleware
export {
  createAuthMiddleware,
  requireScopes,
  requireAdmin,
  requireRead,
  requireWrite,
  type AuthMiddlewareOptions,
} from './middleware.js';
