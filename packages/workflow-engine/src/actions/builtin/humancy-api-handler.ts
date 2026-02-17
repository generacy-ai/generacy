/**
 * HumancyApiDecisionHandler — concrete HumanDecisionHandler that bridges
 * the workflow engine's human review steps with the Humancy Cloud API's
 * decision endpoints.
 *
 * Creates decisions via POST /decisions, listens for resolution via SSE
 * (decision:resolved event), and maps responses back to the workflow
 * engine's ReviewDecisionResponse format.
 *
 * API: generacy.ai/api/humancy/decisions (architecture-overview-v3)
 */
import type { HumanDecisionHandler } from './humancy-review.js';
import type { HumancyUrgency } from '../../types/action.js';
import { CorrelationTimeoutError } from '../../errors/correlation-timeout.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for HumancyApiDecisionHandler.
 */
export interface HumancyApiHandlerConfig {
  /** Base URL for the Humancy API (e.g., http://localhost:3002/api/humancy) */
  apiUrl: string;
  /** Agent ID for decision attribution */
  agentId: string;
  /** Optional project ID for scoping decisions */
  projectId?: string;
  /** Optional auth token for API requests (JWT) */
  authToken?: string;
  /** Whether to fall back to simulation on API failure (default: true) */
  fallbackToSimulation?: boolean;
  /** SSE reconnection delay in ms (default: 1000) */
  sseReconnectDelay?: number;
  /** Maximum SSE reconnection attempts (default: 10) */
  maxReconnectAttempts?: number;
}

/**
 * Minimal logger interface matching the shape of context.logger.
 */
export interface HandlerLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

/** Default no-op logger used when none is provided. */
const noopLogger: HandlerLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

/**
 * Resolved config with defaults applied.
 */
interface ResolvedConfig {
  apiUrl: string;
  agentId: string;
  projectId?: string;
  authToken?: string;
  fallbackToSimulation: boolean;
  sseReconnectDelay: number;
  maxReconnectAttempts: number;
}

/**
 * Decision request payload — structurally compatible with the
 * non-exported ReviewDecisionRequest from humancy-review.ts.
 */
interface ReviewDecisionRequest {
  type: 'review';
  title: string;
  description: string;
  options: Array<{ id: string; label: string; requiresComment?: boolean }>;
  workflowId: string;
  stepId: string;
  urgency: HumancyUrgency;
  artifact?: string;
}

/**
 * Decision response — structurally compatible with the
 * non-exported ReviewDecisionResponse from humancy-review.ts.
 */
interface ReviewDecisionResponse {
  approved?: boolean;
  decision?: string;
  input?: string;
  respondedBy: string;
  respondedAt: string;
}

/**
 * Humancy Cloud API urgency levels (from @humancy-cloud/db urgencySchema).
 */
type HumancyCloudUrgency = 'blocking_now' | 'blocking_soon' | 'when_available';

/**
 * Humancy Cloud API decision response embedded in SSE events and GET responses.
 * Matches decisionResponseSchema from @humancy-cloud/db.
 */
interface HumancyDecisionResponse {
  selectedOptionId?: string;
  customResponse?: string;
  reasoning?: string;
  respondedAt: string;
}

/**
 * Payload sent to POST /decisions to create a decision.
 * Matches createDecisionInputSchema from @humancy-cloud/db.
 */
