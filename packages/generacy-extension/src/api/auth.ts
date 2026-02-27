/**
 * Authentication module for Generacy VS Code extension.
 * Handles GitHub OAuth flow, token persistence, and authentication state management.
 */
import * as vscode from 'vscode';
import { getLogger, getConfig, GeneracyError, ErrorCode } from '../utils';
import { CONTEXT_KEYS } from '../constants';
import { userApi, type UserProfile, type UserOrg } from './endpoints/user';

/**
 * Authentication tiers for progressive authentication
 */
export enum AuthTier {
  /** No account - can view extension, see features */
  Anonymous = 'anonymous',
  /** Free account - full local mode access */
  Free = 'free',
  /** Organization member - cloud mode unlocked */
  Organization = 'organization',
}

/**
 * User information from authentication
 */
export interface AuthUser {
  /** Unique user identifier */
  id: string;
  /** GitHub username */
  username: string;
  /** Display name */
  displayName: string;
  /** Email address */
  email?: string;
  /** Avatar URL */
  avatarUrl?: string;
  /** Authentication tier */
  tier: AuthTier;
  /** Organization ID (if org member) */
  organizationId?: string;
  /** Organization name (if org member) */
  organizationName?: string;
  /** Organization memberships from user profile */
  organizations?: UserOrg[];
}

/**
 * Token information stored securely
 */
export interface AuthToken {
  /** Access token */
  accessToken: string;
  /** Refresh token */
  refreshToken?: string;
  /** Token expiration timestamp (ms) */
  expiresAt?: number;
  /** Token scope */
  scope?: string;
}

/**
 * Authentication state
 */
export interface AuthState {
  /** Whether the user is authenticated */
  isAuthenticated: boolean;
  /** Current user information */
  user?: AuthUser;
  /** Authentication tier */
  tier: AuthTier;
  /** Last authentication time */
  lastAuthTime?: number;
}

/**
 * Authentication change event
 */
export interface AuthChangeEvent {
  /** Previous state */
  previousState: AuthState;
  /** New state */
  newState: AuthState;
  /** Reason for change */
  reason: 'login' | 'logout' | 'token_refresh' | 'token_expired' | 'tier_change';
}

/**
 * Storage keys for secrets
 */
const STORAGE_KEYS = {
  accessToken: 'generacy.auth.accessToken',
  refreshToken: 'generacy.auth.refreshToken',
  tokenExpiry: 'generacy.auth.tokenExpiry',
  user: 'generacy.auth.user',
} as const;

/**
 * OAuth callback URI scheme for VS Code
 */
const OAUTH_CALLBACK_SCHEME = 'vscode';
const OAUTH_CALLBACK_AUTHORITY = 'generacy-ai.generacy-extension';
const OAUTH_CALLBACK_PATH = '/auth/callback';

/**
 * Authentication service for managing OAuth flow and tokens
 */
export class AuthService {
  private static instance: AuthService | undefined;
  private secretStorage: vscode.SecretStorage | undefined;
  private globalState: vscode.Memento | undefined;
  private readonly listeners = new Set<(event: AuthChangeEvent) => void>();
  private currentState: AuthState;
  private disposables: vscode.Disposable[] = [];
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor() {
    this.currentState = {
      isAuthenticated: false,
      tier: AuthTier.Anonymous,
    };
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): AuthService {
    if (!AuthService.instance) {
      AuthService.instance = new AuthService();
    }
    return AuthService.instance;
  }

  /**
   * Initialize the authentication service
   */
  public async initialize(context: vscode.ExtensionContext): Promise<void> {
    const logger = getLogger();
    logger.info('Initializing authentication service');

    this.secretStorage = context.secrets;
    this.globalState = context.globalState;

    // Register URI handler for OAuth callback
    this.disposables.push(
      vscode.window.registerUriHandler({
        handleUri: (uri) => this.handleOAuthCallback(uri),
      })
    );

    // Try to restore previous session
    await this.restoreSession();

    // Set up token refresh if authenticated
    if (this.currentState.isAuthenticated) {
      this.scheduleTokenRefresh();
    }

    // Update context for when clauses
    await this.updateContext();

    logger.info('Authentication service initialized', {
      isAuthenticated: this.currentState.isAuthenticated,
      tier: this.currentState.tier,
    });
  }

