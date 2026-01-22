/**
 * Debug Adapter implementation for Generacy workflows.
 * Implements the VS Code Debug Adapter Protocol (DAP).
 */
import * as vscode from 'vscode';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { DEBUG_TYPE } from '../constants';
import { getLogger } from '../utils';
import { ProtocolHandler, LaunchRequestArguments } from './protocol';
import { resetDebugRuntime } from './runtime';
import { resetDebugExecutionState } from './state';

/**
 * Generacy Debug Adapter
 *
 * Implements DebugAdapter interface to enable step-through debugging
 * of Generacy workflow YAML files.
 */
export class GeneracyDebugAdapter implements vscode.DebugAdapter {
  private readonly sendMessage = new vscode.EventEmitter<DebugProtocol.ProtocolMessage>();
  private protocolHandler: ProtocolHandler;
  private sequence = 0;
  private logger = getLogger();

  /**
   * Event emitter for sending messages to VS Code
   */
  public readonly onDidSendMessage: vscode.Event<DebugProtocol.ProtocolMessage> =
    this.sendMessage.event;

  constructor() {
    // Reset runtime state for fresh debugging session
    resetDebugRuntime();
    resetDebugExecutionState();

    // Create protocol handler with event sender
    this.protocolHandler = new ProtocolHandler(event => {
      this.sendEvent(event);
    });

    this.logger.debug('GeneracyDebugAdapter created');
  }

  /**
   * Handle messages from VS Code debug client
   */
  public handleMessage(message: DebugProtocol.ProtocolMessage): void {
    if (message.type === 'request') {
      this.handleRequest(message as DebugProtocol.Request);
    }
  }

  /**
   * Handle debug request messages
   */
  private async handleRequest(request: DebugProtocol.Request): Promise<void> {
    this.logger.debug(`DAP Request: ${request.command}`, { seq: request.seq });

    try {
      let body: unknown;

      switch (request.command) {
        case 'initialize':
          body = await this.protocolHandler.handleInitialize(
            request.arguments as DebugProtocol.InitializeRequestArguments
          );
          break;

        case 'configurationDone':
          await this.protocolHandler.handleConfigurationDone();
          break;

        case 'launch':
          await this.protocolHandler.handleLaunch(
            request.arguments as LaunchRequestArguments
          );
          break;

        case 'disconnect':
          await this.protocolHandler.handleDisconnect(
            request.arguments as DebugProtocol.DisconnectArguments
          );
          break;

        case 'terminate':
          await this.protocolHandler.handleTerminate(
            request.arguments as DebugProtocol.TerminateArguments
          );
          break;

        case 'restart':
          await this.protocolHandler.handleRestart(
            request.arguments as DebugProtocol.RestartArguments
          );
          break;

        case 'setBreakpoints':
          body = await this.protocolHandler.handleSetBreakpoints(
            request.arguments as DebugProtocol.SetBreakpointsArguments
          );
          break;

        case 'threads':
          body = await this.protocolHandler.handleThreads();
          break;

        case 'stackTrace':
          body = await this.protocolHandler.handleStackTrace(
            request.arguments as DebugProtocol.StackTraceArguments
          );
          break;

        case 'scopes':
          body = await this.protocolHandler.handleScopes(
            request.arguments as DebugProtocol.ScopesArguments
          );
          break;

        case 'variables':
          body = await this.protocolHandler.handleVariables(
            request.arguments as DebugProtocol.VariablesArguments
          );
          break;

        case 'continue':
          body = await this.protocolHandler.handleContinue(
            request.arguments as DebugProtocol.ContinueArguments
          );
          break;

        case 'next':
          await this.protocolHandler.handleNext(
            request.arguments as DebugProtocol.NextArguments
          );
          break;

        case 'stepIn':
          await this.protocolHandler.handleStepIn(
            request.arguments as DebugProtocol.StepInArguments
          );
          break;

        case 'stepOut':
          await this.protocolHandler.handleStepOut(
            request.arguments as DebugProtocol.StepOutArguments
          );
          break;

        case 'pause':
          await this.protocolHandler.handlePause(
            request.arguments as DebugProtocol.PauseArguments
          );
          break;

        case 'evaluate':
          body = await this.protocolHandler.handleEvaluate(
            request.arguments as DebugProtocol.EvaluateArguments
          );
          break;

        default:
          this.logger.warn(`Unhandled DAP request: ${request.command}`);
          this.sendErrorResponse(
            request,
            `Unknown command: ${request.command}`
          );
          return;
      }

      this.sendResponse(request, body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`DAP Request failed: ${request.command}`, { error: message });
      this.sendErrorResponse(request, message);
    }
  }

