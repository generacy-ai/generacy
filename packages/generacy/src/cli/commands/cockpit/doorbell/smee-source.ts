/**
 * `SmeeDoorbellSource` — SSE consumer for the smee.io channel. Filters
 * payloads by the epic's ref set and emits `CockpitStreamEvent`s to a
 * caller-supplied sink. Models the reconnect ladder on
 * `packages/orchestrator/src/services/smee-receiver.ts`.
 *
 * Contract: `specs/978-summary-generacy-cockpit/contracts/smee-doorbell-source.md`.
 */
import {
  resolveEpic,
  type CommandRunner,
  type GhWrapper,
  type IssueRef,
  type ResolvedEpic,
} from '@generacy-ai/cockpit';
import { initialAggregateState, type AggregateState } from '../watch/aggregate.js';
import type { CockpitStreamEvent } from '../watch/stream-event.js';
import type { SnapshotMap } from '../watch/snapshot.js';
import { parseSseEventBlock, type NormalizedPayload } from './sse-parser.js';
import {
  webhookToStreamEvent,
  type RefSetView,
} from './webhook-to-event.js';
import {
  maybeRefreshAggregate,
  type AggregateTrigger,
} from './aggregate-on-demand.js';

export const DEFAULT_BASE_RECONNECT_DELAY_MS = 5_000;
export const MAX_BACKOFF_MS = 300_000;
export const DEFAULT_REFRESH_DEBOUNCE_MS = 500;
export const DEFAULT_SAFETY_NET_INTERVAL_MS = 600_000;
const AGGREGATE_TRIGGER_DEBOUNCE_MS = 500;

export interface SmeeDoorbellSourceOptions {
  channelUrl: string;
  epicRef: string;
  gh: GhWrapper;
  runner?: CommandRunner;
  logger: { warn: (msg: string) => void; info?: (msg: string) => void };
  onEvent: (event: CockpitStreamEvent) => Promise<void>;
  onReconnectAttempt: (failedAttempts: number) => void;
  onReconnectSuccess: () => void;
  onRefSetRefreshFailure?: (err: unknown) => void;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  refreshDebounceMs?: number;
  safetyNetIntervalMs?: number;
  baseReconnectDelayMs?: number;
}

function repoRefsToSets(allRefs: IssueRef[]): {
  issues: Set<string>;
  prs: Set<string>;
  repos: Set<string>;
} {
  const issues = new Set<string>();
  const prs = new Set<string>();
  const repos = new Set<string>();
  for (const ref of allRefs) {
    const key = `${ref.repo}#${ref.number}`;
    issues.add(key);
    prs.add(key);
    repos.add(ref.repo);
  }
  return { issues, prs, repos };
}

function buildRefSet(resolved: ResolvedEpic): RefSetView {
  const sets = repoRefsToSets(resolved.parsed.allRefs);
  sets.issues.add(`${resolved.epic.repo}#${resolved.epic.number}`);
  sets.repos.add(resolved.epic.repo);
  return {
    epicRef: `${resolved.epic.repo}#${resolved.epic.number}`,
    epicNumber: resolved.epic.number,
    epicRepo: resolved.epic.repo,
    issues: sets.issues,
    prs: sets.prs,
    watchedRepos: sets.repos,
  };
}

function deriveTrigger(payload: NormalizedPayload): AggregateTrigger {
  if (payload.githubEvent === 'issues' && payload.action === 'labeled') {
    const labelObj = payload.body['label'];
    if (labelObj != null && typeof labelObj === 'object') {
      const name = (labelObj as Record<string, unknown>)['name'];
      if (typeof name === 'string' && name.startsWith('completed:')) {
        return { kind: 'completed-label', label: name };
      }
    }
  }
  if (payload.githubEvent === 'issues' && payload.action === 'closed') {
    return { kind: 'issue-closed' };
  }
  if (payload.githubEvent === 'pull_request' && payload.action === 'closed') {
    return { kind: 'pr-closed' };
  }
  return null;
}

function isEpicPayload(payload: NormalizedPayload, epicNumber: number): boolean {
  if (payload.githubEvent !== 'issues') return false;
  if (
    payload.action !== 'edited' &&
    payload.action !== 'labeled' &&
    payload.action !== 'unlabeled'
  ) {
    return false;
  }
  const issueObj = payload.body['issue'];
  if (issueObj == null || typeof issueObj !== 'object') return false;
  const num = (issueObj as Record<string, unknown>)['number'];
  return num === epicNumber;
}

