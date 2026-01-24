/**
 * Debug Adapter Protocol message handlers.
 * Handles DAP messages: initialize, launch, disconnect, etc.
 */
import type { DebugProtocol } from '@vscode/debugprotocol';
import { getDebugExecutionState } from './state';
import { WorkflowDebugRuntime, getDebugRuntime } from './runtime';

/**
 * DAP request handler type
 */
export type DAPRequestHandler<TArgs = unknown> = (args: TArgs) => Promise<unknown>;

/**
 * Launch request arguments
 */
export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  workflow: string;
  dryRun?: boolean;
  stopOnEntry?: boolean;
  pauseOnError?: boolean;
  env?: Record<string, string>;
}

/**
 * Client capabilities from initialization
 */
export interface ClientCapabilities {
  supportsVariableType: boolean;
  supportsVariablePaging: boolean;
  supportsRunInTerminalRequest: boolean;
  supportsProgressReporting: boolean;
}

/**
 * Protocol handler class for DAP messages
 */
export class ProtocolHandler {
  private runtime: WorkflowDebugRuntime;
  private sendEvent: (event: DebugProtocol.Event) => void;
  private isInitialized = false;
  private clientCapabilities: ClientCapabilities = {
    supportsVariableType: false,
    supportsVariablePaging: false,
    supportsRunInTerminalRequest: false,
    supportsProgressReporting: false,
  };

  constructor(sendEvent: (event: DebugProtocol.Event) => void) {
    this.runtime = getDebugRuntime();
    this.sendEvent = sendEvent;

    // Set up runtime event listeners
    this.runtime.addEventListener(event => {
      this.handleRuntimeEvent(event);
    });
  }

  /**
   * Get client capabilities (for use by other components)
   */
  public getClientCapabilities(): ClientCapabilities {
    return { ...this.clientCapabilities };
  }

  /**
   * Handle initialize request
   */
  public async handleInitialize(
    args: DebugProtocol.InitializeRequestArguments
  ): Promise<DebugProtocol.Capabilities> {
    // Store client capabilities for future use
    this.clientCapabilities = {
      supportsVariableType: args.supportsVariableType ?? false,
      supportsVariablePaging: args.supportsVariablePaging ?? false,
      supportsRunInTerminalRequest: args.supportsRunInTerminalRequest ?? false,
      supportsProgressReporting: args.supportsProgressReporting ?? false,
    };

    this.isInitialized = true;

    // Return debug adapter capabilities
    return {
      supportsConfigurationDoneRequest: true,
      supportsFunctionBreakpoints: false,
      supportsConditionalBreakpoints: false,
      supportsHitConditionalBreakpoints: false,
      supportsEvaluateForHovers: true,
      exceptionBreakpointFilters: [],
      supportsStepBack: false,
      supportsSetVariable: false,
      supportsRestartFrame: false,
      supportsGotoTargetsRequest: false,
      supportsStepInTargetsRequest: false,
      supportsCompletionsRequest: false,
      completionTriggerCharacters: [],
      supportsModulesRequest: false,
      additionalModuleColumns: [],
      supportedChecksumAlgorithms: [],
      supportsRestartRequest: true,
      supportsExceptionOptions: false,
      supportsValueFormattingOptions: false,
      supportsExceptionInfoRequest: true,
      supportTerminateDebuggee: true,
      supportSuspendDebuggee: false,
      supportsDelayedStackTraceLoading: false,
      supportsLoadedSourcesRequest: false,
      supportsLogPoints: false,
      supportsTerminateThreadsRequest: false,
      supportsSetExpression: false,
      supportsTerminateRequest: true,
      supportsDataBreakpoints: false,
      supportsReadMemoryRequest: false,
      supportsWriteMemoryRequest: false,
      supportsDisassembleRequest: false,
      supportsCancelRequest: false,
      supportsBreakpointLocationsRequest: false,
      supportsClipboardContext: false,
      supportsSteppingGranularity: false,
      supportsInstructionBreakpoints: false,
      supportsExceptionFilterOptions: false,
      supportsSingleThreadExecutionRequests: false,
    };
  }

