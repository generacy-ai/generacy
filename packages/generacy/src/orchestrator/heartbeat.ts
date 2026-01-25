/**
 * Heartbeat manager.
 * Handles periodic heartbeat to orchestrator.
 */
import type { OrchestratorClient } from './client.js';
import type { Heartbeat, HeartbeatResponse } from './types.js';

/**
 * Heartbeat manager options
 */
export interface HeartbeatManagerOptions {
  /** Orchestrator client */
  client: OrchestratorClient;

  /** Worker ID */
  workerId: string;

  /** Heartbeat interval in milliseconds */
  interval?: number;

  /** Callback for commands received */
  onCommand?: (command: HeartbeatResponse['commands'][number]) => void;

  /** Callback for heartbeat errors */
  onError?: (error: Error) => void;
}

/**
 * Worker status for heartbeat
 */
export type WorkerStatus = 'idle' | 'busy' | 'stopping';

/**
 * Manages periodic heartbeat to orchestrator
 */
export class HeartbeatManager {
  private readonly client: OrchestratorClient;
  private readonly workerId: string;
  private readonly interval: number;
  private readonly onCommand?: (command: HeartbeatResponse['commands'][number]) => void;
  private readonly onError?: (error: Error) => void;

  private timer: NodeJS.Timeout | null = null;
  private status: WorkerStatus = 'idle';
  private currentJob?: string;
  private progress?: number;
  private startTime = Date.now();
  private lastHeartbeat?: Date;

  constructor(options: HeartbeatManagerOptions) {
    this.client = options.client;
    this.workerId = options.workerId;
    this.interval = options.interval ?? 30000;
    this.onCommand = options.onCommand;
    this.onError = options.onError;
  }

  /**
   * Start the heartbeat loop
   */
  start(): void {
    if (this.timer) {
      return; // Already running
    }

    // Send initial heartbeat
    this.sendHeartbeat();

    // Start periodic heartbeats
    this.timer = setInterval(() => {
      this.sendHeartbeat();
    }, this.interval);
  }

  /**
   * Stop the heartbeat loop
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Update worker status
   */
  setStatus(status: WorkerStatus): void {
    this.status = status;
  }

  /**
   * Set current job information
   */
  setCurrentJob(jobId: string | undefined, progress?: number): void {
    this.currentJob = jobId;
    this.progress = progress;
  }

  /**
   * Get last successful heartbeat time
   */
  getLastHeartbeat(): Date | undefined {
    return this.lastHeartbeat;
  }

  /**
   * Get uptime in milliseconds
   */
  getUptime(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Send a heartbeat to the orchestrator
   */
  private async sendHeartbeat(): Promise<void> {
    try {
      const heartbeat: Heartbeat = {
        workerId: this.workerId,
        status: this.status,
        currentJob: this.currentJob,
        progress: this.progress,
        metrics: this.collectMetrics(),
        timestamp: new Date().toISOString(),
      };

      const response = await this.client.heartbeat(heartbeat);
      this.lastHeartbeat = new Date();

      // Process any commands from orchestrator
      if (response.commands && response.commands.length > 0) {
        for (const command of response.commands) {
          this.onCommand?.(command);
        }
      }
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Collect system metrics
   */
  private collectMetrics(): Heartbeat['metrics'] {
    // Get memory usage
    const memUsage = process.memoryUsage();
    const totalMem = require('os').totalmem?.() ?? 0;
    const memoryUsage = totalMem > 0 ? (memUsage.rss / totalMem) * 100 : 0;

    return {
      memoryUsage: Math.round(memoryUsage * 100) / 100,
      uptime: this.getUptime(),
    };
  }
}
