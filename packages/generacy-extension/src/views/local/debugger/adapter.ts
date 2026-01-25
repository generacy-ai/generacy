/**
 * Debug Adapter Protocol (DAP) implementation for Generacy workflow debugging.
 * Implements the VS Code Debug Adapter interface for workflow step-through debugging.
 */
import * as vscode from 'vscode';
import * as yaml from 'yaml';
import * as path from 'path';
import { DEBUG_TYPE, WORKFLOW_EXTENSIONS } from '../../../constants';
import { getLogger, GeneracyError, ErrorCode } from '../../../utils';
import {
  getBreakpointManager,
  type BreakpointLocation,
  type WorkflowBreakpoint,
} from './breakpoints';
import {
  getDebugSession,
  type DebugSessionConfig,
  type DebugSessionEvent,
  type ExecutionPosition,
} from './session';
import type { ExecutableWorkflow } from '../runner/types';
import { WorkflowExecutor } from '../runner/executor';

/**
 * DAP Messages - simplified interfaces matching Debug Adapter Protocol
 */

interface DAPBreakpoint {
  id?: number;
  verified: boolean;
  message?: string;
  source?: { path: string };
  line?: number;
  column?: number;
}

interface DAPStackFrame {
  id: number;
  name: string;
  source?: { name?: string; path?: string };
  line: number;
  column: number;
}

interface DAPScope {
  name: string;
  variablesReference: number;
  expensive: boolean;
}

interface DAPVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

interface DAPThread {
  id: number;
  name: string;
}

/**
 * Launch request arguments
 */
export interface LaunchRequestArguments {
  /** Path to the workflow file to debug */
  workflow: string;
  /** Run in dry-run mode */
  dryRun?: boolean;
  /** Environment variables */
  env?: Record<string, string>;
  /** Stop on entry */
  stopOnEntry?: boolean;
  /** Working directory */
  cwd?: string;
  /** Pause on step errors (default: true, opt-out per design decision D3) */
  pauseOnError?: boolean;
}

/**
 * Debug Adapter Factory for creating debug sessions
 */
export class WorkflowDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  private adapter: WorkflowDebugAdapter | undefined;

  /**
   * Create a debug adapter descriptor
   */
  createDebugAdapterDescriptor(
    session: vscode.DebugSession,
    _executable: vscode.DebugAdapterExecutable | undefined
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const logger = getLogger();
    logger.debug('Creating debug adapter', { sessionId: session.id });

    // Create inline debug adapter
    this.adapter = new WorkflowDebugAdapter();
    return new vscode.DebugAdapterInlineImplementation(this.adapter);
  }

  /**
   * Get the current adapter
   */
  public getAdapter(): WorkflowDebugAdapter | undefined {
    return this.adapter;
  }

  /**
   * Dispose
   */
  public dispose(): void {
    this.adapter?.dispose();
    this.adapter = undefined;
  }
}

/**
 * Debug configuration provider for launch configurations
 */
export class WorkflowDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  /**
   * Resolve a debug configuration
   */
  resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    _token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    const logger = getLogger();

    // If no config provided, create a default one
    if (!config.type && !config.request && !config.name) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const ext = path.extname(editor.document.uri.fsPath).toLowerCase();
        if (WORKFLOW_EXTENSIONS.includes(ext as typeof WORKFLOW_EXTENSIONS[number])) {
          config.type = DEBUG_TYPE;
          config.name = 'Debug Workflow';
          config.request = 'launch';
          config.workflow = editor.document.uri.fsPath;
          config.stopOnEntry = true;
        }
      }
    }

    // Validate required fields
    if (!config.workflow) {
      logger.error('No workflow specified in debug configuration');
      return undefined; // Abort launch
    }

    // Resolve relative paths
    if (folder && !path.isAbsolute(config.workflow)) {
      config.workflow = path.join(folder.uri.fsPath, config.workflow);
    }

    // Set defaults
    config.stopOnEntry = config.stopOnEntry ?? false;
    config.dryRun = config.dryRun ?? false;
    config.cwd = config.cwd ?? folder?.uri.fsPath;

    logger.debug('Resolved debug configuration', { workflow: config.workflow });

    return config;
  }

  /**
   * Provide initial configurations
   */
  provideDebugConfigurations(
    _folder: vscode.WorkspaceFolder | undefined,
    _token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.DebugConfiguration[]> {
    return [
      {
        type: DEBUG_TYPE,
        request: 'launch',
        name: 'Debug Current Workflow',
        workflow: '${file}',
        stopOnEntry: true,
      },
      {
        type: DEBUG_TYPE,
        request: 'launch',
        name: 'Debug Workflow (Dry Run)',
        workflow: '${file}',
        dryRun: true,
        stopOnEntry: true,
      },
    ];
  }
}

