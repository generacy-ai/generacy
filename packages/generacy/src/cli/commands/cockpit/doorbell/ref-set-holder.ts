/**
 * `EpicRefSetHolder` — single shared owner of the bound epic's resolved ref set
 * (`RefSetView` via `buildRefSet`). One refresh feeds every consumer:
 * `SmeeDoorbellSource` (webhook-debounce + safety-net triggers) and
 * `AnswersFileSource` (unknown-ref miss triggers).
 *
 * Contract: `specs/1228-symptom-every-generacy-cockpit/contracts/epic-ref-set-holder.md`.
 */
import {
  resolveEpic,
  type GhWrapper,
  type ResolvedEpic,
} from '@generacy-ai/cockpit';
import { buildRefSet } from './smee-source.js';
import type { RefSetView } from './webhook-to-event.js';

export const DEFAULT_MISS_REFRESH_MIN_INTERVAL_MS = 30_000;

export interface EpicRefSetHolderOptions {
  /** Epic ref in "owner/repo#number" form. */
  epicRef: string;
  gh: GhWrapper;
  logger: { warn(msg: string): void; info?(msg: string): void };
  /** Test seam: resolver override. Defaults to `resolveEpic`. */
  resolve?: typeof resolveEpic;
  /** Throttle window for `refreshOnMiss()`. Default 30_000 ms. */
  missRefreshMinIntervalMs?: number;
  /** Test seam: clock injection. Default () => Date.now(). */
  now?: () => number;
  /**
   * Notified on every failed resolve (both `refresh()` and `refreshOnMiss()`),
   * after the warn log. Lets the smee source preserve its
   * `onRefSetRefreshFailure` semantics while delegating resolution here.
   */
  onRefreshFailure?: (err: unknown) => void;
}

export class EpicRefSetHolder {
  private readonly epicRef: string;
  private readonly gh: GhWrapper;
  private readonly logger: { warn(msg: string): void; info?(msg: string): void };
  private readonly resolve: typeof resolveEpic;
  private readonly missRefreshMinIntervalMs: number;
  private readonly now: () => number;
  private readonly onRefreshFailure?: (err: unknown) => void;

  private currentRefSet: RefSetView | null = null;
  private currentResolved: ResolvedEpic | null = null;
  private lastRefreshAt: number | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(options: EpicRefSetHolderOptions) {
    this.epicRef = options.epicRef;
    this.gh = options.gh;
    this.logger = options.logger;
    this.resolve = options.resolve ?? resolveEpic;
    this.missRefreshMinIntervalMs =
      options.missRefreshMinIntervalMs ?? DEFAULT_MISS_REFRESH_MIN_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    if (options.onRefreshFailure != null) {
      this.onRefreshFailure = options.onRefreshFailure;
    }
  }

  get current(): RefSetView | null {
    return this.currentRefSet;
  }

  get resolved(): ResolvedEpic | null {
    return this.currentResolved;
  }

  /**
   * Unthrottled resolve+store. Throws on failure ONLY when there is no prior
   * successful set (startup — caller demotes to poll-fallback); after first
   * success, failures warn and retain the previous set. Resets the throttle
   * window. Overlapping calls coalesce onto one in-flight resolve.
   */
  async refresh(): Promise<void> {
    const hadPrior = this.currentRefSet != null;
    if (this.inFlight != null) {
      try {
        await this.inFlight;
      } catch (err) {
        if (!hadPrior) throw err;
      }
      return;
    }
    const p = this.doResolve();
    this.inFlight = p;
    try {
      await p;
    } catch (err) {
      // A resolve failure with no prior set is fatal to the caller; propagate.
      // After first success, retain the previous set (warn already logged).
      if (!hadPrior) throw err;
    } finally {
      if (this.inFlight === p) this.inFlight = null;
    }
  }

  /**
   * Throttled resolve for the tailer's unknown-ref path. If a resolve ran
   * within `missRefreshMinIntervalMs`, returns without resolving. Never throws;
   * failures warn and retain the previous set. Concurrent calls share one
   * in-flight resolve.
   */
  async refreshOnMiss(): Promise<void> {
    if (this.inFlight != null) {
      try {
        await this.inFlight;
      } catch {
        /* never throws — previous set retained */
      }
      return;
    }
    if (
      this.lastRefreshAt != null &&
      this.now() - this.lastRefreshAt < this.missRefreshMinIntervalMs
    ) {
      return;
    }
    const p = this.doResolve();
    this.inFlight = p;
    try {
      await p;
    } catch {
      // Never throws — failure warned inside doResolve, previous set retained.
    } finally {
      if (this.inFlight === p) this.inFlight = null;
    }
  }

  private async doResolve(): Promise<void> {
    // Reset the throttle window at the START so overlapping miss-refreshes that
    // await this promise all see the window as consumed.
    this.lastRefreshAt = this.now();
    try {
      const resolved = await this.resolve({
        epicRef: this.epicRef,
        gh: this.gh,
        logger: this.logger,
      });
      this.currentResolved = resolved;
      this.currentRefSet = buildRefSet(resolved);
    } catch (err) {
      this.logger.warn(
        `cockpit doorbell: ref-set refresh failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      if (this.onRefreshFailure != null) {
        try {
          this.onRefreshFailure(err);
        } catch {
          /* callback errors are swallowed */
        }
      }
      throw err;
    }
  }
}