  /**
   * Send a success response
   */
  private sendResponse(request: DebugProtocol.Request, body?: unknown): void {
    const response: DebugProtocol.Response = {
      seq: ++this.sequence,
      type: 'response',
      request_seq: request.seq,
      command: request.command,
      success: true,
      body,
    };

    this.logger.debug(`DAP Response: ${request.command}`, { seq: response.seq });
    this.sendMessage.fire(response);
  }

  /**
   * Send an error response
   */
  private sendErrorResponse(request: DebugProtocol.Request, message: string): void {
    const response: DebugProtocol.Response = {
      seq: ++this.sequence,
      type: 'response',
      request_seq: request.seq,
      command: request.command,
      success: false,
      message,
    };

    this.sendMessage.fire(response);
  }

  /**
   * Send an event
   */
  private sendEvent(event: DebugProtocol.Event): void {
    const eventWithSeq = {
      ...event,
      seq: ++this.sequence,
    };

    this.logger.debug(`DAP Event: ${event.event}`);
    this.sendMessage.fire(eventWithSeq);
  }

  /**
   * Dispose the adapter
   */
  public dispose(): void {
    this.protocolHandler.dispose();
    this.sendMessage.dispose();
    this.logger.debug('GeneracyDebugAdapter disposed');
  }
}

/**
 * Debug Adapter Factory for creating debug adapter instances
 */
export class GeneracyDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  private logger = getLogger();

  /**
   * Create a debug adapter for a debug session
   */
  public createDebugAdapterDescriptor(
    _session: vscode.DebugSession,
    _executable: vscode.DebugAdapterExecutable | undefined
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    this.logger.info('Creating debug adapter for session');

    // Return an inline implementation adapter
    return new vscode.DebugAdapterInlineImplementation(
      new GeneracyDebugAdapter()
    );
  }

  public dispose(): void {
    // No resources to clean up
  }
}

/**
 * Debug Configuration Provider for resolving launch configurations
 */
export class GeneracyDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  private logger = getLogger();

  /**
   * Resolve a debug configuration before debugging starts
   */
  public resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    _token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    this.logger.debug('Resolving debug configuration', { config });

    // If no launch.json or empty config, create a default one
    if (!config.type && !config.request && !config.name) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor?.document.languageId === 'yaml' ||
          activeEditor?.document.fileName.includes('.generacy')) {
        return {
          type: DEBUG_TYPE,
          name: 'Debug Workflow',
          request: 'launch',
          workflow: activeEditor.document.uri.fsPath,
          stopOnEntry: true,
        };
      }
    }

    // Ensure type is set
    if (!config.type) {
      config.type = DEBUG_TYPE;
    }

    // Ensure request is set
    if (!config.request) {
      config.request = 'launch';
    }

    // Resolve workflow path
    if (!config.workflow) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        config.workflow = activeEditor.document.uri.fsPath;
      }
    }

    // Resolve ${file} and other variables
    if (config.workflow === '${file}') {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        config.workflow = activeEditor.document.uri.fsPath;
      }
    }

    // Resolve ${workspaceFolder}
    if (config.workflow?.includes('${workspaceFolder}') && folder) {
      config.workflow = config.workflow.replace(
        '${workspaceFolder}',
        folder.uri.fsPath
      );
    }

    // Default stopOnEntry to true for debugging
    if (config.stopOnEntry === undefined) {
      config.stopOnEntry = true;
    }

    this.logger.debug('Resolved debug configuration', { config });
    return config;
  }

  /**
   * Provide initial debug configurations
   */
  public provideDebugConfigurations(
    _folder: vscode.WorkspaceFolder | undefined,
    _token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.DebugConfiguration[]> {
    return [
      {
        type: DEBUG_TYPE,
        request: 'launch',
        name: 'Debug Workflow',
        workflow: '${file}',
        stopOnEntry: true,
      },
      {
        type: DEBUG_TYPE,
        request: 'launch',
        name: 'Run Workflow',
        workflow: '${file}',
        stopOnEntry: false,
      },
    ];
  }
}

/**
 * Register the debug adapter with VS Code
 */
export function registerDebugAdapter(context: vscode.ExtensionContext): void {
  const logger = getLogger();

  // Register debug adapter factory
  const factory = new GeneracyDebugAdapterFactory();
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, factory)
  );
  context.subscriptions.push(factory);

  // Register debug configuration provider
  const configProvider = new GeneracyDebugConfigurationProvider();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, configProvider)
  );

  logger.info('Debug adapter registered');
}