/**
 * Debug Adapter implementing the Debug Adapter Protocol.
 */
export class WorkflowDebugAdapter implements vscode.DebugAdapter {
  private readonly sendMessage: vscode.EventEmitter<vscode.DebugProtocolMessage>;
  private readonly onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage>;
  private sequenceNumber = 1;
  private sessionEventListener: vscode.Disposable | undefined;
  private currentWorkflowUri: vscode.Uri | undefined;
  private locationMap: Map<number, BreakpointLocation> = new Map();
  private disposed = false;

  constructor() {
    this.sendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    this.onDidSendMessage = this.sendMessage.event;
  }

  /**
   * Handle incoming DAP messages
   */
  handleMessage(message: vscode.DebugProtocolMessage): void {
    if (this.disposed) {
      return;
    }

    const msg = message as { type: string; command?: string; seq: number; arguments?: unknown };
    const logger = getLogger();

    logger.debug('DAP message received', { type: msg.type, command: msg.command });

    if (msg.type === 'request') {
      this.handleRequest(msg.command!, msg.seq, msg.arguments)
        .catch(error => {
          logger.error('DAP request error', { command: msg.command, error: String(error) });
          this.sendErrorResponse(msg.seq, msg.command!, String(error));
        });
    }
  }

  /**
   * Handle DAP requests
   */
  private async handleRequest(command: string, seq: number, args: unknown): Promise<void> {
    switch (command) {
      case 'initialize':
        await this.handleInitialize(seq);
        break;
      case 'launch':
        await this.handleLaunch(seq, args as LaunchRequestArguments);
        break;
      case 'setBreakpoints':
        await this.handleSetBreakpoints(seq, args as { source: { path: string }; breakpoints?: Array<{ line: number; condition?: string; hitCondition?: string; logMessage?: string }> });
        break;
      case 'setExceptionBreakpoints':
        await this.handleSetExceptionBreakpoints(seq);
        break;
      case 'configurationDone':
        await this.handleConfigurationDone(seq);
        break;
      case 'threads':
        await this.handleThreads(seq);
        break;
      case 'stackTrace':
        await this.handleStackTrace(seq, args as { threadId: number; startFrame?: number; levels?: number });
        break;
      case 'scopes':
        await this.handleScopes(seq, args as { frameId: number });
        break;
      case 'variables':
        await this.handleVariables(seq, args as { variablesReference: number });
        break;
      case 'continue':
        await this.handleContinue(seq);
        break;
      case 'next':
        await this.handleNext(seq);
        break;
      case 'stepIn':
        await this.handleStepIn(seq);
        break;
      case 'stepOut':
        await this.handleStepOut(seq);
        break;
      case 'pause':
        await this.handlePause(seq);
        break;
      case 'disconnect':
        await this.handleDisconnect(seq);
        break;
      case 'terminate':
        await this.handleTerminate(seq);
        break;
      default:
        this.sendErrorResponse(seq, command, `Unknown command: ${command}`);
    }
  }

  /**
   * Handle initialize request
   */
  private async handleInitialize(seq: number): Promise<void> {
    // Respond with capabilities
    this.sendResponse(seq, 'initialize', {
      supportsConfigurationDoneRequest: true,
      supportsConditionalBreakpoints: true,
      supportsHitConditionalBreakpoints: true,
      supportsLogPoints: true,
      supportsStepInTargetsRequest: false,
      supportsStepBack: false,
      supportsSingleThreadExecutionRequests: false,
      supportsTerminateRequest: true,
      supportsFunctionBreakpoints: false,
      supportsDataBreakpoints: false,
      supportsRestartRequest: false,
      supportsSetVariable: false,
      supportsEvaluateForHovers: false,
    });

    // Send initialized event
    this.sendEvent('initialized');
  }