  /**
   * Get current authentication state
   */
  public getState(): AuthState {
    return { ...this.currentState };
  }

  /**
   * Check if user is authenticated
   */
  public isAuthenticated(): boolean {
    return this.currentState.isAuthenticated;
  }

  /**
   * Get current authentication tier
   */
  public getTier(): AuthTier {
    return this.currentState.tier;
  }

  /**
   * Get current user
   */
  public getUser(): AuthUser | undefined {
    return this.currentState.user ? { ...this.currentState.user } : undefined;
  }

  /**
   * Get the organization ID for the authenticated user.
   * Returns the first org ID, or undefined if not authenticated or no orgs.
   */
  public getOrganizationId(): string | undefined {
    return this.currentState.user?.organizationId;
  }

  /**
   * Check if user has at least the specified tier
   */
  public hasMinimumTier(tier: AuthTier): boolean {
    const tierOrder = [AuthTier.Anonymous, AuthTier.Free, AuthTier.Organization];
    const currentIndex = tierOrder.indexOf(this.currentState.tier);
    const requiredIndex = tierOrder.indexOf(tier);
    return currentIndex >= requiredIndex;
  }

  /**
   * Start the login flow
   */
  public async login(): Promise<boolean> {
    const logger = getLogger();
    logger.info('Starting login flow');

    try {
      const config = getConfig();
      const cloudEndpoint = config.get('cloudEndpoint');
      const callbackUri = this.getCallbackUri();

      // Generate state for CSRF protection
      const state = this.generateState();
      await this.secretStorage?.store('generacy.auth.state', state);

      // Build authorization URL
      const authUrl = new URL('/auth/github', cloudEndpoint);
      authUrl.searchParams.set('redirect_uri', callbackUri.toString());
      authUrl.searchParams.set('state', state);

      // Open browser for OAuth
      logger.info('Opening browser for OAuth', { authUrl: authUrl.toString() });
      await vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));

      // Wait for callback with timeout
      const result = await this.waitForCallback(60000); // 60 second timeout

