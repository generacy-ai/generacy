/**
 * Tests for EnvStatusBarProvider.
 *
 * Covers: status display states (missing, incomplete, ok), dynamic updates
 * via onDidChange, command binding, and disposal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock status bar item
// ---------------------------------------------------------------------------

const mockStatusBarItem = {
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
  text: '',
  tooltip: '' as string | undefined,
  backgroundColor: undefined as unknown,
  command: undefined as string | undefined,
  name: undefined as string | undefined,
};

// ---------------------------------------------------------------------------
// Mock vscode
// ---------------------------------------------------------------------------

vi.mock('vscode', () => ({
  window: {
    createStatusBarItem: vi.fn(() => mockStatusBarItem),
  },
  StatusBarAlignment: {
    Left: 1,
    Right: 2,
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
  Disposable: vi.fn().mockImplementation((fn: () => void) => ({ dispose: fn })),
}));

// ---------------------------------------------------------------------------
// Mock runner (required by status-bar.ts ExecutionStatusBarProvider)
// ---------------------------------------------------------------------------

vi.mock('../../views/local/runner', () => ({
  getWorkflowExecutor: () => ({
    addEventListener: vi.fn(() => ({ dispose: vi.fn() })),
    getStatus: vi.fn(() => 'idle'),
    isRunning: vi.fn(() => false),
    getCurrentExecution: vi.fn(() => undefined),
    cancel: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Mock utils
// ---------------------------------------------------------------------------

vi.mock('../../utils', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { EnvStatusBarProvider } from '../status-bar';
import type { EnvConfigService, EnvStatus } from '../../services/env-config-service';

// ---------------------------------------------------------------------------
// Mock EnvConfigService factory
// ---------------------------------------------------------------------------

function createMockEnvService(initialStatus: EnvStatus = 'missing') {
  const listeners: ((status: EnvStatus) => void)[] = [];

  return {
    status: initialStatus,
    onDidChange: vi.fn((listener: (status: EnvStatus) => void) => {
      listeners.push(listener);
      return {
        dispose: () => {
          const idx = listeners.indexOf(listener);
          if (idx >= 0) listeners.splice(idx, 1);
        },
      };
    }),
    dispose: vi.fn(),
    // Helper to simulate status change from tests
    _fireChange(newStatus: EnvStatus) {
      this.status = newStatus;
      listeners.forEach((l) => l(newStatus));
    },
  } as unknown as EnvConfigService & { _fireChange: (s: EnvStatus) => void };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EnvStatusBarProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatusBarItem.text = '';
    mockStatusBarItem.tooltip = undefined;
    mockStatusBarItem.backgroundColor = undefined;
    mockStatusBarItem.command = undefined;
    mockStatusBarItem.name = undefined;
  });

  // ========================================================================
  // Display States
  // ========================================================================

  describe('display states', () => {
    it('should show "$(warning) Env: Missing" with warning color when status is missing', () => {
      const service = createMockEnvService('missing');
      new EnvStatusBarProvider(service);

      expect(mockStatusBarItem.text).toBe('$(warning) Env: Missing');
      expect(mockStatusBarItem.backgroundColor).toEqual(
        expect.objectContaining({ id: 'statusBarItem.warningBackground' }),
      );
      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });

    it('should show "$(warning) Env: Incomplete" with warning color when status is incomplete', () => {
      const service = createMockEnvService('incomplete');
      new EnvStatusBarProvider(service);

      expect(mockStatusBarItem.text).toBe('$(warning) Env: Incomplete');
      expect(mockStatusBarItem.backgroundColor).toEqual(
        expect.objectContaining({ id: 'statusBarItem.warningBackground' }),
      );
      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });

    it('should hide status bar item when status is ok', () => {
      const service = createMockEnvService('ok');
      new EnvStatusBarProvider(service);

      expect(mockStatusBarItem.hide).toHaveBeenCalled();
    });
  });

  // ========================================================================
  // Command Binding
  // ========================================================================

  describe('command binding', () => {
    it('should set command to generacy.configureEnvironment', () => {
      const service = createMockEnvService('missing');
      new EnvStatusBarProvider(service);

      expect(mockStatusBarItem.command).toBe('generacy.configureEnvironment');
    });

    it('should set name to Generacy Environment', () => {
      const service = createMockEnvService('missing');
      new EnvStatusBarProvider(service);

      expect(mockStatusBarItem.name).toBe('Generacy Environment');
    });
  });

  // ========================================================================
  // Dynamic Updates
  // ========================================================================

  describe('dynamic updates via onDidChange', () => {
    it('should update display when status changes from missing to ok', () => {
      const service = createMockEnvService('missing');
      new EnvStatusBarProvider(service);

      expect(mockStatusBarItem.text).toBe('$(warning) Env: Missing');

      service._fireChange('ok');

      expect(mockStatusBarItem.hide).toHaveBeenCalled();
    });

    it('should update display when status changes from ok to incomplete', () => {
      const service = createMockEnvService('ok');
      new EnvStatusBarProvider(service);

      service._fireChange('incomplete');

      expect(mockStatusBarItem.text).toBe('$(warning) Env: Incomplete');
      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });

    it('should update display when status changes from missing to incomplete', () => {
      const service = createMockEnvService('missing');
      new EnvStatusBarProvider(service);

      service._fireChange('incomplete');

      expect(mockStatusBarItem.text).toBe('$(warning) Env: Incomplete');
    });

    it('should subscribe to onDidChange on construction', () => {
      const service = createMockEnvService('missing');
      new EnvStatusBarProvider(service);

      expect(service.onDidChange).toHaveBeenCalledTimes(1);
    });
  });

  // ========================================================================
  // Disposal
  // ========================================================================

  describe('disposal', () => {
    it('should dispose status bar item', () => {
      const service = createMockEnvService('missing');
      const provider = new EnvStatusBarProvider(service);

      provider.dispose();

      expect(mockStatusBarItem.dispose).toHaveBeenCalled();
    });

    it('should clean up event subscriptions so updates no longer propagate', () => {
      const service = createMockEnvService('missing');
      const provider = new EnvStatusBarProvider(service);

      provider.dispose();

      // After dispose, firing a change should not update the status bar
      mockStatusBarItem.text = 'sentinel';
      mockStatusBarItem.hide.mockClear();
      service._fireChange('ok');

      // The text should remain unchanged since listener was removed
      expect(mockStatusBarItem.text).toBe('sentinel');
      expect(mockStatusBarItem.hide).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // Tooltip
  // ========================================================================

  describe('tooltip', () => {
    it('should set tooltip for missing status', () => {
      const service = createMockEnvService('missing');
      new EnvStatusBarProvider(service);

      expect(mockStatusBarItem.tooltip).toBe(
        'Environment file not found. Click to configure.',
      );
    });

    it('should set tooltip for incomplete status', () => {
      const service = createMockEnvService('incomplete');
      new EnvStatusBarProvider(service);

      expect(mockStatusBarItem.tooltip).toBe(
        'Environment file is missing required keys. Click to configure.',
      );
    });
  });

  // ========================================================================
  // Status Bar Alignment
  // ========================================================================

  describe('status bar alignment', () => {
    it('should create status bar item with Left alignment and priority 97', async () => {
      const vscode = await import('vscode');
      const service = createMockEnvService('missing');
      new EnvStatusBarProvider(service);

      expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(
        1, // StatusBarAlignment.Left
        97,
      );
    });
  });
});