  /**
   * Handle launch request
   */
  private async handleLaunch(seq: number, args: LaunchRequestArguments): Promise<void> {
    const logger = getLogger();

    try {
      // Parse workflow file
      const uri = vscode.Uri.file(args.workflow);
      this.currentWorkflowUri = uri;

      const workflow = await this.parseWorkflow(uri);

      // Build location map for breakpoints
      this.buildLocationMap(workflow);

      // Configure debug session
      const config: DebugSessionConfig = {
        workflow,
        uri,
        options: {
          mode: args.dryRun ? 'dry-run' : 'normal',
          env: args.env,
          cwd: args.cwd,
        },
        stopOnEntry: args.stopOnEntry,
        cwd: args.cwd,
      };

      // Set up session event listener
      const session = getDebugSession();
      this.sessionEventListener = session.addEventListener((event) => {
        this.handleSessionEvent(event);
      });

      // Start the session
      await session.start(config);

      logger.info(`Debug session launched: ${workflow.name}`);
      this.sendResponse(seq, 'launch', {});

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Launch failed', { error: message });
      this.sendErrorResponse(seq, 'launch', message);
    }
  }

  /**
   * Handle setBreakpoints request
   */
  private async handleSetBreakpoints(
    seq: number,
    args: {
      source: { path: string };
      breakpoints?: Array<{
        line: number;
        condition?: string;
        hitCondition?: string;
        logMessage?: string;
      }>;
    }
  ): Promise<void> {
    const logger = getLogger();
    const breakpointManager = getBreakpointManager();

    if (!args.source.path) {
      this.sendResponse(seq, 'setBreakpoints', { breakpoints: [] });
      return;
    }

    const uri = vscode.Uri.file(args.source.path);
    const requestedBreakpoints = args.breakpoints ?? [];

    // Create location resolver
    const locationResolver = (line: number): BreakpointLocation | undefined => {
      return this.locationMap.get(line);
    };

    // Set breakpoints
    const setBreakpoints = breakpointManager.setBreakpointsForUri(
      uri,
      requestedBreakpoints,
      locationResolver
    );

    // Convert to DAP breakpoints
    const dapBreakpoints: DAPBreakpoint[] = requestedBreakpoints.map((reqBp, index) => {
      const bp = setBreakpoints[index];
      if (bp) {
        return {
          id: bp.id,
          verified: bp.verified,
          source: { path: uri.fsPath },
          line: bp.location.line,
        };
      } else {
        return {
          verified: false,
          message: 'Could not resolve breakpoint location',
          line: reqBp.line,
        };
      }
    });

    logger.debug(`Set ${dapBreakpoints.length} breakpoints`, { path: args.source.path });
    this.sendResponse(seq, 'setBreakpoints', { breakpoints: dapBreakpoints });
  }

  /**
   * Handle setExceptionBreakpoints request
   */
  private async handleSetExceptionBreakpoints(seq: number): Promise<void> {
    // We don't support exception breakpoints for workflows
    this.sendResponse(seq, 'setExceptionBreakpoints', {});
  }

  /**
   * Handle configurationDone request
   */
  private async handleConfigurationDone(seq: number): Promise<void> {
    this.sendResponse(seq, 'configurationDone', {});
  }

  /**
   * Handle threads request
   */
  private async handleThreads(seq: number): Promise<void> {
    // Workflows are single-threaded
    const threads: DAPThread[] = [{ id: 1, name: 'Workflow Thread' }];
    this.sendResponse(seq, 'threads', { threads });
  }

