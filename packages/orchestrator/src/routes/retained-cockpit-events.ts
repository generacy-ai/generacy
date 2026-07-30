import type {
  ClusterRelayClient,
  PendingFrameMeta,
  RelayMessage,
} from '../types/relay.js';

export interface RetainedEvent {
  event: 'cluster.cockpit';
  data: unknown;
  timestamp: string;
  approxBytes: number;
}

export interface RetainerCaps {
  maxCount: number;
  maxBytes: number;
}

export interface EnqueueResult {
  droppedCount: number;
}

export interface DrainResult {
  sent: number;
  failed: number;
}

export interface QueueSize {
  count: number;
  bytes: number;
}

export interface RetainedCockpitEvents {
  enqueue(event: RetainedEvent): EnqueueResult;
  drainInto(client: ClusterRelayClient): DrainResult;
  size(): QueueSize;
  clear(): void;
}

export function createRetainedCockpitEvents(
  caps: RetainerCaps,
): RetainedCockpitEvents {
  const queue: RetainedEvent[] = [];
  let bytes = 0;

  function currentSize(): QueueSize {
    return { count: queue.length, bytes };
  }

  return {
    enqueue(event) {
      queue.push(event);
      bytes += event.approxBytes;
      let droppedCount = 0;
      while (
        queue.length > 0 &&
        (queue.length > caps.maxCount || bytes > caps.maxBytes)
      ) {
        const dropped = queue.shift();
        if (!dropped) break;
        bytes -= dropped.approxBytes;
        droppedCount += 1;
      }
      if (bytes < 0) bytes = 0;
      return { droppedCount };
    },

    drainInto(client) {
      let sent = 0;
      let failed = 0;
      while (queue.length > 0) {
        const head = queue[0];
        if (!head) break;
        try {
          // Re-arm the pending-frame TTL at send time. The accept-time
          // registerPendingFrame() (#1077) starts the 30s clock at request
          // accept, but for a retained frame the send is deferred by the
          // outage that caused the retain — reconnect backoff runs
          // 5s→15s→35s→75s cumulative, so from the third retry onward the
          // accept-time entry has already been evicted before drain. Also
          // covers the `getRelayClient() === null` accept-time path where no
          // entry was registered at all. Idempotent: registerPendingFrame
          // clears any existing TTL handle before re-inserting.
          const d = head.data as {
            frameId?: unknown;
            type?: unknown;
            gateId?: unknown;
          };
          if (
            typeof d.frameId === 'string' &&
            d.frameId.length > 0 &&
            (d.type === 'gate-open' || d.type === 'gate-outcome') &&
            typeof d.gateId === 'string'
          ) {
            const meta: PendingFrameMeta = {
              frameType: d.type,
              gateId: d.gateId,
            };
            client.registerPendingFrame(d.frameId, meta);
          }
          client.send({
            type: 'event',
            event: 'cluster.cockpit',
            data: head.data,
            timestamp: head.timestamp,
          } as unknown as RelayMessage);
          queue.shift();
          bytes -= head.approxBytes;
          if (bytes < 0) bytes = 0;
          sent += 1;
        } catch {
          failed += 1;
          break;
        }
      }
      return { sent, failed };
    },

    size: currentSize,

    clear() {
      queue.length = 0;
      bytes = 0;
    },
  };
}
