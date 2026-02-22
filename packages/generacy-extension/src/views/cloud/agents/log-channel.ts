/**
 * Agent Log Channel - Output channel for viewing and streaming agent logs.
 *
 * Creates a VS Code output channel per agent that displays historical logs
 * fetched via REST and streams live log lines via SSE subscription.
 * Reuses existing channels for the same agent to avoid duplicates.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils/logger';
import { agentsApi } from '../../../api/endpoints/agents';
import { SSESubscriptionManager } from '../../../api/sse';
import type { Agent, SSEEvent } from '../../../api/types';

/**
 * Manages a VS Code OutputChannel for a specific agent, combining
 * historical log fetching with live SSE-based log streaming.
 */
export class AgentLogChannel implements vscode.Disposable {
  /** Active channels by agent ID — reuse existing channel for same agent */
  private static activeChannels: Map<string, AgentLogChannel> = new Map();

  private readonly outputChannel: vscode.OutputChannel;
  private readonly agentId: string;
  private readonly agentName: string;
  private sseDisposable: vscode.Disposable | undefined;
  private disposed = false;

  private constructor(agent: Agent) {
    this.agentId = agent.id;
    this.agentName = agent.name;
    this.outputChannel = vscode.window.createOutputChannel(`Agent: ${agent.name}`);
  }

  /**
   * Open (or reuse) an agent log channel, fetch historical logs,
   * subscribe to SSE for live streaming, and show the output channel.
   */
  async open(): Promise<void> {
    const logger = getLogger();

    this.outputChannel.clear();
    this.outputChannel.appendLine(`--- Logs for ${this.agentName} (${this.agentId}) ---`);
    this.outputChannel.appendLine('');

    // Fetch historical logs
    try {
      const response = await agentsApi.getAgentLogs(this.agentId, { limit: 200 });

      if (response.lines.length === 0) {
        this.outputChannel.appendLine('No historical log entries found.');
      } else {
        for (const logLine of response.lines) {
          const prefix = logLine.timestamp
            ? `[${new Date(logLine.timestamp).toLocaleTimeString()}] `
            : '';
          this.outputChannel.appendLine(`${prefix}${logLine.line}`);
        }
        this.outputChannel.appendLine('');
        this.outputChannel.appendLine(
          `--- ${response.lines.length} of ${response.total} historical lines ---`
        );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to fetch logs for agent ${this.agentId}`, error);
      this.outputChannel.appendLine(`Failed to load historical logs: ${errorMessage}`);
    }

    this.outputChannel.appendLine('');
    this.outputChannel.appendLine('--- Live log stream active ---');
    this.outputChannel.appendLine('');

    // Subscribe to SSE for live log lines
    this.subscribeToSSE();

    // Show the output channel
    this.outputChannel.show(true);
  }

  /**
   * Subscribe to SSE agents channel, filtering events for this agent.
   * Appends log data from matching events to the output channel.
   */
  private subscribeToSSE(): void {
    // Clean up previous subscription if any
    this.sseDisposable?.dispose();

    const sseManager = SSESubscriptionManager.getInstance();

    this.sseDisposable = sseManager.subscribe('agents', (event: SSEEvent) => {
      if (this.disposed) {
        return;
      }

      const eventData = event.data as Record<string, unknown> | undefined;
      if (!eventData) {
        return;
      }

      // Only process events for this agent
      if (eventData.agentId !== this.agentId) {
        return;
      }

      // Handle events that carry log data
      if (event.event === 'agent:log' && typeof eventData.line === 'string') {
        const timestamp = typeof eventData.timestamp === 'string'
          ? `[${new Date(eventData.timestamp).toLocaleTimeString()}] `
          : '';
        this.outputChannel.appendLine(`${timestamp}${eventData.line}`);
      } else if (
        event.event === 'agent:status' &&
        eventData.log &&
        typeof eventData.log === 'string'
      ) {
        // Some status events may carry a log line in metadata
        this.outputChannel.appendLine(eventData.log);
      }
    });
  }

  /**
   * Dispose of the output channel and SSE subscription.
   * Removes this channel from the active channels map.
   */
  dispose(): void {
    this.disposed = true;
    this.sseDisposable?.dispose();
    this.sseDisposable = undefined;
    this.outputChannel.dispose();
    AgentLogChannel.activeChannels.delete(this.agentId);
  }

  /**
   * Open agent logs in an output channel with historical + live streaming.
   * Reuses an existing channel for the same agent if one is already open.
   */
  static async openAgentLogs(agent: Agent): Promise<void> {
    const logger = getLogger();
    logger.info(`Opening log channel for agent: ${agent.id} (${agent.name})`);

    // Reuse existing channel for this agent
    let channel = AgentLogChannel.activeChannels.get(agent.id);
    if (channel) {
      // Re-open: refresh logs and show
      await channel.open();
      return;
    }

    // Create new channel
    channel = new AgentLogChannel(agent);
    AgentLogChannel.activeChannels.set(agent.id, channel);

    await channel.open();
  }

  /**
   * Dispose all active agent log channels.
   * Useful for extension deactivation cleanup.
   */
  static disposeAll(): void {
    for (const channel of AgentLogChannel.activeChannels.values()) {
      channel.dispose();
    }
    AgentLogChannel.activeChannels.clear();
  }
}