  /**
   * Handle configurationDone request
   */
  public async handleConfigurationDone(): Promise<void> {
    // Configuration is complete, execution can begin
  }

  /**
   * Handle launch request
   */
  public async handleLaunch(args: LaunchRequestArguments): Promise<void> {
    const { workflow, stopOnEntry, pauseOnError, env } = args;
    // Note: dryRun is available via args.dryRun for future implementation

    if (!workflow) {
      throw new Error('Workflow path is required');
    }

    // Load the workflow
    await this.runtime.loadWorkflow(workflow);

    // Set environment variables
    if (env) {
      this.runtime.setEnvironment(env);
    }

    // Set pause on error option
    if (pauseOnError !== undefined) {
      this.runtime.setPauseOnError(pauseOnError);
    }

    // Start execution
    await this.runtime.start(stopOnEntry ?? true);
  }

  /**
   * Handle skip step request (custom command for skipping failed steps)
   */
  public async handleSkipStep(): Promise<void> {
    this.runtime.skipStep();
  }

  /**
   * Handle disconnect request
   */
  public async handleDisconnect(
    _args: DebugProtocol.DisconnectArguments
  ): Promise<void> {
    this.runtime.stop();
    this.runtime.dispose();
  }

  /**
   * Handle terminate request
   */
  public async handleTerminate(
    _args: DebugProtocol.TerminateArguments
  ): Promise<void> {
    this.runtime.stop();
  }

  /**
   * Handle restart request
   */
  public async handleRestart(
    args: DebugProtocol.RestartArguments
  ): Promise<void> {
    // Stop current execution
    this.runtime.stop();

    // Re-launch with same arguments
    const launchArgs = args.arguments as LaunchRequestArguments | undefined;
    if (launchArgs) {
      await this.handleLaunch(launchArgs);
    }
  }

  /**
   * Handle setBreakpoints request
   */
  public async handleSetBreakpoints(
    args: DebugProtocol.SetBreakpointsArguments
  ): Promise<DebugProtocol.SetBreakpointsResponse['body']> {
    const lines = args.breakpoints?.map(bp => bp.line) ?? [];
    const breakpoints = this.runtime.setBreakpoints(lines);

    return {
      breakpoints: breakpoints.map((bp: { id: number; verified: boolean; line: number; source: string }) => ({
        id: bp.id,
        verified: bp.verified,
        line: bp.line,
        source: {
          path: bp.source,
        },
      })),
    };
  }

  /**
   * Handle threads request
   */
  public async handleThreads(): Promise<DebugProtocol.ThreadsResponse['body']> {
    // Workflow execution is single-threaded
    return {
      threads: [
        {
          id: 1,
          name: 'Workflow Execution',
        },
      ],
    };
  }

  /**
   * Handle stackTrace request
   */
  public async handleStackTrace(
    _args: DebugProtocol.StackTraceArguments
  ): Promise<DebugProtocol.StackTraceResponse['body']> {
    const frames = this.runtime.getStackFrames();

    return {
      stackFrames: frames.map(frame => ({
        id: frame.id,
        name: frame.name,
        source: {
          path: frame.source,
          name: frame.source.split('/').pop(),
        },
        line: frame.line,
        column: frame.column,
      })),
      totalFrames: frames.length,
    };
  }

  /**
   * Handle scopes request
   */
  public async handleScopes(
    args: DebugProtocol.ScopesArguments
  ): Promise<DebugProtocol.ScopesResponse['body']> {
    const state = getDebugExecutionState();
    const scopes = state.getScopes(args.frameId);

    return {
      scopes: scopes.map(scope => ({
        name: scope.name,
        presentationHint: scope.presentationHint,
        variablesReference: scope.variablesReference,
        namedVariables: scope.namedVariables,
        indexedVariables: scope.indexedVariables,
        expensive: scope.expensive,
      })),
    };
  }

