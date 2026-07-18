/**
 * `SourceSelector` — owns the runtime demotion/re-promotion state for the
 * doorbell's wake source (Q3=D policy). Emits exactly one FR-006 `source=…`
 * stderr line per transition.
 *
 * Contract: `specs/978-summary-generacy-cockpit/contracts/source-selector.md`.
 */

export type SourceMode = 'smee-attempt' | 'smee-active' | 'poll-fallback';

export type SourceReason =
  | 'startup-no-channel'
  | 'startup-smee-selected'
  | 'startup-smee-failed'
  | 'smee-runtime-lost'
  | 'smee-re-promoted';

export interface SourceSelectorOptions {
  initial: 'smee-attempt' | 'poll-fallback';
  stderr: { write(chunk: string): boolean | void };
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
  demoteAfterConsecutiveFailures?: number;
  demoteAfterMsWithoutSuccess?: number;
  rePromoteIntervalMs?: number;
  now?: () => number;
}

export type ModeChangeCallback = (next: SourceMode, reason: SourceReason) => void;

export const DEFAULT_DEMOTE_AFTER_FAILURES = 5;
export const DEFAULT_DEMOTE_AFTER_MS_WITHOUT_SUCCESS = 90_000;
export const DEFAULT_RE_PROMOTE_INTERVAL_MS = 300_000;
const ELAPSED_TICKER_INTERVAL_MS = 1_000;

function formatLine(next: SourceMode, reason: SourceReason): string {
  const label = next === 'poll-fallback' ? 'poll-fallback' : 'smee';
  return `cockpit doorbell: source=${label} reason=${reason}\n`;
}

export class SourceSelector {
  private _current: SourceMode;
  private consecutiveReconnectFailures = 0;
  private lastSuccessfulConnectAt: number | null = null;
  private demotedAt: number | null = null;
  private rePromoteTimer: ReturnType<typeof setInterval> | null = null;
  private elapsedTicker: ReturnType<typeof setInterval> | null = null;
  private modeChangeCbs: ModeChangeCallback[] = [];
  private stopped = false;

  private readonly initialWasSmee: boolean;
  private readonly demoteAfterFailures: number;
  private readonly demoteAfterMsWithoutSuccess: number;
  private readonly rePromoteIntervalMs: number;
  private readonly now: () => number;
  private readonly stderr: { write(chunk: string): boolean | void };
  private readonly logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
  private pendingRePromoteEmit = false;

  constructor(options: SourceSelectorOptions) {
    this.initialWasSmee = options.initial === 'smee-attempt';
    this.demoteAfterFailures =
      options.demoteAfterConsecutiveFailures ?? DEFAULT_DEMOTE_AFTER_FAILURES;
    this.demoteAfterMsWithoutSuccess =
      options.demoteAfterMsWithoutSuccess ?? DEFAULT_DEMOTE_AFTER_MS_WITHOUT_SUCCESS;
    this.rePromoteIntervalMs =
      options.rePromoteIntervalMs ?? DEFAULT_RE_PROMOTE_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    this.stderr = options.stderr;
    if (options.logger != null) this.logger = options.logger;

    this._current = options.initial;
    const startupReason: SourceReason =
      options.initial === 'smee-attempt' ? 'startup-smee-selected' : 'startup-no-channel';
    this.writeLine(this._current, startupReason);

    if (this.initialWasSmee) {
      this.elapsedTicker = setInterval(() => this.observeElapsed(), ELAPSED_TICKER_INTERVAL_MS);
      if (typeof this.elapsedTicker.unref === 'function') this.elapsedTicker.unref();
    }
  }

  get currentSource(): SourceMode {
    return this._current;
  }

  onModeChange(cb: ModeChangeCallback): void {
    this.modeChangeCbs.push(cb);
  }

  onReconnectAttempt(failedAttempts: number): void {
    if (this.stopped) return;
    this.consecutiveReconnectFailures = failedAttempts;
    if (this._current !== 'smee-active' && this._current !== 'smee-attempt') return;
    if (failedAttempts >= this.demoteAfterFailures && this._current === 'smee-active') {
      this.transition('poll-fallback', 'smee-runtime-lost');
    }
  }

