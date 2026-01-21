/**
 * Telemetry stub for Generacy VS Code extension.
 * Provides opt-in telemetry infrastructure without actual data collection.
 *
 * This is a stub implementation that:
 * - Respects user opt-in settings
 * - Provides the API for future telemetry integration
 * - Does NOT send any data to external services
 */
import * as vscode from 'vscode';
import { getConfig } from './config';
import { getLogger } from './logger';

/**
 * Telemetry event types
 */
export enum TelemetryEventType {
  // Extension lifecycle
  ExtensionActivated = 'extension_activated',
  ExtensionDeactivated = 'extension_deactivated',

  // Workflow operations
  WorkflowCreated = 'workflow_created',
  WorkflowRun = 'workflow_run',
  WorkflowDebugStarted = 'workflow_debug_started',
  WorkflowValidated = 'workflow_validated',

  // Commands
  CommandExecuted = 'command_executed',

  // Errors
  ErrorOccurred = 'error_occurred',

  // Authentication
  AuthLogin = 'auth_login',
  AuthLogout = 'auth_logout',

  // Cloud features
  WorkflowPublished = 'workflow_published',
  QueueViewed = 'queue_viewed',
}

/**
 * Telemetry event properties
 */
export interface TelemetryEvent {
  type: TelemetryEventType;
  timestamp: Date;
  properties?: Record<string, string | number | boolean>;
  measurements?: Record<string, number>;
}

/**
 * Telemetry sender interface for future implementation
 */
export interface TelemetrySender {
  sendEvent(event: TelemetryEvent): Promise<void>;
  flush(): Promise<void>;
}

/**
 * Null telemetry sender (default - no-op)
 */
class NullTelemetrySender implements TelemetrySender {
  public async sendEvent(_event: TelemetryEvent): Promise<void> {
    // No-op - telemetry is disabled or this is the stub implementation
  }

  public async flush(): Promise<void> {
    // No-op
  }
}

/**
 * Telemetry service class
 */
export class TelemetryService {
  private static instance: TelemetryService | undefined;
  private sender: TelemetrySender;
  private enabled: boolean;
  private sessionId: string;
  private readonly pendingEvents: TelemetryEvent[] = [];
  private disposable: vscode.Disposable | undefined;

  private constructor() {
    this.sender = new NullTelemetrySender();
    this.enabled = false;
    this.sessionId = this.generateSessionId();
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(): TelemetryService {
    if (!TelemetryService.instance) {
      TelemetryService.instance = new TelemetryService();
    }
    return TelemetryService.instance;
  }

  /**
   * Initialize the telemetry service
   */
  public initialize(context: vscode.ExtensionContext): void {
    const config = getConfig();
    this.enabled = config.isTelemetryEnabled();

    // Listen for configuration changes
    this.disposable = config.onDidChange((event) => {
      if (event.key === 'telemetryEnabled') {
        this.enabled = config.isTelemetryEnabled();
        this.logTelemetryStatus();
      }
    });

    context.subscriptions.push(this.disposable);
    this.logTelemetryStatus();

    // Track activation
    this.trackEvent(TelemetryEventType.ExtensionActivated);
  }

  /**
   * Set a custom telemetry sender (for future implementation)
   */
  public setSender(sender: TelemetrySender): void {
    this.sender = sender;
    // Flush any pending events
    this.flushPendingEvents();
  }

  /**
   * Track a telemetry event
   */
  public trackEvent(
    type: TelemetryEventType,
    properties?: Record<string, string | number | boolean>,
    measurements?: Record<string, number>
  ): void {
    if (!this.enabled) {
      return;
    }

    const event: TelemetryEvent = {
      type,
      timestamp: new Date(),
      properties: {
        ...properties,
        sessionId: this.sessionId,
      },
      measurements,
    };

    // Log for debugging (in development)
    const logger = getLogger();
    logger.debug(`Telemetry event: ${type}`, { properties, measurements });

    // Send to sender (no-op in stub implementation)
    this.sender.sendEvent(event).catch((error) => {
      logger.error('Failed to send telemetry event', error);
    });
  }

  /**
   * Track a command execution
   */
  public trackCommand(commandId: string, durationMs?: number): void {
    this.trackEvent(
      TelemetryEventType.CommandExecuted,
      { commandId },
      durationMs !== undefined ? { durationMs } : undefined
    );
  }

  /**
   * Track an error occurrence
   */
  public trackError(errorCode: number, errorMessage?: string): void {
    this.trackEvent(TelemetryEventType.ErrorOccurred, {
      errorCode,
      // Sanitize error message to avoid PII
      errorType: errorMessage ? this.sanitizeErrorMessage(errorMessage) : 'unknown',
    });
  }

  /**
   * Track a workflow operation
   */
  public trackWorkflowOperation(
    operation: 'created' | 'run' | 'debug' | 'validated',
    templateType?: string,
    durationMs?: number
  ): void {
    const eventMap = {
      created: TelemetryEventType.WorkflowCreated,
      run: TelemetryEventType.WorkflowRun,
      debug: TelemetryEventType.WorkflowDebugStarted,
      validated: TelemetryEventType.WorkflowValidated,
    } as const;

    this.trackEvent(
      eventMap[operation],
      templateType ? { templateType } : undefined,
      durationMs !== undefined ? { durationMs } : undefined
    );
  }

  /**
   * Check if telemetry is currently enabled
   */
  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Flush any pending events
   */
  public async flush(): Promise<void> {
    await this.sender.flush();
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    // Track deactivation before disposing
    if (this.enabled) {
      this.trackEvent(TelemetryEventType.ExtensionDeactivated);
    }

    this.flush().catch(() => {
      // Ignore errors during dispose
    });

    this.disposable?.dispose();
    this.pendingEvents.length = 0;
  }

  /**
   * Reset the singleton instance (for testing)
   */
  public static resetInstance(): void {
    TelemetryService.instance?.dispose();
    TelemetryService.instance = undefined;
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `${timestamp}-${random}`;
  }

  /**
   * Sanitize error message to remove potential PII
   */
  private sanitizeErrorMessage(message: string): string {
    // Remove file paths
    let sanitized = message.replace(/[A-Za-z]:\\[^\s:]+/g, '[PATH]');
    sanitized = sanitized.replace(/\/[^\s:]+/g, '[PATH]');

    // Remove potential email addresses
    sanitized = sanitized.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[EMAIL]');

    // Truncate long messages
    if (sanitized.length > 100) {
      sanitized = sanitized.substring(0, 100) + '...';
    }

    return sanitized;
  }

  /**
   * Log telemetry status
   */
  private logTelemetryStatus(): void {
    const logger = getLogger();
    logger.info(`Telemetry is ${this.enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Flush pending events to the sender
   */
  private async flushPendingEvents(): Promise<void> {
    while (this.pendingEvents.length > 0) {
      const event = this.pendingEvents.shift();
      if (event) {
        await this.sender.sendEvent(event);
      }
    }
  }
}

/**
 * Get the singleton telemetry service instance
 */
export function getTelemetry(): TelemetryService {
  return TelemetryService.getInstance();
}
