import { randomUUID } from 'node:crypto';
import type { ZodIssue } from 'zod';
import type {
  GateQueryRequestMessage,
  GateQueryResponseMessage,
} from '@generacy-ai/cluster-relay';
import { GateQueryResponseMessageSchema } from '@generacy-ai/cluster-relay';
import { GateTypeSchema } from '@generacy-ai/cockpit';

/**
 * Minimal structural type for the relay client — covers just the seams we use.
 * Both the local orchestrator interface and the package's `ClusterRelay` class
 * satisfy this shape.
 */
export interface RelayClientForQuery {
  readonly isConnected: boolean;
  send(message: unknown): void;
}

/** Any inbound relay frame; we only care about `type` being 'gate_query_response'. */
export type InboundRelayMessage = { type: string } & Record<string, unknown>;

interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface QuerySingleInput {
  issueRef: string;
  gateType: string;
  generation: string;
}

export interface QuerySingleResult {
  gateId: string;
  status: 'open' | 'answered' | 'absent';
}

export interface QueryListInput {
  issueRef: string;
  gateTypeFilter?: string;
}

export interface QueryListResult {
  gates: Array<{ gateId: string; gateType: string; status: 'open' | 'answered' }>;
}

export class QueryUnreachableError extends Error {
  public readonly attempts: number;
  public readonly lastReason: string;

  constructor(args: { attempts: number; lastReason: string; message?: string }) {
    super(
      args.message ?? `Cloud gate-status query unreachable (${args.lastReason})`,
    );
    this.name = 'QueryUnreachableError';
    this.attempts = args.attempts;
    this.lastReason = args.lastReason;
  }
}

export class MalformedCloudResponseError extends Error {
  public readonly issues: ZodIssue[] | { path: string; message: string }[];

  constructor(args: {
    issues: ZodIssue[] | { path: string; message: string }[];
    message?: string;
  }) {
    super(args.message ?? 'Cloud response failed validation');
    this.name = 'MalformedCloudResponseError';
    this.issues = args.issues;
  }
}

