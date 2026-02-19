/**
 * Orchestrator REST client.
 * Handles communication with the orchestrator service.
 */
import type {
  Job,
  JobEvent,
  JobResult,
  JobEventType,
  EventFilters,
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
          const body = await response.json() as Record<string, unknown>;
          // Server wraps errors as { error: { code, message } }
          const inner = (body['error'] ?? body) as OrchestratorError;
          errorData = {
            code: inner.code ?? 'UNKNOWN_ERROR',
            message: inner.message ?? response.statusText,
            details: inner.details,
          };
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

  /**
   * Publish an event for a job
   */
  async publishEvent(
    jobId: string,
    event: { type: JobEventType; data: Record<string, unknown>; timestamp?: number },
  ): Promise<{ eventId: string }> {
    return this.request('POST', `/api/jobs/${jobId}/events`, event);
  }

  /**
   * Subscribe to SSE events for a specific job.
   * Returns an AsyncIterable that yields parsed JobEvent objects.
   * The stream can be cancelled via AbortSignal or by breaking out of the for-await loop.
   */
  async *subscribeEvents(
    jobId: string,
    options?: { lastEventId?: string; signal?: AbortSignal },
  ): AsyncGenerator<JobEvent, void, undefined> {
    const url = `${this.baseUrl}/api/jobs/${jobId}/events`;
    const headers: Record<string, string> = {
      ...this.customHeaders,
    };

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    if (options?.lastEventId) {
      headers['Last-Event-ID'] = options.lastEventId;
    }

    const response = await fetch(url, {
      headers,
      signal: options?.signal,
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
        errorData.details,
      );
    }

    yield* this.parseSSEStream(response, options?.signal);
  }

  /**
   * Subscribe to SSE events for all jobs, optionally filtered.
   * Returns an AsyncIterable that yields parsed JobEvent objects.
   * The stream can be cancelled via AbortSignal or by breaking out of the for-await loop.
   */
  async *subscribeAllEvents(
    options?: { filters?: EventFilters; lastEventId?: string; signal?: AbortSignal },
  ): AsyncGenerator<JobEvent, void, undefined> {
    // Build query string from filters
    const params = new URLSearchParams();
    if (options?.filters?.tags && options.filters.tags.length > 0) {
      params.set('tags', options.filters.tags.join(','));
    }
    if (options?.filters?.workflow) {
      params.set('workflow', options.filters.workflow);
    }
    if (options?.filters?.status && options.filters.status.length > 0) {
      params.set('status', options.filters.status.join(','));
    }

    const queryString = params.toString();
    const url = `${this.baseUrl}/api/events${queryString ? `?${queryString}` : ''}`;

    const headers: Record<string, string> = {
      ...this.customHeaders,
    };

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    if (options?.lastEventId) {
      headers['Last-Event-ID'] = options.lastEventId;
    }

    const response = await fetch(url, {
      headers,
      signal: options?.signal,
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
        errorData.details,
      );
    }

    yield* this.parseSSEStream(response, options?.signal);
  }

  /**
   * Parse an SSE response stream into JobEvent objects.
   * Handles `event:`, `id:`, `data:` fields and skips comment lines (heartbeats).
   */
  private async *parseSSEStream(
    response: Response,
    signal?: AbortSignal,
  ): AsyncGenerator<JobEvent, void, undefined> {
    const body = response.body;
    if (!body) return;

    const reader = body.getReader();
    const decoder = new TextDecoder();

    let buffer = '';
    let currentData = '';
    // event and id fields tracked for completeness but data carries the full JobEvent
    let _currentEvent = '';
    let _currentId = '';

    try {
      while (true) {
        if (signal?.aborted) break;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split('\n');
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line === '') {
            // Empty line = end of event block — dispatch if we have data
            if (currentData) {
              try {
                const event = JSON.parse(currentData) as JobEvent;
                yield event;
              } catch {
                // Malformed data, skip
              }
            }
            // Reset fields for next event
            currentData = '';
            _currentEvent = '';
            _currentId = '';
          } else if (line.startsWith(':')) {
            // Comment line (e.g. heartbeat `: ping`) — skip
          } else if (line.startsWith('data:')) {
            currentData = line.slice(5).trimStart();
          } else if (line.startsWith('event:')) {
            _currentEvent = line.slice(6).trimStart();
          } else if (line.startsWith('id:')) {
            _currentId = line.slice(3).trimStart();
          }
          // Other fields (retry:, etc.) are ignored
        }
      }
    } finally {
      reader.releaseLock();
    }
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
