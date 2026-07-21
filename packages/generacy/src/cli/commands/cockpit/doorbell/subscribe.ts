/**
 * `subscribeAndEmit` — drives a `bus.waitFor` loop and writes one stdout line
 * per emitted event to the caller-supplied stdout target. Pure translator
 * lives in `lineForEvent`.
 *
 * Contract: `contracts/subscribe-and-emit.md`.
 */
import type { EpicEventBus } from '../mcp/event-bus.js';
import type { CockpitStreamEvent } from '../watch/stream-event.js';

export interface SubscribeEmitOptions {
  stdout: { write(chunk: string, cb?: () => void): boolean | void };
  onEmit?: (event: CockpitStreamEvent) => void;
  /**
   * Event `type` values to skip writing to stdout. The cursor advances past
   * skipped entries as normal, so downstream consumers see them via
   * `bus.waitFor`. Used to avoid double stdout writes when another producer
   * (e.g. `AnswersFileSource`) writes gate-answer events directly.
   */
  skipTypes?: readonly string[];
}

export type SubscribeUnsubscribe = () => void;

const WAIT_MS = 60_000;
const COALESCE_WINDOW_MS = 0;
const MAX_BATCH_SIZE = 100;

export function lineForEvent(event: CockpitStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function subscribeAndEmit(
  bus: EpicEventBus,
  options: SubscribeEmitOptions,
): SubscribeUnsubscribe {
  let stopped = false;
  let resolveStop: (() => void) | null = null;
  const stopSignal = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });

  const loop = async (): Promise<void> => {
    let sinceCursor = 0;
    while (!stopped) {
      const waitPromise = bus.waitFor({
        sinceCursor,
        maxWaitMs: WAIT_MS,
        coalesceWindowMs: COALESCE_WINDOW_MS,
        maxBatchSize: MAX_BATCH_SIZE,
      });
      const result = await Promise.race([
        waitPromise.then((r) => ({ kind: 'entries' as const, r })),
        stopSignal.then(() => ({ kind: 'stopped' as const })),
      ]);
      if (result.kind === 'stopped') return;
      if (stopped) return;
      for (const entry of result.r.entries) {
        if (stopped) return;
        sinceCursor = entry.cursor;
        if (options.skipTypes?.includes(entry.event.type)) continue;
        const line = lineForEvent(entry.event);
        await new Promise<void>((resolve) => {
          options.stdout.write(line, () => resolve());
        });
        options.onEmit?.(entry.event);
      }
    }
  };

  void loop();

  return () => {
    if (stopped) return;
    stopped = true;
    if (resolveStop != null) {
      const r = resolveStop;
      resolveStop = null;
      r();
    }
  };
}