  /**
   * Handle variables request
   */
  public async handleVariables(
    args: DebugProtocol.VariablesArguments
  ): Promise<DebugProtocol.VariablesResponse['body']> {
    const state = getDebugExecutionState();
    const variables = state.getVariables(args.variablesReference);

    return {
      variables: variables.map(v => ({
        name: v.name,
        value: v.value,
        type: v.type,
        variablesReference: v.variablesReference,
        namedVariables: v.namedVariables,
        indexedVariables: v.indexedVariables,
        evaluateName: v.evaluateName,
      })),
    };
  }

  /**
   * Handle continue request
   */
  public async handleContinue(
    _args: DebugProtocol.ContinueArguments
  ): Promise<DebugProtocol.ContinueResponse['body']> {
    this.runtime.continue();
    return {
      allThreadsContinued: true,
    };
  }

  /**
   * Handle next (step over) request
   */
  public async handleNext(
    _args: DebugProtocol.NextArguments
  ): Promise<void> {
    this.runtime.stepNext();
  }

  /**
   * Handle stepIn request
   */
  public async handleStepIn(
    _args: DebugProtocol.StepInArguments
  ): Promise<void> {
    this.runtime.stepIn();
  }

  /**
   * Handle stepOut request
   */
  public async handleStepOut(
    _args: DebugProtocol.StepOutArguments
  ): Promise<void> {
    this.runtime.stepOut();
  }

  /**
   * Handle pause request
   */
  public async handlePause(
    _args: DebugProtocol.PauseArguments
  ): Promise<void> {
    this.runtime.pause();
  }

  /**
   * Handle evaluate request
   */
  public async handleEvaluate(
    args: DebugProtocol.EvaluateArguments
  ): Promise<DebugProtocol.EvaluateResponse['body']> {
    const result = this.runtime.evaluate(args.expression, args.frameId);

    return {
      result: result.result,
      variablesReference: result.variablesReference,
    };
  }

  /**
   * Handle exception info request
   */
  public async handleExceptionInfo(
    _args: DebugProtocol.ExceptionInfoArguments
  ): Promise<DebugProtocol.ExceptionInfoResponse['body']> {
    const pendingError = this.runtime.getPendingError();

    if (!pendingError) {
      return {
        exceptionId: 'none',
        description: 'No exception',
        breakMode: 'never',
      };
    }

    return {
      exceptionId: `${pendingError.phaseName}/${pendingError.stepName}`,
      description: pendingError.error,
      breakMode: 'always',
      details: {
        message: pendingError.error,
        typeName: 'WorkflowStepError',
        stackTrace: `Phase: ${pendingError.phaseName}\nStep: ${pendingError.stepName}`,
      },
    };
  }

  /**
   * Handle runtime events and convert to DAP events
   */
  private handleRuntimeEvent(event: {
    type: string;
    reason?: string;
    phaseName?: string;
    stepName?: string;
    line?: number;
    output?: string;
    success?: boolean;
  }): void {
    switch (event.type) {
      case 'started':
        // Send initialized event after capabilities exchange
        if (this.isInitialized) {
          this.sendEvent({
            seq: 0,
            type: 'event',
            event: 'initialized',
          });
        }
        break;

      case 'stopped':
        this.sendEvent({
          seq: 0,
          type: 'event',
          event: 'stopped',
          body: {
            reason: event.reason ?? 'pause',
            threadId: 1,
            allThreadsStopped: true,
          },
        } as DebugProtocol.StoppedEvent);
        break;

      case 'continued':
        this.sendEvent({
          seq: 0,
          type: 'event',
          event: 'continued',
          body: {
            threadId: 1,
            allThreadsContinued: true,
          },
        } as DebugProtocol.ContinuedEvent);
        break;

      case 'output':
        if (event.output) {
          this.sendEvent({
            seq: 0,
            type: 'event',
            event: 'output',
            body: {
              category: 'stdout',
              output: event.output + '\n',
            },
          } as DebugProtocol.OutputEvent);
        }
        break;

      case 'ended':
        this.sendEvent({
          seq: 0,
          type: 'event',
          event: 'terminated',
        } as DebugProtocol.TerminatedEvent);
        break;
    }
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.runtime.dispose();
  }
}
