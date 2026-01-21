/**
 * Tests for configuration manager
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ConfigurationManager, type ExtensionConfig } from '../config';

// Mock VS Code API
vi.mock('vscode', () => {
  const mockConfig: Partial<ExtensionConfig> = {
    workflowDirectory: '.generacy',
    defaultTemplate: 'basic',
    cloudEndpoint: 'https://api.generacy.ai',
    telemetryEnabled: false,
  };

  const configChangeCallbacks: Array<(e: { affectsConfiguration: (section: string) => boolean }) => void> = [];

  return {
    workspace: {
      getConfiguration: vi.fn().mockReturnValue({
        get: vi.fn((key: string, defaultValue: unknown) => {
          const keyMap: Record<string, keyof ExtensionConfig> = {
            workflowDirectory: 'workflowDirectory',
            defaultTemplate: 'defaultTemplate',
            cloudEndpoint: 'cloudEndpoint',
            'telemetry.enabled': 'telemetryEnabled',
          };
          const configKey = keyMap[key];
          return configKey !== undefined ? mockConfig[configKey] : defaultValue;
        }),
        update: vi.fn(),
      }),
      onDidChangeConfiguration: vi.fn((callback: (e: { affectsConfiguration: (section: string) => boolean }) => void) => {
        configChangeCallbacks.push(callback);
        return { dispose: vi.fn() };
      }),
      workspaceFolders: [{ uri: { fsPath: '/workspace', path: '/workspace' } }],
    },
    Uri: {
      joinPath: vi.fn((base: { path: string }, ...segments: string[]) => ({
        fsPath: `${base.path}/${segments.join('/')}`,
        path: `${base.path}/${segments.join('/')}`,
      })),
    },
    ConfigurationTarget: {
      Global: 1,
      Workspace: 2,
      WorkspaceFolder: 3,
    },
    env: {
      isTelemetryEnabled: true,
    },
    Disposable: vi.fn().mockImplementation((fn: () => void) => ({ dispose: fn })),
    // Helper to trigger config changes in tests
    __triggerConfigChange: () => {
      for (const callback of configChangeCallbacks) {
        callback({ affectsConfiguration: (section: string) => section === 'generacy' });
      }
    },
    __setMockConfig: (newConfig: Partial<ExtensionConfig>) => {
      Object.assign(mockConfig, newConfig);
    },
  };
});

describe('ConfigurationManager', () => {
  let config: ConfigurationManager;

  beforeEach(() => {
    ConfigurationManager.resetInstance();
    config = ConfigurationManager.getInstance();
  });

  afterEach(() => {
    ConfigurationManager.resetInstance();
    vi.clearAllMocks();
  });

  describe('getInstance', () => {
    it('should return the same instance', () => {
      const instance1 = ConfigurationManager.getInstance();
      const instance2 = ConfigurationManager.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('getConfig', () => {
    it('should return all configuration values', () => {
      const fullConfig = config.getConfig();
      expect(fullConfig).toEqual({
        workflowDirectory: '.generacy',
        defaultTemplate: 'basic',
        cloudEndpoint: 'https://api.generacy.ai',
        telemetryEnabled: false,
      });
    });

    it('should return a copy of the configuration', () => {
      const config1 = config.getConfig();
      const config2 = config.getConfig();
      expect(config1).not.toBe(config2);
      expect(config1).toEqual(config2);
    });
  });

  describe('get', () => {
    it('should return specific configuration values', () => {
      expect(config.get('workflowDirectory')).toBe('.generacy');
      expect(config.get('defaultTemplate')).toBe('basic');
      expect(config.get('cloudEndpoint')).toBe('https://api.generacy.ai');
      expect(config.get('telemetryEnabled')).toBe(false);
    });
  });

  describe('set', () => {
    it('should update configuration', async () => {
      const vsCodeConfig = vscode.workspace.getConfiguration('generacy');
      await config.set('workflowDirectory', '.workflows');
      expect(vsCodeConfig.update).toHaveBeenCalledWith(
        'workflowDirectory',
        '.workflows',
        vscode.ConfigurationTarget.Global
      );
    });
  });

  describe('getWorkflowDirectoryUri', () => {
    it('should return the workflow directory URI', () => {
      const uri = config.getWorkflowDirectoryUri();
      expect(uri?.path).toBe('/workspace/.generacy');
    });
  });

  describe('isTelemetryEnabled', () => {
    it('should return false when extension telemetry is disabled', () => {
      expect(config.isTelemetryEnabled()).toBe(false);
    });
  });

  describe('onDidChange', () => {
    it('should return a disposable', () => {
      const listener = vi.fn();
      const disposable = config.onDidChange(listener);
      expect(disposable.dispose).toBeDefined();
    });
  });
});
