/**
 * `cockpit_await_events` MCP tool handler.
 *
 * Long-poll for cockpit stream events for a given epic. Cursor-based;
 * coalesces bursts within `coalesceWindowMs`; soft-cap at `maxBatchSize`
 * (returned cursor is the continuation).
 *
 * Cursor classes (Q3-D):
 *   - malformed / never-issued / wrong-epic → typed `invalid-cursor` error
 *   - expired → silent reset to head with `resetFrom: "expired"`
 *   - valid → normal path
 */
import type { CommandRunner } from '@generacy-ai/cockpit';
import type { CockpitStreamEvent } from '../../watch/stream-event.js';
import { normalizeIssueRef } from '../ref-input.js';
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import { AwaitEventsInputSchema, type AwaitEventsInput } from '../schemas.js';
import { acquireEpicBus, type Acquired } from '../event-bus-registry.js';
import { encodeCursor, type EpicEventBus } from '../event-bus.js';

export interface CockpitAwaitEventsData {
  events: CockpitStreamEvent[];
  cursor: string;
  resetFrom?: 'expired';
}

export interface CockpitAwaitEventsDeps {
  runner?: CommandRunner;
  /**
   * Test seam: provide a pre-built acquired bus. Bypasses the registry
   * (poll loop not started). Handler will NOT call `release` on it.
   */
  acquired?: Acquired;
  intervalMs?: number;
}

export function cockpitAwaitEvents(
  input: unknown,
  deps: CockpitAwaitEventsDeps = {},
): Promise<ToolResult<CockpitAwaitEventsData>> {
  return wrapToolBoundary(async () => {
    const parsed = AwaitEventsInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        status: 'error',
        class: 'invalid-args',
        detail: parsed.error.issues.map((i) => i.message).join('; '),
      };
    }
    const args: AwaitEventsInput = parsed.data;

    let acquired: Acquired;
    let releaseAfter = true;
    if (deps.acquired != null) {
      acquired = deps.acquired;
      releaseAfter = false;
    } else {
      const normalized = await normalizeIssueRef(args.epic, {
        expects: 'issue',
        ...(deps.runner != null ? { runner: deps.runner } : {}),
      });
      if (!normalized.ok) return normalized.error;
      const epicRef = `${normalized.value.ref.nwo}#${normalized.value.ref.number}`;
      acquired = await acquireEpicBus({
        epicRef,
        ...(deps.runner != null ? { runner: deps.runner } : {}),
        gh: normalized.value.gh,
        ...(deps.intervalMs != null ? { intervalMs: deps.intervalMs } : {}),
      });
    }

    try {
      return await drainOrWait(acquired.bus, args);
    } finally {
      if (releaseAfter) acquired.release();
    }
  });
}

async function drainOrWait(
  bus: EpicEventBus,
  args: AwaitEventsInput,
): Promise<ToolResult<CockpitAwaitEventsData>> {
  const parseResult = bus.parseCursor(args.cursor);

  let resetFrom: 'expired' | undefined;
  let sinceCursor: number;
  switch (parseResult.kind) {
    case 'malformed':
      return {
        status: 'error',
        class: 'invalid-cursor',
        detail: 'cursor is malformed (expected base64-encoded position)',
        hint: 'cursor tokens are opaque; pass verbatim from a prior await_events result',
      };
    case 'never-issued':
      return {
        status: 'error',
        class: 'invalid-cursor',
        detail: `cursor position was never issued for epic ${bus.epic}`,
        hint: 'start with cursor=undefined for a fresh subscription',
      };
    case 'wrong-epic':
      return {
        status: 'error',
        class: 'invalid-cursor',
        detail:
          `cursor was issued for epic ${parseResult.requestedEpic}, not ${parseResult.boundEpic}`,
      };
    case 'expired':
      resetFrom = 'expired';
      sinceCursor = 0;
      break;
    case 'valid':
      sinceCursor = parseResult.position;
      break;
  }

  const result = await bus.waitFor({
    sinceCursor,
    maxWaitMs: args.maxWaitMs,
    coalesceWindowMs: args.coalesceWindowMs,
    maxBatchSize: args.maxBatchSize,
  });

  if (result.entries.length === 0) {
    const cursorStr = args.cursor ?? encodeCursor(bus.epic, sinceCursor);
    return {
      status: 'ok',
      data: {
        events: [],
        cursor: cursorStr,
        ...(resetFrom != null ? { resetFrom } : {}),
      },
    };
  }

  const last = result.entries[result.entries.length - 1]!;
  return {
    status: 'ok',
    data: {
      events: result.entries.map((e) => e.event),
      cursor: encodeCursor(bus.epic, last.cursor),
      ...(resetFrom != null ? { resetFrom } : {}),
    },
  };
}
