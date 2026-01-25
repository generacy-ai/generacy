/**
 * Agency connection interface and factory.
 * Provides abstraction for connecting to Agency MCP.
 */
import type { Logger } from '@generacy-ai/workflow-engine';

/**
 * Agency connection mode
 */
export type AgencyMode = 'subprocess' | 'network';

/**
 * Tool call request
 */
export interface ToolCallRequest {
  /** Tool name */
  name: string;

  /** Tool arguments */
  arguments: Record<string, unknown>;
}

/**
 * Tool call response
 */
export interface ToolCallResponse {
  /** Whether the call succeeded */
  success: boolean;

  /** Result data if successful */
  result?: unknown;

  /** Error message if failed */
  error?: string;
}

/**
 * Agency connection interface
 */
export interface AgencyConnection {
  /** Connect to the agency */
  connect(): Promise<void>;

  /** Disconnect from the agency */
  disconnect(): Promise<void>;

  /** Check if connected */
  isConnected(): boolean;

  /** List available tools */
  listTools(): Promise<string[]>;

  /** Call a tool */
  callTool(request: ToolCallRequest): Promise<ToolCallResponse>;
}

/**
 * Agency connection options
 */
export interface AgencyConnectionOptions {
  /** Connection mode */
  mode: AgencyMode;

  /** Logger instance */
  logger: Logger;

  /** Agency URL for network mode */
  url?: string;

  /** Agency command for subprocess mode */
  command?: string;

  /** Connection timeout in milliseconds */
  timeout?: number;
}

/**
 * Create an agency connection based on mode
 */
export async function createAgencyConnection(
  options: AgencyConnectionOptions
): Promise<AgencyConnection> {
  if (options.mode === 'subprocess') {
    const { SubprocessAgency } = await import('./subprocess.js');
    return new SubprocessAgency({
      command: options.command ?? 'npx @anthropic-ai/agency',
      logger: options.logger,
      timeout: options.timeout,
    });
  } else {
    const { NetworkAgency } = await import('./network.js');
    if (!options.url) {
      throw new Error('Agency URL is required for network mode');
    }
    return new NetworkAgency({
      url: options.url,
      logger: options.logger,
      timeout: options.timeout,
    });
  }
}

// Re-export implementations
export { SubprocessAgency } from './subprocess.js';
export type { SubprocessAgencyOptions } from './subprocess.js';
export { NetworkAgency } from './network.js';
export type { NetworkAgencyOptions } from './network.js';
