/**
 * Network agency mode.
 * Connects to Agency HTTP service.
 */
import type { Logger } from '@generacy-ai/workflow-engine';
import type { AgencyConnection, ToolCallRequest, ToolCallResponse } from './index.js';

/**
 * Network agency options
 */
export interface NetworkAgencyOptions {
  /** Agency service URL */
  url: string;

  /** Logger instance */
  logger: Logger;

  /** Request timeout in milliseconds */
  timeout?: number;

  /** Authentication token */
  authToken?: string;
}

/**
 * Agency connection via HTTP
 */
export class NetworkAgency implements AgencyConnection {
  private readonly url: string;
  private readonly logger: Logger;
  private readonly timeout: number;
  private readonly authToken?: string;
  private connected = false;
  private sessionId?: string;

  constructor(options: NetworkAgencyOptions) {
    this.url = options.url.replace(/\/$/, '');
    this.logger = options.logger;
    this.timeout = options.timeout ?? 30000;
    this.authToken = options.authToken ?? process.env['AGENCY_TOKEN'];
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    this.logger.info(`Connecting to agency at ${this.url}`);

    try {
      // Initialize session
      const response = await this.request('POST', '/mcp/initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'generacy',
          version: '0.0.1',
        },
      });

      this.sessionId = response.sessionId;
      this.connected = true;
      this.logger.info('Agency connected');
    } catch (error) {
      this.logger.error(`Failed to connect to agency: ${error}`);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    this.logger.info('Disconnecting from agency');

    if (this.sessionId) {
      try {
        await this.request('DELETE', `/mcp/sessions/${this.sessionId}`);
      } catch (error) {
        this.logger.warn(`Failed to close agency session: ${error}`);
      }
    }

    this.sessionId = undefined;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async listTools(): Promise<string[]> {
    if (!this.connected) {
      throw new Error('Not connected to agency');
    }

    const response = await this.request('GET', '/mcp/tools') as { tools?: Array<{ name: string }> };
    return response.tools?.map(t => t.name) ?? [];
  }

  async callTool(request: ToolCallRequest): Promise<ToolCallResponse> {
    if (!this.connected) {
      throw new Error('Not connected to agency');
    }

    try {
      const result = await this.request('POST', '/mcp/tools/call', {
        name: request.name,
        arguments: request.arguments,
      });

      return {
        success: true,
        result,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Make an HTTP request to the agency service
   */
  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<Record<string, unknown>> {
    const url = `${this.url}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.authToken) {
        headers['Authorization'] = `Bearer ${this.authToken}`;
      }

      if (this.sessionId) {
        headers['X-Session-ID'] = this.sessionId;
      }

      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorMessage = response.statusText;
        try {
          const errorData = await response.json() as { error?: string; message?: string };
          errorMessage = errorData.error ?? errorData.message ?? errorMessage;
        } catch {
          // Ignore parse errors
        }
        throw new Error(`Agency request failed: ${response.status} ${errorMessage}`);
      }

      const text = await response.text();
      if (!text) {
        return {};
      }

      return JSON.parse(text);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
