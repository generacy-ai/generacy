/**
 * Tests for telemetry stub
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TelemetryService, TelemetryEventType, type TelemetrySender } from '../telemetry';

// Mock config module
vi.mock('../config', () => ({
  getConfig: vi.fn().mockReturnValue({
    isTelemetryEnabled: vi.fn().mockReturnValue(false),
    onDidChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  }),
}));

// Mock logger module
vi.mock('../logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock vscode
vi.mock('vscode', () => ({
  Disposable: vi.fn().mockImplementation((fn: () => void) => ({ dispose: fn })),
}));

describe('TelemetryService', () => {
  let telemetry: TelemetryService;

  beforeEach(() => {
    TelemetryService.resetInstance();
    telemetry = TelemetryService.getInstance();
    vi.clearAllMocks();
  });

  afterEach(() => {
    TelemetryService.resetInstance();
  });

  describe('getInstance', () => {
    it('should return the same instance', () => {
      const instance1 = TelemetryService.getInstance();
      const instance2 = TelemetryService.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('isEnabled', () => {
    it('should return false by default (before initialize)', () => {
      expect(telemetry.isEnabled()).toBe(false);
    });
  });

  describe('trackEvent', () => {
    it('should not throw when telemetry is disabled', () => {
      expect(() => {
        telemetry.trackEvent(TelemetryEventType.ExtensionActivated);
      }).not.toThrow();
    });

    it('should not throw with properties', () => {
      expect(() => {
        telemetry.trackEvent(TelemetryEventType.CommandExecuted, {
          commandId: 'generacy.runWorkflow',
        });
      }).not.toThrow();
    });

    it('should not throw with measurements', () => {
      expect(() => {
        telemetry.trackEvent(
          TelemetryEventType.WorkflowRun,
          undefined,
          { durationMs: 100 }
        );
      }).not.toThrow();
    });
  });

  describe('trackCommand', () => {
    it('should track command execution', () => {
      expect(() => {
        telemetry.trackCommand('generacy.createWorkflow');
      }).not.toThrow();
    });

    it('should track command with duration', () => {
      expect(() => {
        telemetry.trackCommand('generacy.runWorkflow', 150);
      }).not.toThrow();
    });
  });

  describe('trackError', () => {
    it('should track error occurrence', () => {
      expect(() => {
        telemetry.trackError(1001, 'Configuration invalid');
      }).not.toThrow();
    });

    it('should track error without message', () => {
      expect(() => {
        telemetry.trackError(9999);
      }).not.toThrow();
    });
  });

  describe('trackWorkflowOperation', () => {
    it('should track workflow created', () => {
      expect(() => {
        telemetry.trackWorkflowOperation('created', 'basic');
      }).not.toThrow();
    });

    it('should track workflow run', () => {
      expect(() => {
        telemetry.trackWorkflowOperation('run', undefined, 500);
      }).not.toThrow();
    });

    it('should track workflow debug', () => {
      expect(() => {
        telemetry.trackWorkflowOperation('debug');
      }).not.toThrow();
    });

    it('should track workflow validated', () => {
      expect(() => {
        telemetry.trackWorkflowOperation('validated');
      }).not.toThrow();
    });
  });

  describe('setSender', () => {
    it('should accept a custom sender', () => {
      const mockSender: TelemetrySender = {
        sendEvent: vi.fn().mockResolvedValue(undefined),
        flush: vi.fn().mockResolvedValue(undefined),
      };

      expect(() => {
        telemetry.setSender(mockSender);
      }).not.toThrow();
    });
  });

  describe('flush', () => {
    it('should not throw', async () => {
      await expect(telemetry.flush()).resolves.toBeUndefined();
    });
  });

  describe('dispose', () => {
    it('should not throw', () => {
      expect(() => {
        telemetry.dispose();
      }).not.toThrow();
    });
  });
});

describe('TelemetryEventType', () => {
  it('should have extension lifecycle events', () => {
    expect(TelemetryEventType.ExtensionActivated).toBeDefined();
    expect(TelemetryEventType.ExtensionDeactivated).toBeDefined();
  });

  it('should have workflow operation events', () => {
    expect(TelemetryEventType.WorkflowCreated).toBeDefined();
    expect(TelemetryEventType.WorkflowRun).toBeDefined();
    expect(TelemetryEventType.WorkflowDebugStarted).toBeDefined();
    expect(TelemetryEventType.WorkflowValidated).toBeDefined();
  });

  it('should have command events', () => {
    expect(TelemetryEventType.CommandExecuted).toBeDefined();
  });

  it('should have error events', () => {
    expect(TelemetryEventType.ErrorOccurred).toBeDefined();
  });

  it('should have auth events', () => {
    expect(TelemetryEventType.AuthLogin).toBeDefined();
    expect(TelemetryEventType.AuthLogout).toBeDefined();
  });

  it('should have cloud events', () => {
    expect(TelemetryEventType.WorkflowPublished).toBeDefined();
    expect(TelemetryEventType.QueueViewed).toBeDefined();
  });
});