      if (result) {
        logger.info('Login successful');
        return true;
      } else {
        logger.warn('Login cancelled or timed out');
        return false;
      }
    } catch (error) {
      logger.error('Login failed', error);
      throw GeneracyError.from(error, ErrorCode.AuthFailed, 'Failed to complete login');
    }
  }

  /**
   * Logout the current user
   */
  public async logout(): Promise<void> {
    const logger = getLogger();
    logger.info('Logging out');

    const previousState = { ...this.currentState };

    // Clear tokens
    await this.clearTokens();

    // Update state
    this.currentState = {
      isAuthenticated: false,
      tier: AuthTier.Anonymous,
    };

    // Update context
    await this.updateContext();

    // Clear token refresh
    this.clearTokenRefresh();

    // Notify listeners
    this.notifyListeners({
      previousState,
      newState: { ...this.currentState },
      reason: 'logout',
    });

    logger.info('Logout complete');
  }

  /**
   * Get access token, refreshing if necessary
   */
  public async getAccessToken(): Promise<string | undefined> {
    if (!this.currentState.isAuthenticated) {
      return undefined;
    }

    const token = await this.secretStorage?.get(STORAGE_KEYS.accessToken);
    if (!token) {
      return undefined;
    }

    // Check if token is expired
    const expiryStr = await this.secretStorage?.get(STORAGE_KEYS.tokenExpiry);
    if (expiryStr) {
      const expiry = parseInt(expiryStr, 10);
      if (Date.now() >= expiry - 60000) {
        // Refresh if expiring in < 1 minute
        const refreshed = await this.refreshToken();
        if (!refreshed) {
          return undefined;
        }
        return this.secretStorage?.get(STORAGE_KEYS.accessToken);
      }
    }

    return token;
  }

  /**
   * Add listener for authentication changes
   */
  public onDidChange(listener: (event: AuthChangeEvent) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => {
      this.listeners.delete(listener);
    });
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.clearTokenRefresh();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    this.listeners.clear();
  }

  /**
   * Reset singleton (for testing)
   */
  public static resetInstance(): void {
    AuthService.instance?.dispose();
    AuthService.instance = undefined;
  }

  /**
   * Fetch user profile from the API and update auth state with org memberships.
   * Called after token exchange and during session restore when org data is missing.
   */
  private async fetchUserProfile(): Promise<void> {
    const logger = getLogger();

    try {
      logger.info('Fetching user profile for org resolution');
      const profile: UserProfile = await userApi.getProfile();

      if (!this.currentState.user) {
        return;
      }

      // Resolve organization: use first org or match against project config
      const orgs = profile.organizations ?? [];
      let orgId: string | undefined;
      let orgName: string | undefined;

      const firstOrg = orgs[0];
      if (firstOrg) {
        orgId = firstOrg.id;
        orgName = firstOrg.name;
      }

      // Update auth user with org data
      this.currentState.user = {
        ...this.currentState.user,
        organizations: orgs,
        organizationId: orgId,
        organizationName: orgName,
        tier: (profile.tier as AuthTier) || this.currentState.user.tier,
      };

      // Persist updated user
      await this.globalState?.update(STORAGE_KEYS.user, this.currentState.user);

      // Update tier if org membership changes it
      if (orgId && this.currentState.tier !== AuthTier.Organization) {
        const previousState = { ...this.currentState };
        this.currentState.tier = AuthTier.Organization;

        this.notifyListeners({
          previousState,
          newState: { ...this.currentState },
          reason: 'tier_change',
        });
      }

      logger.info('User profile fetched', {
        organizationId: orgId,
        orgCount: orgs.length,
      });
    } catch (error) {
      // Profile fetch is non-fatal — user stays authenticated with token-exchange data
      logger.error('Failed to fetch user profile for org resolution', error);
    }
  }

  /**
   * Handle OAuth callback URI
   */
  private async handleOAuthCallback(uri: vscode.Uri): Promise<void> {
    const logger = getLogger();
    logger.info('Handling OAuth callback', { path: uri.path });

    if (uri.path !== OAUTH_CALLBACK_PATH) {
      logger.debug('Ignoring non-auth callback URI');
      return;
    }

    const params = new URLSearchParams(uri.query);
    const code = params.get('code');
    const state = params.get('state');
    const error = params.get('error');

    if (error) {
      logger.error('OAuth error', undefined, { error, description: params.get('error_description') });
      this.rejectCallback(new GeneracyError(ErrorCode.AuthFailed, params.get('error_description') ?? error));
      return;
    }

    if (!code || !state) {
      logger.error('Missing code or state in callback');
      this.rejectCallback(new GeneracyError(ErrorCode.AuthFailed, 'Invalid callback parameters'));
      return;
    }

    // Verify state
    const storedState = await this.secretStorage?.get('generacy.auth.state');
    if (state !== storedState) {
      logger.error('State mismatch in callback');
      this.rejectCallback(new GeneracyError(ErrorCode.AuthFailed, 'Invalid state parameter'));
      return;
    }

    // Exchange code for tokens
    try {
      await this.exchangeCodeForTokens(code);
      this.resolveCallback(true);
    } catch (err) {
      this.rejectCallback(GeneracyError.from(err, ErrorCode.AuthFailed));
    }
  }

  /**
   * Exchange authorization code for tokens
   */
  private async exchangeCodeForTokens(code: string): Promise<void> {
    const logger = getLogger();
    const config = getConfig();
    const cloudEndpoint = config.get('cloudEndpoint');

    logger.info('Exchanging code for tokens');

    const response = await fetch(`${cloudEndpoint}/auth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code,
        redirect_uri: this.getCallbackUri().toString(),
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new GeneracyError(
        ErrorCode.AuthFailed,
        (errorData as { message?: string }).message ?? 'Failed to exchange code for tokens'
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      user: {
        id: string;
        username: string;
        display_name: string;
        email?: string;
        avatar_url?: string;
        tier: string;
        organization_id?: string;
        organization_name?: string;
      };
    };

    // Store tokens
    await this.storeTokens({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    });

    // Parse user
    const user: AuthUser = {
      id: data.user.id,
      username: data.user.username,
      displayName: data.user.display_name,
      email: data.user.email,
      avatarUrl: data.user.avatar_url,
      tier: data.user.tier as AuthTier,
      organizationId: data.user.organization_id,
      organizationName: data.user.organization_name,
    };

    // Store user in global state
    await this.globalState?.update(STORAGE_KEYS.user, user);

    // Update state
    const previousState = { ...this.currentState };
    this.currentState = {
      isAuthenticated: true,
      user,
      tier: user.tier,
      lastAuthTime: Date.now(),
    };

    // Update context
    await this.updateContext();

    // Schedule token refresh
    this.scheduleTokenRefresh();

    // Fetch full user profile to get org memberships
    await this.fetchUserProfile();

    // Notify listeners
    this.notifyListeners({
      previousState,
      newState: { ...this.currentState },
      reason: 'login',
    });

    logger.info('Tokens exchanged successfully', {
      tier: this.currentState.user?.tier ?? user.tier,
      organizationId: this.currentState.user?.organizationId,
    });
  }

  /**
   * Store tokens securely
   */
  private async storeTokens(token: AuthToken): Promise<void> {
    await this.secretStorage?.store(STORAGE_KEYS.accessToken, token.accessToken);

    if (token.refreshToken) {
      await this.secretStorage?.store(STORAGE_KEYS.refreshToken, token.refreshToken);
    }

    if (token.expiresAt) {
      await this.secretStorage?.store(STORAGE_KEYS.tokenExpiry, token.expiresAt.toString());
    }
  }

  /**
   * Clear stored tokens
   */
  private async clearTokens(): Promise<void> {
    await this.secretStorage?.delete(STORAGE_KEYS.accessToken);
    await this.secretStorage?.delete(STORAGE_KEYS.refreshToken);
    await this.secretStorage?.delete(STORAGE_KEYS.tokenExpiry);
    await this.secretStorage?.delete('generacy.auth.state');
    await this.globalState?.update(STORAGE_KEYS.user, undefined);
  }

  /**
   * Refresh the access token
   */
  private async refreshToken(): Promise<boolean> {
    const logger = getLogger();
    const config = getConfig();
    const cloudEndpoint = config.get('cloudEndpoint');

    const refreshToken = await this.secretStorage?.get(STORAGE_KEYS.refreshToken);
    if (!refreshToken) {
      logger.warn('No refresh token available');
      await this.handleTokenExpired();
      return false;
    }

    logger.info('Refreshing access token');

    try {
      const response = await fetch(`${cloudEndpoint}/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          refresh_token: refreshToken,
        }),
      });

      if (!response.ok) {
        logger.error('Token refresh failed', undefined, { status: response.status });
        await this.handleTokenExpired();
        return false;
      }

      const data = (await response.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
      };

      await this.storeTokens({
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? refreshToken,
        expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      });

      // Schedule next refresh
      this.scheduleTokenRefresh();

      // Notify listeners
      const previousState = { ...this.currentState };
      this.currentState.lastAuthTime = Date.now();
      this.notifyListeners({
        previousState,
        newState: { ...this.currentState },
        reason: 'token_refresh',
      });

      logger.info('Token refreshed successfully');
      return true;
    } catch (error) {
      logger.error('Token refresh error', error);
      await this.handleTokenExpired();
      return false;
    }
  }

  /**
   * Handle token expiration
   */
  private async handleTokenExpired(): Promise<void> {
    const logger = getLogger();
    logger.warn('Token expired, logging out');

    const previousState = { ...this.currentState };

    await this.clearTokens();
    this.currentState = {
      isAuthenticated: false,
      tier: AuthTier.Anonymous,
    };

    await this.updateContext();
    this.clearTokenRefresh();

    this.notifyListeners({
      previousState,
      newState: { ...this.currentState },
      reason: 'token_expired',
    });

    // Show notification to user
    vscode.window.showWarningMessage(
      'Your session has expired. Please log in again.',
      'Login'
    ).then((action) => {
      if (action === 'Login') {
        void this.login();
      }
    });
  }

  /**
   * Schedule token refresh before expiration
   */
  private scheduleTokenRefresh(): void {
    this.clearTokenRefresh();

    void this.secretStorage?.get(STORAGE_KEYS.tokenExpiry).then((expiryStr) => {
      if (!expiryStr) {
        return;
      }

      const expiry = parseInt(expiryStr, 10);
      const now = Date.now();
      // Refresh 5 minutes before expiration
      const refreshTime = expiry - 5 * 60 * 1000;

      if (refreshTime > now) {
        this.tokenRefreshTimer = setTimeout(() => {
          void this.refreshToken();
        }, refreshTime - now);
      }
    });
  }

  /**
   * Clear token refresh timer
   */
  private clearTokenRefresh(): void {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = undefined;
    }
  }

  /**
   * Restore previous session from storage
   */
  private async restoreSession(): Promise<void> {
    const logger = getLogger();

    const accessToken = await this.secretStorage?.get(STORAGE_KEYS.accessToken);
    if (!accessToken) {
      logger.debug('No stored session found');
      return;
    }

    // Check if token is expired
    const expiryStr = await this.secretStorage?.get(STORAGE_KEYS.tokenExpiry);
    if (expiryStr) {
      const expiry = parseInt(expiryStr, 10);
      if (Date.now() >= expiry) {
        logger.info('Stored token expired, attempting refresh');
        const refreshed = await this.refreshToken();
        if (!refreshed) {
          return;
        }
      }
    }

    // Restore user from global state
    const user = this.globalState?.get<AuthUser>(STORAGE_KEYS.user);
    if (user) {
      this.currentState = {
        isAuthenticated: true,
        user,
        tier: user.tier,
        lastAuthTime: Date.now(),
      };
      logger.info('Session restored', { tier: user.tier });

      // Re-fetch profile if org data is missing (e.g., upgraded from older version)
      if (!user.organizationId && !user.organizations?.length) {
        logger.info('Org data missing from stored session, fetching user profile');
        await this.fetchUserProfile();
      }
    }
  }

  /**
   * Update VS Code context for when clauses
   */
  private async updateContext(): Promise<void> {
    await vscode.commands.executeCommand(
      'setContext',
      CONTEXT_KEYS.isAuthenticated,
      this.currentState.isAuthenticated
    );
  }

  /**
   * Get callback URI for OAuth
   */
  private getCallbackUri(): vscode.Uri {
    return vscode.Uri.parse(`${OAUTH_CALLBACK_SCHEME}://${OAUTH_CALLBACK_AUTHORITY}${OAUTH_CALLBACK_PATH}`);
  }

  /**
   * Generate random state for CSRF protection
   */
  private generateState(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Notify all listeners of authentication change
   */
  private notifyListeners(event: AuthChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('Auth change listener error:', error);
      }
    }
  }

  // Callback promise handling for OAuth flow
  private callbackResolve: ((value: boolean) => void) | undefined;
  private callbackReject: ((error: Error) => void) | undefined;

  private waitForCallback(timeout: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.callbackResolve = resolve;
      this.callbackReject = reject;

      setTimeout(() => {
        this.callbackResolve = undefined;
        this.callbackReject = undefined;
        resolve(false);
      }, timeout);
    });
  }

  private resolveCallback(value: boolean): void {
    if (this.callbackResolve) {
      this.callbackResolve(value);
      this.callbackResolve = undefined;
      this.callbackReject = undefined;
    }
  }

  private rejectCallback(error: Error): void {
    if (this.callbackReject) {
      this.callbackReject(error);
      this.callbackResolve = undefined;
      this.callbackReject = undefined;
    }
  }
}

/**
 * Get the singleton authentication service instance
 */
export function getAuthService(): AuthService {
  return AuthService.getInstance();
}