interface CreateDecisionPayload {
  agentId: string;
  projectId?: string;
  type: 'review';
  urgency: HumancyCloudUrgency;
  question: string;
  context?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  expiresAt?: string;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

/** Buffer added to the caller's timeout for the expiresAt field (5 minutes). */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * A parsed SSE event from the stream.
 */
export interface ParsedSSEEvent {
  /** Event type from the `event:` field (empty string if not set) */
  event: string;
  /** Joined data from `data:` lines (joined with newline for multi-line) */
  data: string;
  /** Event ID from the `id:` field (empty string if not set) */
  id: string;
}

/**
 * Maps workflow-engine urgency to Humancy Cloud API urgency.
 */
function mapUrgency(urgency: HumancyUrgency): HumancyCloudUrgency {
  switch (urgency) {
    case 'low':
    case 'normal':
      return 'when_available';
    case 'blocking_soon':
      return 'blocking_soon';
    case 'blocking_now':
      return 'blocking_now';
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Concrete HumanDecisionHandler that communicates with the Humancy
 * Cloud API's decision endpoints to request and await human decisions.
 */
export class HumancyApiDecisionHandler implements HumanDecisionHandler {
  private readonly config: ResolvedConfig;
  private readonly logger: HandlerLogger;

  constructor(config: HumancyApiHandlerConfig, logger?: HandlerLogger) {
    this.config = {
      apiUrl: config.apiUrl.replace(/\/+$/, ''), // strip trailing slashes
      agentId: config.agentId,
      projectId: config.projectId,
      authToken: config.authToken,
      fallbackToSimulation: config.fallbackToSimulation ?? true,
      sseReconnectDelay: config.sseReconnectDelay ?? 1000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
    };
    this.logger = logger ?? noopLogger;
  }

  /**
   * Maps a workflow-engine ReviewDecisionRequest to the Humancy Cloud API's
   * POST /decisions payload (CreateDecisionInput shape).
   *
   * Field mapping:
   *   title        → question
   *   description  → context (with workflow/step metadata)
   *   artifact     → appended to context
   *   options      → options (requiresComment → description hint)
   *   urgency      → urgency (low/normal → when_available)
   *   type         → type ('review')
   *   config.agentId → agentId
   *   config.projectId → projectId
   *   timeout+5min  → expiresAt
   */
  private mapRequestToPayload(
    request: ReviewDecisionRequest,
    timeout: number,
  ): CreateDecisionPayload {
    // Build context string from description, artifact, and workflow metadata
    const contextParts: string[] = [];
    if (request.description) {
      contextParts.push(request.description);
    }
    if (request.artifact) {
      contextParts.push(`\n---\nArtifact:\n${request.artifact}`);
    }
    // Include workflow/step IDs as metadata for traceability
    contextParts.push(`\n[workflow=${request.workflowId}, step=${request.stepId}]`);
    const context = contextParts.join('');

    const options = request.options.map((opt) => {
      const mapped: { id: string; label: string; description?: string } = {
        id: opt.id,
        label: opt.label,
      };
      if (opt.requiresComment) {
        mapped.description = 'Comment required';
      }
      return mapped;
    });

    const payload: CreateDecisionPayload = {
      agentId: this.config.agentId,
      type: 'review',
      urgency: mapUrgency(request.urgency),
      question: request.title,
      context,
      options: options.length > 0 ? options : undefined,
    };

    if (this.config.projectId) {
      payload.projectId = this.config.projectId;
    }

    return payload;
  }

  /**
   * Maps a Humancy Cloud API decision:resolved event response back to the
   * workflow engine's ReviewDecisionResponse format.
   *
   * Response mapping:
   *   selectedOptionId === first option → approved: true
   *   selectedOptionId !== first option → approved: false, decision: selectedOptionId
   *   customResponse   → input (free-text response)
   *   respondedAt      → respondedAt
   */
  private mapResolvedEvent(
    response: HumancyDecisionResponse,
    request: ReviewDecisionRequest,
  ): ReviewDecisionResponse {
    const result: ReviewDecisionResponse = {
      respondedBy: 'human',
      respondedAt: response.respondedAt,
    };

    if (response.customResponse) {
      result.input = response.customResponse;
    }

    const firstOptionId = request.options[0]?.id;

    if (response.selectedOptionId) {
      result.decision = response.selectedOptionId;
      result.approved = response.selectedOptionId === firstOptionId;
    } else if (response.customResponse) {
      // Free-text response without option selection — treat as custom input
      result.approved = false;
    } else {
      // No option selected and no custom response — treat as rejection
      result.approved = false;
    }

    return result;
  }

  /**
   * Async generator that parses SSE text protocol from a fetch Response body.
   *
   * Reads the streaming body via `getReader()`, splits on newlines, and
   * interprets SSE fields:
   *   - `event: <type>` — sets the event type
   *   - `data: <payload>` — appends to data buffer (multi-line joined with \n)
   *   - `id: <value>` — sets the event ID and updates lastEventId
   *   - `:<comment>` — ignored (used for heartbeats)
   *   - empty line — dispatches the accumulated event
   *
   * Tracks `lastEventId` on the instance for reconnection support.
   */
  private lastEventId = '';

  async *parseSSEStream(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<ParsedSSEEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();

    // Accumulator for partial lines split across chunks
    let buffer = '';

    // Current event fields being accumulated
    let eventType = '';
    let dataLines: string[] = [];
    let eventId = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();

        if (done) {
          // Stream ended — if there's a pending event with data, dispatch it
          if (dataLines.length > 0) {
            yield { event: eventType, data: dataLines.join('\n'), id: eventId };
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines (SSE uses \n, \r\n, or \r as line endings)
        const lines = buffer.split(/\r\n|\r|\n/);
        // The last element may be an incomplete line — keep it in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line === '') {
            // Empty line = dispatch event (only if we have data)
            if (dataLines.length > 0) {
              const parsed: ParsedSSEEvent = {
                event: eventType,
                data: dataLines.join('\n'),
                id: eventId,
              };

              // Update lastEventId for reconnection (per SSE spec:
              // only update when id field was present in the event)
              if (eventId) {
                this.lastEventId = eventId;
              }

              yield parsed;

              // Reset accumulators for next event
              eventType = '';
              dataLines = [];
              eventId = '';
            }
            continue;
          }

          if (line.startsWith(':')) {
            // Comment line (heartbeat) — ignore
            continue;
          }

          // Parse field name and value
          const colonIndex = line.indexOf(':');
          let field: string;
          let fieldValue: string;

          if (colonIndex === -1) {
            // Line with no colon — field name is the entire line, value is empty
            field = line;
            fieldValue = '';
          } else {
            field = line.slice(0, colonIndex);
            // Per SSE spec: if first char after colon is a space, strip it
            fieldValue = line[colonIndex + 1] === ' '
              ? line.slice(colonIndex + 2)
              : line.slice(colonIndex + 1);
          }

          switch (field) {
            case 'event':
              eventType = fieldValue;
              break;
            case 'data':
              dataLines.push(fieldValue);
              break;
            case 'id':
              // Per SSE spec: ignore id fields containing null (\0)
              if (!fieldValue.includes('\0')) {
                eventId = fieldValue;
              }
              break;
            case 'retry':
              // Retry field — not used by this parser (reconnection logic
              // is handled by connectSSE with fixed config delays)
              break;
            default:
              // Unknown field — ignore per SSE spec
              break;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Connects to the Humancy Cloud API's SSE endpoint and yields parsed events,
   * automatically reconnecting on stream errors or unexpected closes.
   *
   * Uses `GET {apiUrl}/decisions/events?token={authToken}` with:
   *   - Auth via `token` query parameter (Humancy SSE auth convention)
   *   - `Last-Event-ID` header on reconnection attempts
   *   - `Accept: text/event-stream` header
   *
   * The generator transparently reconnects up to `maxReconnectAttempts` times
   * with a delay of `sseReconnectDelay` ms between attempts. Each reconnection
   * sends the last received event ID so the server can replay missed events.
   *
   * Cancellation is supported via the provided `AbortSignal` — when aborted,
   * the current fetch is cancelled and the generator returns cleanly.
   */
  async *connectSSE(
    signal: AbortSignal,
  ): AsyncGenerator<ParsedSSEEvent> {
    let attempts = 0;

    while (attempts <= this.config.maxReconnectAttempts) {
      // Build SSE endpoint URL with token auth via query parameter
      const sseUrl = new URL(`${this.config.apiUrl}/decisions/events`);
      if (this.config.authToken) {
        sseUrl.searchParams.set('token', this.config.authToken);
      }
      const url = sseUrl.toString();

      // Build headers
      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
      };
      if (this.lastEventId) {
        headers['Last-Event-ID'] = this.lastEventId;
      }

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers,
          signal,
        });
      } catch (err: unknown) {
        // If the signal was aborted, exit cleanly (timeout or cancellation)
        if (signal.aborted) {
          return;
        }

        attempts++;
        if (attempts > this.config.maxReconnectAttempts) {
          this.logger.error(
            `SSE connection failed after ${this.config.maxReconnectAttempts} reconnection attempts: ${String(err)}`,
          );
          throw new Error(
            `SSE connection failed after ${this.config.maxReconnectAttempts} attempts: ${String(err)}`,
          );
        }

        this.logger.warn(
          `SSE connection error, reconnecting (attempt ${attempts}/${this.config.maxReconnectAttempts}): ${String(err)}`,
        );
        await this.delay(this.config.sseReconnectDelay, signal);
        if (signal.aborted) return;
        continue;
      }

      // Check for non-200 responses
      if (!response.ok) {
        attempts++;
        if (attempts > this.config.maxReconnectAttempts) {
          this.logger.error(
            `SSE endpoint returned ${response.status} after ${this.config.maxReconnectAttempts} reconnection attempts`,
          );
          throw new Error(
            `SSE connection failed: server returned ${response.status} ${response.statusText}`,
          );
        }

        this.logger.warn(
          `SSE endpoint returned ${response.status}, reconnecting (attempt ${attempts}/${this.config.maxReconnectAttempts})`,
        );
        await this.delay(this.config.sseReconnectDelay, signal);
        if (signal.aborted) return;
        continue;
      }

      if (!response.body) {
        throw new Error('SSE response has no body');
      }

      this.logger.debug(
        `SSE connected to ${this.config.apiUrl}/decisions/events${this.lastEventId ? ` (resuming from ${this.lastEventId})` : ''}`,
      );

      // Reset attempts on successful connection
      attempts = 0;

      // Parse and yield events from the stream
      try {
        for await (const event of this.parseSSEStream(response.body)) {
          yield event;
        }
      } catch (err: unknown) {
        // If the signal was aborted, exit cleanly
        if (signal.aborted) {
          return;
        }

        // Stream broke unexpectedly — attempt reconnection
        attempts++;
        if (attempts > this.config.maxReconnectAttempts) {
          this.logger.error(
            `SSE stream broke after ${this.config.maxReconnectAttempts} reconnection attempts: ${String(err)}`,
          );
          throw new Error(
            `SSE stream failed after ${this.config.maxReconnectAttempts} reconnection attempts: ${String(err)}`,
          );
        }

        this.logger.warn(
          `SSE stream error, reconnecting (attempt ${attempts}/${this.config.maxReconnectAttempts}): ${String(err)}`,
        );
        await this.delay(this.config.sseReconnectDelay, signal);
        if (signal.aborted) return;
        continue;
      }

      // Stream ended cleanly (server closed connection) — reconnect
      // This can happen if the server restarts or the connection times out
      attempts++;
      if (attempts > this.config.maxReconnectAttempts) {
        this.logger.error(
          `SSE stream closed by server after ${this.config.maxReconnectAttempts} reconnection attempts`,
        );
        throw new Error(
          `SSE connection lost: stream closed by server after ${this.config.maxReconnectAttempts} reconnection attempts`,
        );
      }

      this.logger.warn(
        `SSE stream closed by server, reconnecting (attempt ${attempts}/${this.config.maxReconnectAttempts})`,
      );
      await this.delay(this.config.sseReconnectDelay, signal);
      if (signal.aborted) return;
    }
  }

  /**
   * Delay helper that respects AbortSignal for cancellation.
   * Resolves after `ms` milliseconds, or immediately if the signal is aborted.
   */
  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  /**
   * Request a human decision via the Humancy Cloud API.
   *
   * Flow:
   *   1. Map ReviewDecisionRequest → CreateDecisionPayload
   *   2. POST /decisions to create the decision
   *   3. On POST failure → fall back to simulation if configured
   *   4. Connect to SSE stream and wait for decision:resolved matching the decision ID
   *   5. Extract response from the event data
   *   6. Map response → ReviewDecisionResponse
   *   7. Clean up timeout timer and SSE connection
   *
   * Throws CorrelationTimeoutError if the timeout elapses before a response.
   */
  async requestDecision(
    request: ReviewDecisionRequest,
    timeout: number,
  ): Promise<ReviewDecisionResponse> {
    // --- Step 1: Map request to Humancy Cloud API payload ---
    const payload = this.mapRequestToPayload(request, timeout);

    // --- Step 2: Set up abort controller for timeout management ---
    const controller = new AbortController();
    const { signal } = controller;

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let decisionId: string | undefined;

    try {
      // --- Step 3: POST /decisions to create the decision ---
      const createUrl = `${this.config.apiUrl}/decisions`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.config.authToken) {
        headers['Authorization'] = `Bearer ${this.config.authToken}`;
      }

      let createResponse: Response;
      try {
        createResponse = await fetch(createUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal,
        });
      } catch (err: unknown) {
        // Network error during POST — apply fallback logic
        return this.handlePostFailure(err, 'network');
      }

      if (!createResponse.ok) {
        // HTTP error — classify and apply fallback logic
        const status = createResponse.status;
        const body = await createResponse.text().catch(() => '');
        const errorMsg = `POST /decisions failed: ${status} ${createResponse.statusText}${body ? ` — ${body}` : ''}`;

        if (status >= 400 && status < 500) {
          // 4xx = client error / misconfiguration — always throw, never fall back
          throw new Error(errorMsg);
        }
        // 5xx = server error — apply fallback logic
        return this.handlePostFailure(new Error(errorMsg), 'server');
      }

      // Humancy Cloud API returns { id, status, createdAt, expiresAt, success, data }
      const createdItem = (await createResponse.json()) as { id: string };
      decisionId = createdItem.id;

      this.logger.info(
        `Decision created: ${decisionId} (workflow=${request.workflowId}, step=${request.stepId})`,
      );

      // --- Step 4: Set up timeout timer ---
      // The timer aborts the SSE connection and rejects with CorrelationTimeoutError
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutTimer = setTimeout(() => {
          this.logger.error(
            `Decision timed out: ${decisionId} after ${timeout}ms (workflow=${request.workflowId}, step=${request.stepId})`,
          );
          controller.abort();
          reject(
            new CorrelationTimeoutError(
              `Decision ${decisionId} timed out after ${timeout}ms`,
              decisionId,
            ),
          );
        }, timeout);
      });