export class SmeeDoorbellSource {
  private readonly channelUrl: string;
  private readonly epicRef: string;
  private readonly gh: GhWrapper;
  private readonly logger: { warn: (msg: string) => void; info?: (msg: string) => void };
  private readonly onEvent: (event: CockpitStreamEvent) => Promise<void>;
  private readonly onReconnectAttempt: (failedAttempts: number) => void;
  private readonly onReconnectSuccess: () => void;
  private readonly onRefSetRefreshFailure?: (err: unknown) => void;
  private readonly now: () => number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly refreshDebounceMs: number;
  private readonly safetyNetIntervalMs: number;
  private readonly baseReconnectDelayMs: number;

  private refSet: RefSetView | null = null;
  private aggState: AggregateState = initialAggregateState();
  private prev: SnapshotMap = new Map();
  private currentResolved: ResolvedEpic | null = null;

  private reconnectAttempt = 0;
  private running = false;
  private abortController: AbortController | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private aggregateDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAggregateTrigger: AggregateTrigger = null;
  private runLoopPromise: Promise<void> | null = null;

  constructor(options: SmeeDoorbellSourceOptions) {
    this.channelUrl = options.channelUrl;
    this.epicRef = options.epicRef;
    this.gh = options.gh;
    this.logger = options.logger;
    this.onEvent = options.onEvent;
    this.onReconnectAttempt = options.onReconnectAttempt;
    this.onReconnectSuccess = options.onReconnectSuccess;
    if (options.onRefSetRefreshFailure != null) {
      this.onRefSetRefreshFailure = options.onRefSetRefreshFailure;
    }
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.refreshDebounceMs = options.refreshDebounceMs ?? DEFAULT_REFRESH_DEBOUNCE_MS;
    this.safetyNetIntervalMs =
      options.safetyNetIntervalMs ?? DEFAULT_SAFETY_NET_INTERVAL_MS;
    this.baseReconnectDelayMs =
      options.baseReconnectDelayMs ?? DEFAULT_BASE_RECONNECT_DELAY_MS;
  }

