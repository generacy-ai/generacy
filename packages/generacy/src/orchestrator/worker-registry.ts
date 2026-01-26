/**
 * Worker registry.
 * Tracks registered workers, handles heartbeats, and manages worker lifecycle.
 */
import { randomUUID } from 'crypto';
import type { WorkerRegistration, Heartbeat, HeartbeatResponse } from './types.js';

/**
 * Registered worker with runtime state
 */
export interface RegisteredWorker {
  /** Unique worker identifier */
  id: string;

  /** Worker name */
  name: string;

  /** Worker capabilities/tags */
  capabilities: string[];

  /** Maximum concurrent jobs */
  maxConcurrent: number;

  /** Currently assigned job IDs */
  currentJobs: string[];

  /** Worker health status */
  status: 'healthy' | 'unhealthy' | 'offline';

  /** Last heartbeat timestamp */
  lastHeartbeat: Date;

  /** Registration timestamp */
  registeredAt: Date;

  /** Health check endpoint URL */
  healthEndpoint?: string;

  /** Worker metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Worker registry options
 */
export interface WorkerRegistryOptions {
  /** Heartbeat timeout in milliseconds (default: 60000) */
  heartbeatTimeout?: number;

  /** Callback when worker goes offline */
  onWorkerOffline?: (workerId: string) => void;

  /** Callback when worker goes unhealthy */
  onWorkerUnhealthy?: (workerId: string) => void;
}

/**
 * Worker registry interface
 */
export interface IWorkerRegistry {
  register(registration: WorkerRegistration): Promise<string>;
  unregister(workerId: string): Promise<void>;
  heartbeat(workerId: string, data: Heartbeat): Promise<HeartbeatResponse>;
  getWorker(workerId: string): RegisteredWorker | undefined;
  getIdleWorkers(): RegisteredWorker[];
  checkTimeouts(): Promise<string[]>;
}

/**
 * Manages registered workers and their health state
 */
export class WorkerRegistry implements IWorkerRegistry {
  private readonly workers = new Map<string, RegisteredWorker>();
  private readonly heartbeatTimeout: number;
  private readonly onWorkerOffline?: (workerId: string) => void;
  private readonly onWorkerUnhealthy?: (workerId: string) => void;

  constructor(options: WorkerRegistryOptions = {}) {
    this.heartbeatTimeout = options.heartbeatTimeout ?? 60000;
    this.onWorkerOffline = options.onWorkerOffline;
    this.onWorkerUnhealthy = options.onWorkerUnhealthy;
  }

  /**
   * Register a new worker
   * @returns Worker ID
   */
  async register(registration: WorkerRegistration): Promise<string> {
    // Generate ID if not provided
    const workerId = registration.id || randomUUID();

    const worker: RegisteredWorker = {
      id: workerId,
      name: registration.name,
      capabilities: registration.capabilities || ['*'],
      maxConcurrent: registration.maxConcurrent || 1,
      currentJobs: [],
      status: 'healthy',
      lastHeartbeat: new Date(),
      registeredAt: new Date(),
      healthEndpoint: registration.healthEndpoint,
      metadata: registration.metadata,
    };

    this.workers.set(workerId, worker);
    return workerId;
  }

  /**
   * Unregister a worker
   */
  async unregister(workerId: string): Promise<void> {
    this.workers.delete(workerId);
  }

  /**
   * Process a heartbeat from a worker
   */
  async heartbeat(workerId: string, data: Heartbeat): Promise<HeartbeatResponse> {
    const worker = this.workers.get(workerId);

    if (!worker) {
      return {
        acknowledged: false,
      };
    }

    // Update worker state
    worker.lastHeartbeat = new Date();
    worker.status = 'healthy';

    // Update current job from heartbeat data
    if (data.currentJob) {
      if (!worker.currentJobs.includes(data.currentJob)) {
        worker.currentJobs.push(data.currentJob);
      }
    }

    // Clear current jobs if worker is idle
    if (data.status === 'idle') {
      worker.currentJobs = [];
    }

    return {
      acknowledged: true,
    };
  }

  /**
   * Get a worker by ID
   */
  getWorker(workerId: string): RegisteredWorker | undefined {
    return this.workers.get(workerId);
  }

  /**
   * Get all idle workers (healthy with capacity)
   */
  getIdleWorkers(): RegisteredWorker[] {
    const idleWorkers: RegisteredWorker[] = [];

    for (const worker of this.workers.values()) {
      if (worker.status === 'healthy' && worker.currentJobs.length < worker.maxConcurrent) {
        idleWorkers.push(worker);
      }
    }

    return idleWorkers;
  }

  /**
   * Check for timed out workers and update their status
   * @returns Array of worker IDs that went offline
   */
  async checkTimeouts(): Promise<string[]> {
    const now = Date.now();
    const offlineWorkerIds: string[] = [];

    for (const worker of this.workers.values()) {
      const timeSinceHeartbeat = now - worker.lastHeartbeat.getTime();

      if (timeSinceHeartbeat > this.heartbeatTimeout * 2) {
        // More than 2x timeout - worker is offline
        if (worker.status !== 'offline') {
          worker.status = 'offline';
          offlineWorkerIds.push(worker.id);
          this.onWorkerOffline?.(worker.id);
        }
      } else if (timeSinceHeartbeat > this.heartbeatTimeout) {
        // More than 1x timeout - worker is unhealthy
        if (worker.status === 'healthy') {
          worker.status = 'unhealthy';
          this.onWorkerUnhealthy?.(worker.id);
        }
      }
    }

    return offlineWorkerIds;
  }

  /**
   * Get all registered workers
   */
  getAllWorkers(): RegisteredWorker[] {
    return Array.from(this.workers.values());
  }

  /**
   * Get worker count by status
   */
  getWorkerCounts(): { healthy: number; unhealthy: number; offline: number; total: number } {
    let healthy = 0;
    let unhealthy = 0;
    let offline = 0;

    for (const worker of this.workers.values()) {
      switch (worker.status) {
        case 'healthy':
          healthy++;
          break;
        case 'unhealthy':
          unhealthy++;
          break;
        case 'offline':
          offline++;
          break;
      }
    }

    return {
      healthy,
      unhealthy,
      offline,
      total: this.workers.size,
    };
  }

  /**
   * Assign a job to a worker
   */
  assignJob(workerId: string, jobId: string): boolean {
    const worker = this.workers.get(workerId);
    if (!worker) {
      return false;
    }

    if (worker.currentJobs.length >= worker.maxConcurrent) {
      return false;
    }

    if (!worker.currentJobs.includes(jobId)) {
      worker.currentJobs.push(jobId);
    }

    return true;
  }

  /**
   * Remove a job from a worker
   */
  unassignJob(workerId: string, jobId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.currentJobs = worker.currentJobs.filter((id) => id !== jobId);
    }
  }

  /**
   * Find workers with specific capability
   */
  findWorkersWithCapability(capability: string): RegisteredWorker[] {
    const matchingWorkers: RegisteredWorker[] = [];

    for (const worker of this.workers.values()) {
      // Workers with '*' capability can handle any job
      if (worker.capabilities.includes('*') || worker.capabilities.includes(capability)) {
        matchingWorkers.push(worker);
      }
    }

    return matchingWorkers;
  }
}