  /**
   * Handle stackTrace request
   */
  private async handleStackTrace(
    seq: number,
    args: { threadId: number; startFrame?: number; levels?: number }
  ): Promise<void> {
    const session = getDebugSession();
    const stackFrames = session.getStackTrace();

    const dapFrames: DAPStackFrame[] = stackFrames.map(frame => ({
      id: frame.id,
      name: frame.name,
      source: frame.source ? { name: path.basename(frame.source), path: frame.source } : undefined,
      line: frame.line ?? 1,
      column: frame.column ?? 1,
    }));

    // Apply start and levels
    const start = args.startFrame ?? 0;
    const levels = args.levels ?? dapFrames.length;
    const result = dapFrames.slice(start, start + levels);

    this.sendResponse(seq, 'stackTrace', {
      stackFrames: result,
      totalFrames: dapFrames.length,
    });
  }

  /**
   * Handle scopes request.
   * Returns three scopes per the variable scope model (data-model.md):
   * - Inputs: Current step's `with` parameters after interpolation + env
   * - Outputs: Current step's output and previous step outputs
   * - Workflow: Global workflow-level variables and environment
   */
  private async handleScopes(seq: number, _args: { frameId: number }): Promise<void> {
    const dapScopes: DAPScope[] = [
      { name: 'Inputs', variablesReference: 1, expensive: false },
      { name: 'Outputs', variablesReference: 2, expensive: false },
      { name: 'Workflow', variablesReference: 3, expensive: false },
    ];

    this.sendResponse(seq, 'scopes', { scopes: dapScopes });
  }

  /**
   * Handle variables request.
   * Populates variables from real executor state:
   * - Ref 1 (Inputs): Step `with` parameters after interpolation + step env
   * - Ref 2 (Outputs): Step outputs from ExecutionContext.stepOutputs
   * - Ref 3 (Workflow): Global workflow variables and environment
   */
  private async handleVariables(
    seq: number,
    args: { variablesReference: number }
  ): Promise<void> {
    const session = getDebugSession();
    const executor = WorkflowExecutor.getInstance();
    const executionContext = executor.getExecutionContext();

    let dapVariables: DAPVariable[] = [];

    switch (args.variablesReference) {
      case 1: {
        // Inputs scope: current step's `with` parameters + env
        const position = session.getPosition();
        if (position && !position.atPhaseStart) {
          const context = session.getContext();
          // Get step `with` parameters from the debug context
          const phase = session.getStackTrace();
          // Use session context for input variables
          if (context?.env) {
            dapVariables = Object.entries(context.env).map(([name, value]) =>
              this.toDAPVariable(name, value)
            );
          }
          // Also add inputs from executor context
          if (executionContext) {
            const inputs = executionContext.getInputs();
            for (const [name, value] of Object.entries(inputs)) {
              dapVariables.push(this.toDAPVariable(name, value));
            }
          }
        }
        break;
      }

      case 2: {
        // Outputs scope: step outputs from ExecutionContext
        if (executionContext) {
          const allOutputs = executionContext.getAllStepOutputs();
          for (const [stepId, output] of allOutputs) {
            dapVariables.push(this.toDAPVariable(stepId, {
              raw: output.raw,
              parsed: output.parsed,
              exitCode: output.exitCode,
            }));
          }
        } else {
          // Fall back to session context
          const vars = session.getVariables('outputs');
          dapVariables = Object.entries(vars).map(([name, value]) =>
            this.toDAPVariable(name, value)
          );
        }
        break;
      }

      case 3: {
        // Workflow scope: global environment and variables
        const context = session.getContext();
        if (context) {
          // Environment variables
          for (const [name, value] of Object.entries(context.env)) {
            dapVariables.push(this.toDAPVariable(`env.${name}`, value));
          }
          // Workflow-level variables
          for (const [name, value] of Object.entries(context.variables)) {
            dapVariables.push(this.toDAPVariable(name, value));
          }
        }
        // Add execution metadata
        const position = session.getPosition();
        if (position) {
          dapVariables.push(this.toDAPVariable('_phase', position.phaseName));
          dapVariables.push(this.toDAPVariable('_step', position.stepName ?? '(none)'));
          dapVariables.push(this.toDAPVariable('_status', session.getState()));
        }
        break;
      }

      default:
        this.sendResponse(seq, 'variables', { variables: [] });
        return;
    }

    this.sendResponse(seq, 'variables', { variables: dapVariables });
  }