      // --- Step 5: Connect to SSE and wait for matching event ---
      const resolutionPromise = this.waitForResolution(
        decisionId,
        request,
        signal,
      );

      // Race: resolution vs timeout
      const result = await Promise.race([resolutionPromise, timeoutPromise]);
      return result;
    } finally {
      // --- Step 7: Clean up ---
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      // Abort any in-flight SSE connection if still open
      if (!signal.aborted) {
        controller.abort();
      }
    }
  }

  /**
   * Connects to SSE and waits for a `decision:resolved` event whose
   * `data.id` matches the given decisionId. Returns the mapped response.
   *
   * Humancy Cloud API SSE event format:
   *   event: decision:resolved
   *   id: evt_<timestamp>_<random>
   *   data: { id, type, urgency, preview, projectId, status, response }
   */
  private async waitForResolution(
    decisionId: string,
    request: ReviewDecisionRequest,
    signal: AbortSignal,
  ): Promise<ReviewDecisionResponse> {
    for await (const event of this.connectSSE(signal)) {
      this.logger.debug(`SSE event received: ${event.event} (id=${event.id})`);

      if (event.event !== 'decision:resolved') {
        continue;
      }

      // Parse the event data to check if it matches our decision
      let eventData: {
        id?: string;
        response?: HumancyDecisionResponse;
      };
      try {
        eventData = JSON.parse(event.data);
      } catch {
        this.logger.warn(`Failed to parse SSE event data: ${event.data.slice(0, 200)}`);
        continue;
      }

      if (eventData.id !== decisionId) {
        continue;
      }

      // Matched! Extract the response from the event data
      if (!eventData.response) {
        this.logger.warn(
          `decision:resolved event for ${decisionId} has no response — treating as rejection`,
        );
        return {
          approved: false,
          respondedBy: 'human',
          respondedAt: new Date().toISOString(),
        };
      }

      const mapped = this.mapResolvedEvent(eventData.response, request);

      this.logger.info(
        `Decision resolved: ${decisionId} (${mapped.approved ? 'approved' : 'rejected'}${mapped.decision ? `, decision=${mapped.decision}` : ''})`,
      );

      return mapped;
    }

    // SSE stream exhausted without matching event (all reconnect attempts failed)
    throw new Error(
      `SSE stream ended without receiving resolution for decision ${decisionId}`,
    );
  }

  /**
   * Handles POST /decisions failures with optional simulation fallback.
   *
   * Fallback rules:
   *   - Network errors (connection refused, DNS, fetch errors) → fall back if configured
   *   - 5xx server errors → fall back if configured
   *   - 4xx client errors → always throw (misconfiguration, fail loudly)
   *   - fallbackToSimulation=false → always throw
   */
  private handlePostFailure(
    err: unknown,
    category: 'network' | 'server',
  ): ReviewDecisionResponse {
    if (!this.config.fallbackToSimulation) {
      throw err instanceof Error ? err : new Error(String(err));
    }

    this.logger.warn(
      `Humancy API unreachable (${category} error), falling back to simulation mode: ${String(err)}`,
    );

    return {
      approved: true,
      respondedBy: 'simulated',
      respondedAt: new Date().toISOString(),
    };
  }
}
