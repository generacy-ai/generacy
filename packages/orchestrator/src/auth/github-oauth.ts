import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { GitHubOAuthConfig } from '../config/index.js';
import type { GitHubUser } from '../types/index.js';
import { signToken, createJWTPayloadFromGitHubUser } from './jwt.js';

/**
 * GitHub OAuth2 token response
 */
interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

/**
 * GitHub API error response
 */
interface GitHubErrorResponse {
  error: string;
  error_description: string;
}

/**
 * Setup GitHub OAuth2 routes
 */
export async function setupGitHubOAuth(
  server: FastifyInstance,
  config: GitHubOAuthConfig
): Promise<void> {
  // Register OAuth2 plugin for GitHub
  await server.register(import('@fastify/oauth2'), {
    name: 'githubOAuth2',
    scope: ['read:user', 'user:email'],
    credentials: {
      client: {
        id: config.clientId,
        secret: config.clientSecret,
      },
      auth: {
        authorizeHost: 'https://github.com',
        authorizePath: '/login/oauth/authorize',
        tokenHost: 'https://github.com',
        tokenPath: '/login/oauth/access_token',
      },
    },
    startRedirectPath: '/auth/github',
    callbackUri: config.callbackUrl,
  });

  // Handle OAuth callback
  server.get('/auth/github/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Exchange code for token using the OAuth2 plugin
      const oauth2 = (server as FastifyInstance & { githubOAuth2: { getAccessTokenFromAuthorizationCodeFlow: (request: FastifyRequest) => Promise<{ token: GitHubTokenResponse }> } }).githubOAuth2;
      const { token } = await oauth2.getAccessTokenFromAuthorizationCodeFlow(request);

      // Fetch user info from GitHub
      const user = await fetchGitHubUser(token.access_token);

      // Create JWT token
      const payload = createJWTPayloadFromGitHubUser(user);
      const jwtToken = await signToken(server, payload);

      // Return token to client
      return reply.send({
        token: jwtToken,
        user: {
          id: user.id,
          login: user.login,
          name: user.name,
          email: user.email,
          avatarUrl: user.avatar_url,
        },
      });
    } catch (error) {
      server.log.error({ err: error }, 'GitHub OAuth callback failed');
      return reply.status(401).send({
        type: 'urn:generacy:error:unauthorized',
        title: 'OAuth Authentication Failed',
        status: 401,
        detail: 'Failed to authenticate with GitHub',
      });
    }
  });
}

/**
 * Fetch GitHub user info using access token
 */
export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Generacy-Orchestrator',
    },
  });

  if (!response.ok) {
    const error = (await response.json()) as GitHubErrorResponse;
    throw new Error(`GitHub API error: ${error.error_description || error.error}`);
  }

  const user = (await response.json()) as GitHubUser;

  // If email is not public, fetch from emails endpoint
  if (!user.email) {
    user.email = await fetchGitHubPrimaryEmail(accessToken);
  }

  return user;
}

/**
 * Fetch primary email from GitHub emails endpoint
 */
async function fetchGitHubPrimaryEmail(accessToken: string): Promise<string> {
  const response = await fetch('https://api.github.com/user/emails', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Generacy-Orchestrator',
    },
  });

  if (!response.ok) {
    return '';
  }

  const emails = (await response.json()) as Array<{
    email: string;
    primary: boolean;
    verified: boolean;
  }>;

  const primary = emails.find((e) => e.primary && e.verified);
  return primary?.email ?? emails[0]?.email ?? '';
}

/**
 * Build GitHub authorization URL manually (alternative to plugin)
 */
export function buildGitHubAuthUrl(
  config: GitHubOAuthConfig,
  state: string,
  scopes: string[] = ['read:user', 'user:email']
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: scopes.join(' '),
    state,
  });

  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * Exchange authorization code for access token manually (alternative to plugin)
 */
export async function exchangeCodeForToken(
  config: GitHubOAuthConfig,
  code: string
): Promise<GitHubTokenResponse> {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to exchange code for token');
  }

  const data = (await response.json()) as GitHubTokenResponse | GitHubErrorResponse;

  if ('error' in data) {
    throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`);
  }

  return data;
}