  /**
   * Convert a value to a DAP Variable object with proper type detection
   */
  private toDAPVariable(name: string, value: unknown): DAPVariable {
    if (value === null || value === undefined) {
      return { name, value: String(value), type: 'null', variablesReference: 0 };
    }
    if (typeof value === 'string') {
      return { name, value, type: 'string', variablesReference: 0 };
    }
    if (typeof value === 'number') {
      return { name, value: String(value), type: 'number', variablesReference: 0 };
    }
    if (typeof value === 'boolean') {
      return { name, value: String(value), type: 'boolean', variablesReference: 0 };
    }
    // Object or array — display as JSON
    return {
      name,
      value: JSON.stringify(value),
      type: Array.isArray(value) ? 'array' : 'object',
      variablesReference: 0,
    };
  }

  /**
   * Handle continue request
   */
  private async handleContinue(seq: number): Promise<void> {
    const session = getDebugSession();
    await session.continue();
    this.sendResponse(seq, 'continue', { allThreadsContinued: true });
  }

  /**
   * Handle next (step over) request
   */
  private async handleNext(seq: number): Promise<void> {
    const session = getDebugSession();
    await session.stepOver();
    this.sendResponse(seq, 'next', {});
  }

  /**
   * Handle stepIn request
   */
  private async handleStepIn(seq: number): Promise<void> {
    const session = getDebugSession();
    await session.stepIn();
    this.sendResponse(seq, 'stepIn', {});
  }

  /**
   * Handle stepOut request
   */
  private async handleStepOut(seq: number): Promise<void> {
    const session = getDebugSession();
    await session.stepOut();
    this.sendResponse(seq, 'stepOut', {});
  }

  /**
   * Handle pause request
   */
  private async handlePause(seq: number): Promise<void> {
    const session = getDebugSession();
    await session.pause();
    this.sendResponse(seq, 'pause', {});
  }

  /**
   * Handle disconnect request
   */
  private async handleDisconnect(seq: number): Promise<void> {
    const session = getDebugSession();
    session.terminate();
    this.sendResponse(seq, 'disconnect', {});
  }

  /**
   * Handle terminate request
   */
  private async handleTerminate(seq: number): Promise<void> {
    const session = getDebugSession();
    session.terminate();
    this.sendResponse(seq, 'terminate', {});
  }

  /**
   * Handle debug session events
   */
  private handleSessionEvent(event: DebugSessionEvent): void {
    switch (event.type) {
      case 'started':
        // No specific event needed
        break;
      case 'stopped':
        this.sendEvent('stopped', {
          reason: event.reason ?? 'breakpoint',
          threadId: 1,
          allThreadsStopped: true,
        });
        break;
      case 'continued':
        this.sendEvent('continued', { threadId: 1, allThreadsContinued: true });
        break;
      case 'exited':
        this.sendEvent('exited', { exitCode: event.exitCode ?? 0 });
        this.sendEvent('terminated');
        break;
      case 'terminated':
        this.sendEvent('terminated');
        break;
      case 'output':
        if (event.output) {
          this.sendEvent('output', {
            category: 'stdout',
            output: event.output + '\n',
          });
        }
        break;
      case 'breakpoint':
        // Breakpoint events are handled via stopped event
        break;
    }
  }

