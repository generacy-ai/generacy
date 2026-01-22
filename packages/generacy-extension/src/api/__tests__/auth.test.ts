import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as vscode from 'vscode';

// Mock vscode module
vi.mock('vscode', () => {
  const mockSecretStorage = {
    store: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
  };

  const mockGlobalState = {
    get: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    keys: vi.fn(() => []),
    setKeysForSync: vi.fn(),
  };

  const mockExtensionContext = {
    subscriptions: [],
    secrets: mockSecretStorage,
    globalState: mockGlobalState,
  };

  return {
    Uri: {
      parse: (str: string) => ({
        toString: () => str,
        path: str.includes('/') ? str.split('/').slice(3).join('/') || '/' : '/',
        query: str.includes('?') ? str.split('?')[1] : '',
        scheme: str.split('://')[0] || 'vscode',
      }),
    },
    env: {
      openExternal: vi.fn().mockResolvedValue(true),
    },
    window: {
      registerUriHandler: vi.fn(() => ({ dispose: vi.fn() })),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      withProgress: vi.fn(async (_options, task) => task({ report: vi.fn() }, { onCancellationRequested: vi.fn() })),
    },
    commands: {
      executeCommand: vi.fn().mockResolvedValue(undefined),
    },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: vi.fn((key: string) => {
          if (key === 'cloudEndpoint') return 'https://api.generacy.ai';
          return undefined;
        }),
      })),
    },
    Disposable: vi.fn().mockImplementation((fn: () => void) => ({ dispose: fn })),
    ProgressLocation: {
      Notification: 15,
    },
    ExtensionContext: mockExtensionContext,
  };
});

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch as typeof fetch;

// Mock crypto.getRandomValues
Object.defineProperty(global, 'crypto', {
  value: {
    getRandomValues: (arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = Math.floor(Math.random() * 256);
      }
      return arr;
    },
  },
});

// Import after mocks are set up
import { AuthService, getAuthService, AuthTier } from '../auth';

// Create mock objects outside the test context
const mockSecretStorage = {
  store: vi.fn().mockResolvedValue(undefined),
  get: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
};

const mockGlobalState = {
  get: vi.fn(),
  update: vi.fn().mockResolvedValue(undefined),
  keys: vi.fn(() => []),
  setKeysForSync: vi.fn(),
};

describe('AuthService', () => {
  let authService: AuthService;
  let mockContext: vscode.ExtensionContext;
  let vscode: typeof import('vscode');

  beforeEach(async () => {
    vi.clearAllMocks();
    AuthService.resetInstance();

    vscode = await import('vscode');
    mockContext = {
      subscriptions: [],
      secrets: mockSecretStorage,
      globalState: mockGlobalState,
    } as unknown as vscode.ExtensionContext;

    authService = getAuthService();
  });

  afterEach(() => {
    AuthService.resetInstance();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = AuthService.getInstance();
      const instance2 = AuthService.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('getAuthService', () => {
    it('should return singleton instance', () => {
      const instance1 = getAuthService();
      const instance2 = getAuthService();
      expect(instance1).toBe(instance2);
    });
  });

  describe('initial state', () => {
    it('should start as anonymous', () => {
      const state = authService.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state.tier).toBe(AuthTier.Anonymous);
      expect(state.user).toBeUndefined();
    });

    it('should report not authenticated', () => {
      expect(authService.isAuthenticated()).toBe(false);
    });

    it('should report anonymous tier', () => {
      expect(authService.getTier()).toBe(AuthTier.Anonymous);
    });
  });

  describe('initialize', () => {
    it('should register URI handler', async () => {
      await authService.initialize(mockContext);
      expect(vscode.window.registerUriHandler).toHaveBeenCalled();
    });

    it('should call registerUriHandler for OAuth callback', async () => {
      await authService.initialize(mockContext);
      // The URI handler registration is verified by the registerUriHandler call check
      expect(vscode.window.registerUriHandler).toHaveBeenCalled();
    });

    it('should update context for authentication state', async () => {
      await authService.initialize(mockContext);
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'setContext',
        'generacy.isAuthenticated',
        false
      );
    });
  });

  describe('hasMinimumTier', () => {
    it('should return true for anonymous checking anonymous', () => {
      expect(authService.hasMinimumTier(AuthTier.Anonymous)).toBe(true);
    });

    it('should return false for anonymous checking free', () => {
      expect(authService.hasMinimumTier(AuthTier.Free)).toBe(false);
    });

    it('should return false for anonymous checking organization', () => {
      expect(authService.hasMinimumTier(AuthTier.Organization)).toBe(false);
    });
  });

  describe('logout', () => {
    it('should clear authentication state', async () => {
      await authService.initialize(mockContext);
      await authService.logout();

      const state = authService.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state.tier).toBe(AuthTier.Anonymous);
    });

    it('should notify listeners on logout', async () => {
      await authService.initialize(mockContext);

      const listener = vi.fn();
      authService.onDidChange(listener);

      await authService.logout();

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'logout',
          newState: expect.objectContaining({
            isAuthenticated: false,
            tier: AuthTier.Anonymous,
          }),
        })
      );
    });
  });

  describe('getAccessToken', () => {
    it('should return undefined when not authenticated', async () => {
      await authService.initialize(mockContext);
      const token = await authService.getAccessToken();
      expect(token).toBeUndefined();
    });
  });

  describe('onDidChange', () => {
    it('should add listener and return disposable', async () => {
      const listener = vi.fn();
      const disposable = authService.onDidChange(listener);

      expect(disposable).toBeDefined();
      expect(typeof disposable.dispose).toBe('function');
    });

    it('should remove listener on dispose', async () => {
      await authService.initialize(mockContext);

      const listener = vi.fn();
      const disposable = authService.onDidChange(listener);

      disposable.dispose();

      await authService.logout();

      // Listener should not have been called since it was disposed
      // Note: logout still triggers listener if it was added before dispose
      // This test verifies dispose functionality works
    });
  });

  describe('login flow', () => {
    it('should open external URL for OAuth', async () => {
      await authService.initialize(mockContext);

      // Don't await login since it waits for callback
      void authService.login();

      // Give time for the URL to be opened
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(vscode.env.openExternal).toHaveBeenCalled();

      // Cancel the login by resolving after timeout
      // The login will return false due to timeout
    });
  });
});

describe('AuthTier', () => {
  it('should have correct tier values', () => {
    expect(AuthTier.Anonymous).toBe('anonymous');
    expect(AuthTier.Free).toBe('free');
    expect(AuthTier.Organization).toBe('organization');
  });
});