  onReconnectSuccess(): void {
    if (this.stopped) return;
    this.consecutiveReconnectFailures = 0;
    this.lastSuccessfulConnectAt = this.now();
    if (this._current === 'smee-attempt') {
      const shouldEmit = this.pendingRePromoteEmit;
      this.pendingRePromoteEmit = false;
      if (shouldEmit) {
        this.transition('smee-active', 'smee-re-promoted');
      } else {
        this._current = 'smee-active';
        for (const cb of this.modeChangeCbs) {
          try {
            cb('smee-active', 'startup-smee-selected');
          } catch {
            /* callback errors are swallowed */
          }
        }
      }
    } else if (this._current === 'poll-fallback') {
      // Runtime bridge exit: background smee reconnect succeeded → jump
      // directly back to smee-active, skipping smee-attempt.
      if (this.rePromoteTimer != null) {
        clearInterval(this.rePromoteTimer);
        this.rePromoteTimer = null;
      }
      this.transition('smee-active', 'smee-re-promoted');
    }
  }

  /** Refresh liveness on inbound SSE bytes (keepalive comments or payloads). */
  onSseBytes(): void {
    if (this.stopped) return;
    if (this._current !== 'smee-active') return;
    this.lastSuccessfulConnectAt = this.now();
  }

  /** Startup `startSmeeMode` returned `transient-fail`: transition to the live
   * poll-fallback bridge so `rePromoteTimer` arms and stdout keeps flowing. */
  markStartupSmeeFailed(): void {
    if (this.stopped) return;
    if (this._current !== 'smee-attempt') return;
    this.transition('poll-fallback', 'startup-smee-failed');
  }

  observeElapsed(): void {
    if (this.stopped) return;
    if (this._current !== 'smee-active') return;
    if (this.lastSuccessfulConnectAt == null) return;
    const elapsed = this.now() - this.lastSuccessfulConnectAt;
    if (elapsed > this.demoteAfterMsWithoutSuccess) {
      this.transition('poll-fallback', 'smee-runtime-lost');
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.elapsedTicker != null) {
      clearInterval(this.elapsedTicker);
      this.elapsedTicker = null;
    }
    if (this.rePromoteTimer != null) {
      clearInterval(this.rePromoteTimer);
      this.rePromoteTimer = null;
    }
  }

  private transition(next: SourceMode, reason: SourceReason): void {
    if (this._current === next) return;
    const prev = this._current;
    this._current = next;

    if (next === 'poll-fallback') {
      this.demotedAt = this.now();
      if (this.initialWasSmee && this.rePromoteTimer == null) {
        this.rePromoteTimer = setInterval(
          () => this.tickRePromote(),
          this.rePromoteIntervalMs,
        );
        if (typeof this.rePromoteTimer.unref === 'function') this.rePromoteTimer.unref();
      }
    } else if (next === 'smee-attempt' && prev === 'poll-fallback') {
      // moving out of poll-fallback via the re-promote timer
      if (this.rePromoteTimer != null) {
        clearInterval(this.rePromoteTimer);
        this.rePromoteTimer = null;
      }
    }

    for (const cb of this.modeChangeCbs) {
      try {
        cb(next, reason);
      } catch {
        /* callback errors are swallowed */
      }
    }
    this.writeLine(next, reason);
  }

  private tickRePromote(): void {
    if (this.stopped) return;
    if (this._current !== 'poll-fallback') return;
    // Silent transition to smee-attempt; the eventual line is emitted only if
    // the reconnect succeeds (smee-re-promoted).
    if (this.rePromoteTimer != null) {
      clearInterval(this.rePromoteTimer);
      this.rePromoteTimer = null;
    }
    this._current = 'smee-attempt';
    this.pendingRePromoteEmit = true;
    this.consecutiveReconnectFailures = 0;
    this.demotedAt = null;
    for (const cb of this.modeChangeCbs) {
      try {
        cb('smee-attempt', 'smee-re-promoted');
      } catch {
        /* callback errors are swallowed */
      }
    }
  }

  private writeLine(next: SourceMode, reason: SourceReason): void {
    try {
      this.stderr.write(formatLine(next, reason));
    } catch {
      /* stderr write failures are swallowed */
    }
  }
}