  /**
   * Parse a workflow file
   */
  private async parseWorkflow(uri: vscode.Uri): Promise<ExecutableWorkflow> {
    const content = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder().decode(content);

    const parsed = yaml.parse(text);

    if (!parsed || typeof parsed !== 'object') {
      throw new GeneracyError(
        ErrorCode.WorkflowValidationError,
        'Invalid workflow file'
      );
    }

    const workflow: ExecutableWorkflow = {
      name: parsed.name || path.basename(uri.fsPath, path.extname(uri.fsPath)),
      description: parsed.description,
      phases: [],
      env: parsed.env || {},
      timeout: parsed.timeout,
    };

    if (Array.isArray(parsed.phases)) {
      for (const phase of parsed.phases) {
        if (!phase || typeof phase !== 'object') continue;

        const phaseData = {
          name: phase.name || 'unnamed',
          condition: phase.condition,
          steps: [] as ExecutableWorkflow['phases'][0]['steps'],
        };

        if (Array.isArray(phase.steps)) {
          for (const step of phase.steps) {
            if (!step || typeof step !== 'object') continue;

            phaseData.steps.push({
              name: step.name || 'unnamed',
              action: step.action || 'shell',
              command: step.command,
              script: step.script,
              timeout: step.timeout,
              continueOnError: step.continueOnError || step['continue-on-error'] || false,
              condition: step.condition,
              env: step.env || {},
            });
          }
        }

        workflow.phases.push(phaseData);
      }
    }

    return workflow;
  }

  /**
   * Build a map of line numbers to breakpoint locations
   */
  private buildLocationMap(workflow: ExecutableWorkflow): void {
    this.locationMap.clear();

    // For each phase and step, we'd ideally have their source line numbers
    // This is a simplified implementation that uses estimated line numbers
    let currentLine = 1;

    for (let phaseIndex = 0; phaseIndex < workflow.phases.length; phaseIndex++) {
      const phase = workflow.phases[phaseIndex];
      if (!phase) continue;

      // Phase starts at current line
      const phaseLocation: BreakpointLocation = {
        type: 'phase',
        phaseName: phase.name,
        line: currentLine,
      };
      this.locationMap.set(currentLine, phaseLocation);
      currentLine += 2; // name: X, steps:

      for (let stepIndex = 0; stepIndex < phase.steps.length; stepIndex++) {
        const step = phase.steps[stepIndex];
        if (!step) continue;

        const stepLocation: BreakpointLocation = {
          type: 'step',
          phaseName: phase.name,
          stepName: step.name,
          line: currentLine,
        };
        this.locationMap.set(currentLine, stepLocation);
        currentLine += 3; // - name: X, action: X, command: X
      }

      currentLine++; // gap between phases
    }
  }

  /**
   * Send a DAP response
   */
  private sendResponse(seq: number, command: string, body: unknown): void {
    if (this.disposed) return;

    const response: vscode.DebugProtocolMessage = {
      type: 'response',
      request_seq: seq,
      success: true,
      command,
      body,
      seq: this.sequenceNumber++,
    } as vscode.DebugProtocolMessage;

    this.sendMessage.fire(response);
  }

  /**
   * Send a DAP error response
   */
  private sendErrorResponse(seq: number, command: string, message: string): void {
    if (this.disposed) return;

    const response: vscode.DebugProtocolMessage = {
      type: 'response',
      request_seq: seq,
      success: false,
      command,
      message,
      seq: this.sequenceNumber++,
    } as vscode.DebugProtocolMessage;

    this.sendMessage.fire(response);
  }

  /**
   * Send a DAP event
   */
  private sendEvent(event: string, body?: unknown): void {
    if (this.disposed) return;

    const message: vscode.DebugProtocolMessage = {
      type: 'event',
      event,
      body,
      seq: this.sequenceNumber++,
    } as vscode.DebugProtocolMessage;

    this.sendMessage.fire(message);
  }

  /**
   * Dispose the adapter
   */
  dispose(): void {
    this.disposed = true;
    this.sessionEventListener?.dispose();
    this.sendMessage.dispose();
    this.locationMap.clear();
  }
}

/**
 * Register the debug adapter factory
 */
export function registerDebugAdapter(context: vscode.ExtensionContext): vscode.Disposable[] {
  const logger = getLogger();
  const disposables: vscode.Disposable[] = [];

  // Register debug adapter factory
  const factory = new WorkflowDebugAdapterFactory();
  disposables.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, factory)
  );
  disposables.push(factory);

  // Register debug configuration provider
  const configProvider = new WorkflowDebugConfigurationProvider();
  disposables.push(
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, configProvider)
  );

  logger.info('Debug adapter registered');

  return disposables;
}