  async start(): Promise<void> {
    if (this.running) return;

    // Blocking startup ref-set refresh: propagate resolveEpic failures so the
    // caller (`runSmeeMode`) can demote to poll-fallback.
    const resolved = await resolveEpic({
      epicRef: this.epicRef,
      gh: this.gh,
      logger: this.logger,
    });
    this.currentResolved = resolved;
    this.refSet = buildRefSet(resolved);

    this.running = true;
    this.abortController = new AbortController();
    this.refreshTimer = setInterval(
      () => this.refreshRefSet(),
      this.safetyNetIntervalMs,
    );
    if (typeof this.refreshTimer.unref === 'function') this.refreshTimer.unref();

    this.runLoopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.abortController != null) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.refreshTimer != null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.refreshDebounceTimer != null) {
      clearTimeout(this.refreshDebounceTimer);
      this.refreshDebounceTimer = null;
    }
    if (this.aggregateDebounceTimer != null) {
      clearTimeout(this.aggregateDebounceTimer);
      this.aggregateDebounceTimer = null;
    }
    if (this.runLoopPromise != null) {
      try {
        await this.runLoopPromise;
      } catch {
        /* drain */
      }
      this.runLoopPromise = null;
    }
  }

  private calculateBackoffDelay(attempt: number): number {
    const delay = this.baseReconnectDelayMs * Math.pow(2, attempt);
    return Math.min(delay, MAX_BACKOFF_MS);
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === 'function') timer.unref();
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async runLoop(): Promise<void> {
    const signal = this.abortController?.signal;
    if (signal == null) return;

    while (this.running && !signal.aborted) {
      let sleepMs = this.calculateBackoffDelay(this.reconnectAttempt);
      try {
        await this.connect(signal);
        this.reconnectAttempt = 0;
        sleepMs = this.calculateBackoffDelay(this.reconnectAttempt);
      } catch (err) {
        if (signal.aborted) break;
        this.reconnectAttempt++;
        sleepMs = this.calculateBackoffDelay(this.reconnectAttempt);
        this.logger.warn(
          `cockpit doorbell: smee connection lost, reconnecting in ${sleepMs}ms (attempt ${this.reconnectAttempt}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        try {
          this.onReconnectAttempt(this.reconnectAttempt);
        } catch {
          /* callback failures don't stop the loop */
        }
      }

      if (this.running && !signal.aborted) {
        await this.sleep(sleepMs, signal);
      }
    }
  }

  private async connect(signal: AbortSignal): Promise<void> {
    const response = await this.fetchImpl(this.channelUrl, {
      headers: { Accept: 'text/event-stream' },
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `smee connection failed: ${response.status} ${response.statusText}`,
      );
    }
    if (response.body == null) {
      throw new Error('smee response has no body');
    }

    try {
      this.onReconnectSuccess();
    } catch {
      /* callback failures don't stop the loop */
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const block of events) {
          if (!block.trim()) continue;
          await this.processEventBlock(block);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async processEventBlock(block: string): Promise<void> {
    const payload = parseSseEventBlock(block);
    if (payload == null) return;
    if (this.refSet == null) return;

    if (isEpicPayload(payload, this.refSet.epicNumber)) {
      this.scheduleRefSetRefresh();
    }

    const result = webhookToStreamEvent(
      payload.githubEvent,
      payload.action,
      payload.body,
      this.refSet,
      () => new Date(this.now()).toISOString(),
    );
    if (result != null) {
      const events = Array.isArray(result) ? result : [result];
      for (const ev of events) {
        try {
          await this.onEvent(ev);
        } catch (err) {
          this.logger.warn(
            `cockpit doorbell: onEvent sink rejected: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    const trigger = deriveTrigger(payload);
    if (trigger != null) {
      this.scheduleAggregateRefresh(trigger);
    }
  }

  private scheduleRefSetRefresh(): void {
    if (this.refreshDebounceTimer != null) clearTimeout(this.refreshDebounceTimer);
    this.refreshDebounceTimer = setTimeout(() => {
      this.refreshDebounceTimer = null;
      void this.refreshRefSet();
    }, this.refreshDebounceMs);
    if (typeof this.refreshDebounceTimer.unref === 'function') {
      this.refreshDebounceTimer.unref();
    }
  }

  private async refreshRefSet(): Promise<void> {
    if (!this.running) return;
    try {
      const resolved = await resolveEpic({
        epicRef: this.epicRef,
        gh: this.gh,
        logger: this.logger,
      });
      this.currentResolved = resolved;
      this.refSet = buildRefSet(resolved);
    } catch (err) {
      this.logger.warn(
        `cockpit doorbell: ref-set refresh failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      if (this.onRefSetRefreshFailure != null) {
        try {
          this.onRefSetRefreshFailure(err);
        } catch {
          /* callback errors are swallowed */
        }
      }
    }
  }

  private scheduleAggregateRefresh(trigger: AggregateTrigger): void {
    this.pendingAggregateTrigger = trigger;
    if (this.aggregateDebounceTimer != null) {
      clearTimeout(this.aggregateDebounceTimer);
    }
    this.aggregateDebounceTimer = setTimeout(() => {
      this.aggregateDebounceTimer = null;
      const next = this.pendingAggregateTrigger;
      this.pendingAggregateTrigger = null;
      void this.runAggregateRefresh(next);
    }, AGGREGATE_TRIGGER_DEBOUNCE_MS);
    if (typeof this.aggregateDebounceTimer.unref === 'function') {
      this.aggregateDebounceTimer.unref();
    }
  }

  private async runAggregateRefresh(trigger: AggregateTrigger): Promise<void> {
    if (!this.running || this.refSet == null) return;
    const output = await maybeRefreshAggregate({
      trigger,
      epicRef: this.epicRef,
      epicRepo: this.refSet.epicRepo,
      epicNumber: this.refSet.epicNumber,
      prevAgg: this.aggState,
      prev: this.prev,
      currentResolved: this.currentResolved,
      gh: this.gh,
      logger: this.logger,
      now: () => new Date(this.now()).toISOString(),
    });
    this.aggState = output.nextAgg;
    this.prev = output.nextPrev;
    this.currentResolved = output.nextResolved;

    for (const ev of output.events) {
      try {
        await this.onEvent(ev);
      } catch (err) {
        this.logger.warn(
          `cockpit doorbell: aggregate onEvent sink rejected: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
