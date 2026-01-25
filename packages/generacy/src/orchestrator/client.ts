/**
 * Orchestrator REST client.
 * Handles communication with the orchestrator service.
 */
import type {
  Job,
  JobResult,
  WorkerRegistration,
  Heartbeat,
  HeartbeatResponse,
  PollResponse,
  OrchestratorError,
} from './types.js';

/**
 * Client options
 */
export interface OrchestratorClientOptions {
  /** Base URL of the orchestrator service */
  baseUrl: string;

  /** Request timeout in milliseconds */
  timeout?: number;

  /** Authentication token */
  authToken?: string;

  /** Custom headers */
  headers?: Record<string, string>;
}

/**
 * REST client for orchestrator communication
 */
export class OrchestratorClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly authToken?: string;
  private readonly customHeaders: Record<string, string>;

  constructor(options: OrchestratorClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.timeout = options.timeout ?? 30000;
    this.authToken = options.authToken ?? process.env['ORCHESTRATOR_TOKEN'];
    this.customHeaders = options.headers ?? {};
  }

  /**
   * Make an HTTP request to the orchestrator
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...this.customHeaders,
      };

      if (this.authToken) {
        headers['Authorization'] = `Bearer ${this.authToken}`;
      }

      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorData: OrchestratorError;
        try {
          errorData = await response.json() as OrchestratorError;
        } catch {
          errorData = {
            code: 'UNKNOWN_ERROR',
            message: response.statusText,
          };
        }
        throw new OrchestratorClientError(
          errorData.message,
          errorData.code,
          response.status,
          errorData.details
        );
      }

      // Handle empty responses
      const text = await response.text();
      if (!text) {
        return {} as T;
      }

      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Register worker with orchestrator
   */
  async register(registration: WorkerRegistration): Promise<{ workerId: string }> {
    return this.request('POST', '/api/workers/register', registration);
  }

  /**
   * Unregister worker from orchestrator
   */
  async unregister(workerId: string): Promise<void> {
    await this.request('DELETE', `/api/workers/${workerId}`);
  }

  /**
   * Send heartbeat to orchestrator
   */
  async heartbeat(data: Heartbeat): Promise<HeartbeatResponse> {
    return this.request('POST', `/api/workers/${data.workerId}/heartbeat`, data);
  }

  /**
   * Poll for available jobs
   */
  async pollForJob(workerId: string, capabilities?: string[]): Promise<PollResponse> {
    const params = new URLSearchParams();
    params.set('workerId', workerId);
    if (capabilities && capabilities.length > 0) {
      params.set('capabilities', capabilities.join(','));
    }
    return this.request('GET', `/api/jobs/poll?${params.toString()}`);
  }

  /**
   * Update job status
   */
  async updateJobStatus(
    jobId: string,
    status: Job['status'],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.request('PUT', `/api/jobs/${jobId}/status`, { status, ...metadata });
  }

  /**
   * Report job result
   */
  async reportJobResult(result: JobResult): Promise<void> {
    await this.request('POST', `/api/jobs/${result.jobId}/result`, result);
  }

  /**
   * Get job details
   */
  async getJob(jobId: string): Promise<Job> {
    return this.request('GET', `/api/jobs/${jobId}`);
  }

  /**
   * Cancel a job
   */
  async cancelJob(jobId: string, reason?: string): Promise<void> {
    await this.request('POST', `/api/jobs/${jobId}/cancel`, { reason });
  }
}

/**
 * Error class for orchestrator client errors
 */
export class OrchestratorClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'OrchestratorClientError';
  }
}