interface PendingEntry {
  mode: 'single' | 'list';
  resolve: (value: QuerySingleResult | QueryListResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface GateStatusQueryDeps {
  getRelayClient: () => RelayClientForQuery | null;
  logger: Logger;
  generateCorrelationId?: () => string;
  perAttemptTimeoutMs?: number;
}

const DEFAULT_PER_ATTEMPT_TIMEOUT_MS = 5000;

export class GateStatusQueryService {
  private readonly getRelayClient: () => RelayClientForQuery | null;
  private readonly logger: Logger;
  private readonly generateCorrelationId: () => string;
  private readonly perAttemptTimeoutMs: number;
  private readonly pending = new Map<string, PendingEntry>();

  constructor(deps: GateStatusQueryDeps) {
    this.getRelayClient = deps.getRelayClient;
    this.logger = deps.logger;
    this.generateCorrelationId = deps.generateCorrelationId ?? randomUUID;
    this.perAttemptTimeoutMs = deps.perAttemptTimeoutMs ?? DEFAULT_PER_ATTEMPT_TIMEOUT_MS;
  }

  async querySingle(input: QuerySingleInput): Promise<QuerySingleResult> {
    // Validate gateType early — turns wire garbage into an immediate reject
    // rather than an ambiguous unreachable timeout.
    const gateType = GateTypeSchema.safeParse(input.gateType);
    if (!gateType.success) {
      throw new MalformedCloudResponseError({
        issues: [{ path: 'gateType', message: 'unknown gateType' }],
        message: `unknown gateType: ${input.gateType}`,
      });
    }
    const envelope: GateQueryRequestMessage = {
      type: 'gate_query_request',
      correlationId: this.generateCorrelationId(),
      issueRef: input.issueRef,
      mode: 'single',
      gateType: gateType.data,
      generation: input.generation,
    };
    const result = (await this.dispatch(envelope, 'single')) as QuerySingleResult;
    return result;
  }

  async queryList(input: QueryListInput): Promise<QueryListResult> {
    let gateTypeFilter: GateQueryRequestMessage['gateTypeFilter'];
    if (input.gateTypeFilter !== undefined) {
      const parsed = GateTypeSchema.safeParse(input.gateTypeFilter);
      if (!parsed.success) {
        throw new MalformedCloudResponseError({
          issues: [{ path: 'gateTypeFilter', message: 'unknown gateType' }],
          message: `unknown gateType filter: ${input.gateTypeFilter}`,
        });
      }
      gateTypeFilter = parsed.data;
    }
    const envelope: GateQueryRequestMessage = {
      type: 'gate_query_request',
      correlationId: this.generateCorrelationId(),
      issueRef: input.issueRef,
      mode: 'list',
      ...(gateTypeFilter !== undefined ? { gateTypeFilter } : {}),
    };
    const result = (await this.dispatch(envelope, 'list')) as QueryListResult;
    return result;
  }

  /**
   * Called by the relay bridge's inbound-message dispatcher whenever a
   * `gate_query_response` arrives. Routes to the matching pending promise by
   * correlationId; drops silently if the correlation is unknown (stale
   * response or already-timed-out).
   */
  onRelayMessage(msg: InboundRelayMessage): void {
    if (msg.type !== 'gate_query_response') return;
    const correlationId = msg['correlationId'] as string | undefined;
    if (typeof correlationId !== 'string') return;
    const entry = this.pending.get(correlationId);
    if (!entry) {
      this.logger.debug(
        { correlationId },
        'dropped gate_query_response with unknown correlationId',
      );
      return;
    }
    this.pending.delete(correlationId);
    clearTimeout(entry.timer);

    // Validate the on-wire shape one more time (the outer parse already ran,
    // but we want to be defensive against direct-call test scenarios).
    const parsed = GateQueryResponseMessageSchema.safeParse(msg);
    if (!parsed.success) {
      entry.reject(new MalformedCloudResponseError({ issues: parsed.error.issues }));
      return;
    }
    const validated = parsed.data as unknown as GateQueryResponseMessage;

    if (validated.status === 'error') {
      const reason = validated.error ?? 'cloud responder returned status=error without reason';
      entry.reject(new QueryUnreachableError({ attempts: 1, lastReason: reason }));
      return;
    }

    if (!validated.payload) {
      entry.reject(
        new MalformedCloudResponseError({
          issues: [{ path: 'payload', message: "status='ok' requires payload" }],
        }),
      );
      return;
    }

    if (validated.payload.mode !== entry.mode) {
      entry.reject(
        new MalformedCloudResponseError({
          issues: [
            {
              path: 'payload.mode',
              message: `expected mode='${entry.mode}', received '${validated.payload.mode}'`,
            },
          ],
        }),
      );
      return;
    }

    if (validated.payload.mode === 'single') {
      entry.resolve({
        gateId: validated.payload.gateId,
        status: validated.payload.status,
      });
    } else {
      entry.resolve({
        gates: validated.payload.gates.map((g) => ({
          gateId: g.gateId,
          gateType: g.gateType,
          status: g.status,
        })),
      });
    }
  }

  private dispatch(
    envelope: GateQueryRequestMessage,
    mode: 'single' | 'list',
  ): Promise<QuerySingleResult | QueryListResult> {
    return new Promise((resolve, reject) => {
      const client = this.getRelayClient();
      if (!client || !client.isConnected) {
        reject(
          new QueryUnreachableError({
            attempts: 1,
            lastReason: 'relay client not connected at send time',
          }),
        );
        return;
      }
      const correlationId = envelope.correlationId;
      const timer = setTimeout(() => {
        if (!this.pending.has(correlationId)) return;
        this.pending.delete(correlationId);
        reject(
          new QueryUnreachableError({
            attempts: 1,
            lastReason: `correlation-id timeout after ${this.perAttemptTimeoutMs}ms`,
          }),
        );
      }, this.perAttemptTimeoutMs);
      // Prevent the timer from keeping a Node process alive if it's the only
      // pending handle. Not all runtimes support unref (e.g. some test doubles).
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
      this.pending.set(correlationId, { mode, resolve, reject, timer });
      try {
        client.send(envelope);
      } catch (err) {
        this.pending.delete(correlationId);
        clearTimeout(timer);
        reject(
          new QueryUnreachableError({
            attempts: 1,
            lastReason: err instanceof Error ? err.message : 'relay.send threw',
          }),
        );
      }
    });
  }
}
