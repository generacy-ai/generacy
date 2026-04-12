/**
 * Subprocess agency mode.
 * Launches Agency MCP as a child process and communicates via stdio.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from '@generacy-ai/workflow-engine';
import type { AgentLauncher } from '@generacy-ai/orchestrator';
import type { AgencyConnection, ToolCallRequest, ToolCallResponse } from './index.js';

/**
 * Subprocess agency options
 */
export interface SubprocessAgencyOptions {
  /** Command to launch agency */
  command: string;

  /** Command arguments */
  args?: string[];

  /** Logger instance */
  logger: Logger;

  /** Connection timeout in milliseconds */
  timeout?: number;

  /** Working directory */
  cwd?: string;

  /** Environment variables */
  env?: Record<string, string>;
}

/**
 * MCP message types
 */
interface MCPMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Internal handle covering both ChildProcess and ChildProcessHandle.
 */
interface ProcessHandle {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * Agency connection via subprocess
 */
export class SubprocessAgency implements AgencyConnection {
  private readonly command: string;
  private readonly args: string[];
  private readonly logger: Logger;
  private readonly timeout: number;
  private readonly cwd?: string;
  private readonly env?: Record<string, string>;
  private readonly agentLauncher?: AgentLauncher;

  private process: ProcessHandle | null = null;
  private connected = false;
  private messageId = 0;
  private pendingRequests = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private buffer = '';

  constructor(options: SubprocessAgencyOptions, agentLauncher?: AgentLauncher) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.logger = options.logger;
    this.timeout = options.timeout ?? 30000;
    this.cwd = options.cwd;
    this.env = options.env;
    this.agentLauncher = agentLauncher;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    this.logger.info(`Starting agency subprocess: ${this.command}`);

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Agency connection timeout'));
        this.disconnect();
      }, this.timeout);

      if (this.agentLauncher) {
        // Launcher path
        const handle = this.agentLauncher.launch({
          intent: {
            kind: 'generic-subprocess',
            command: this.command,
            args: this.args,
            stdioProfile: 'interactive',
          },
          cwd: this.cwd ?? process.cwd(),
          env: this.env,
        });

        this.process = handle.process;

        handle.process.exitPromise.then((code) => {
          this.connected = false;
          this.logger.info(`Agency process exited with code ${code}`);
        }, (error) => {
          clearTimeout(timeoutId);
          this.logger.error(`Agency process error: ${error instanceof Error ? error.message : String(error)}`);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      } else {
        // Direct-spawn fallback path
        const child: ChildProcess = spawn(this.command, this.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: this.cwd,
          env: { ...process.env, ...this.env },
        });

        this.process = child;

        child.on('error', (error) => {
          clearTimeout(timeoutId);
          this.logger.error(`Agency process error: ${error.message}`);
          reject(error);
        });

        child.on('exit', (code, signal) => {
          this.connected = false;
          this.logger.info(`Agency process exited with code ${code}, signal ${signal}`);
        });
      }

      this.process.stdout?.on('data', (data: Buffer) => {
        this.handleData(data.toString());
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        this.logger.warn(`Agency stderr: ${data.toString()}`);
      });

      // Send initialize message
      this.sendMessage({
        jsonrpc: '2.0',
        id: this.messageId++,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'generacy',
            version: '0.0.1',
          },
        },
      });

      // Wait for initialization response
      const initHandler = (result: unknown) => {
        clearTimeout(timeoutId);
        this.connected = true;
        this.logger.info('Agency connected');
        resolve();
      };

      this.pendingRequests.set(0, {
        resolve: initHandler,
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.process) {
      return;
    }

    this.logger.info('Disconnecting from agency');

    // Clear pending requests
    for (const [, { reject }] of this.pendingRequests) {
      reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();

    // Kill the process
    this.process.kill();
    this.process = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async listTools(): Promise<string[]> {
    if (!this.connected) {
      throw new Error('Not connected to agency');
    }

    const response = await this.request('tools/list', {}) as { tools?: Array<{ name: string }> };
    return response.tools?.map(t => t.name) ?? [];
  }

  async callTool(request: ToolCallRequest): Promise<ToolCallResponse> {
    if (!this.connected) {
      throw new Error('Not connected to agency');
    }

    try {
      const result = await this.request('tools/call', {
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
   * Send an MCP request and wait for response
   */
  private async request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.messageId++;
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, this.timeout);

      this.pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });

      this.sendMessage({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });
    });
  }

  /**
   * Send an MCP message
   */
  private sendMessage(message: MCPMessage): void {
    if (!this.process?.stdin) {
      throw new Error('Process not started');
    }

    const content = JSON.stringify(message);
    this.process.stdin.write(content + '\n');
    this.logger.debug(`Sent MCP message: ${message.method ?? 'response'}`);
  }

  /**
   * Handle incoming data
   */
  private handleData(data: string): void {
    this.buffer += data;

    // Process complete lines
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line) as MCPMessage;
        this.handleMessage(message);
      } catch (error) {
        this.logger.warn(`Failed to parse MCP message: ${line}`);
      }
    }
  }

  /**
   * Handle an MCP message
   */
  private handleMessage(message: MCPMessage): void {
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);

        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    } else if (message.method) {
      // Handle notifications
      this.logger.debug(`Received MCP notification: ${message.method}`);
    }
  }
}
