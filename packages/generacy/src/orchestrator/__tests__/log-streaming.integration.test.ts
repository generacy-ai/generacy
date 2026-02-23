/**
 * Integration tests for end-to-end log streaming.
 *
 * These tests spin up a real orchestrator HTTP server and verify the full
 * flow: POST log:append events → LogBuffer storage → GET /api/jobs/:jobId/logs
 * retrieval, SSE streaming, and cleanup after job completion.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { createOrchestratorServer, type OrchestratorServer } from '../server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make an HTTP request and return the parsed JSON response. */
function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : null });
          } catch {
            resolve({ status: res.statusCode!, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Open an SSE connection and collect received events into an array. */
function openSSE(
  port: number,
  path: string,
): { events: Array<{ event: string; id: string; data: unknown }>; close: () => void; response: Promise<http.IncomingMessage> } {
  const events: Array<{ event: string; id: string; data: unknown }> = [];
  let closeReq: (() => void) | undefined;

  const response = new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'GET',
        path,
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        let buffer = '';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();

          // Parse complete SSE frames (terminated by double newline)
          const frames = buffer.split('\n\n');
          // Keep the last incomplete frame in the buffer
          buffer = frames.pop()!;

          for (const frame of frames) {
            if (!frame.trim() || frame.startsWith(':')) continue;

            const parsed: { event: string; id: string; data: unknown } = {
              event: '',
              id: '',
              data: null,
            };
            for (const line of frame.split('\n')) {
              if (line.startsWith('event: ')) parsed.event = line.slice(7);
              else if (line.startsWith('id: ')) parsed.id = line.slice(4);
              else if (line.startsWith('data: ')) {
                try {
                  parsed.data = JSON.parse(line.slice(6));
                } catch {
                  parsed.data = line.slice(6);
                }
              }
            }
            events.push(parsed);
          }
        });

        resolve(res);
      },
    );
    req.on('error', reject);
    closeReq = () => req.destroy();
    req.end();
  });

  return {
    events,
    close: () => closeReq?.(),
    response,
  };
}

/** Wait for a condition to become true, polling at short intervals. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 20,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Log streaming integration', () => {
  let server: OrchestratorServer;
  let port: number;
  let jobId: string;

  // Suppress console output from the server
  const silentLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  beforeEach(async () => {
    server = createOrchestratorServer({
      port: 0, // Random available port
      logger: silentLogger,
      sseHeartbeatInterval: 60_000, // Long interval so heartbeats don't interfere
      eventGracePeriod: 500, // Short grace period for faster cleanup tests
    });
    await server.listen();
    port = server.getPort();

    // Submit a job so we have something to publish events against
    const res = await request(port, 'POST', '/api/jobs', {
      name: 'test-job',
      workflow: 'speckit',
      inputs: { feature_dir: '/tmp/test' },
    });
    jobId = (res.body as { jobId: string }).jobId;

    // Move job to running state
    await request(port, 'PUT', `/api/jobs/${jobId}/status`, { status: 'running' });
  });

  afterEach(async () => {
    await server.close();
  });

  // -------------------------------------------------------------------------
  // Test: POST log:append → GET /api/jobs/:jobId/logs
  // -------------------------------------------------------------------------

  it('should store log:append events and return them via GET /logs', async () => {
    // POST a log:append event
    const postRes = await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'log:append',
      timestamp: 1700000000000,
      data: {
        stream: 'stdout',
        stepName: 'specify',
        content: 'Reading extension/src/extension.ts...\n',
      },
    });
    expect(postRes.status).toBe(201);

    // GET the logs
    const getRes = await request(port, 'GET', `/api/jobs/${jobId}/logs`);
    expect(getRes.status).toBe(200);

    const body = getRes.body as { entries: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      id: 1,
      timestamp: 1700000000000,
      stream: 'stdout',
      stepName: 'specify',
      content: 'Reading extension/src/extension.ts...\n',
    });
  });

  it('should store multiple log entries and return them in order', async () => {
    // POST multiple log:append events
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'log:append',
      timestamp: 1700000000000,
      data: { stream: 'stdout', stepName: 'specify', content: 'first chunk' },
    });
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'log:append',
      timestamp: 1700000000100,
      data: { stream: 'stderr', stepName: 'specify', content: 'warning' },
    });
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'log:append',
      timestamp: 1700000000200,
      data: { stream: 'stdout', stepName: 'plan', content: 'planning...' },
    });

    const getRes = await request(port, 'GET', `/api/jobs/${jobId}/logs`);
    const body = getRes.body as { entries: Array<Record<string, unknown>>; total: number };

    expect(body.total).toBe(3);
    expect(body.entries).toHaveLength(3);
    expect(body.entries[0]).toMatchObject({ id: 1, content: 'first chunk' });
    expect(body.entries[1]).toMatchObject({ id: 2, content: 'warning', stream: 'stderr' });
    expect(body.entries[2]).toMatchObject({ id: 3, content: 'planning...', stepName: 'plan' });
  });

  it('should include taskIndex and taskTitle for implement operations', async () => {
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'log:append',
      timestamp: 1700000000000,
      data: {
        stream: 'stdout',
        stepName: 'implement',
        content: 'Implementing task...',
        taskIndex: 2,
        taskTitle: 'Add error handling',
      },
    });

    const getRes = await request(port, 'GET', `/api/jobs/${jobId}/logs`);
    const body = getRes.body as { entries: Array<Record<string, unknown>>; total: number };

    expect(body.entries[0]).toMatchObject({
      taskIndex: 2,
      taskTitle: 'Add error handling',
    });
  });

  it('should return empty entries for unknown job IDs', async () => {
    const getRes = await request(port, 'GET', '/api/jobs/nonexistent-job/logs');

    // Note: the logs endpoint returns empty, not 404 — consistent with "no logs yet"
    expect(getRes.status).toBe(200);
    const body = getRes.body as { entries: unknown[]; total: number };
    expect(body.entries).toEqual([]);
    expect(body.total).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test: ?since=<id> returns only newer entries
  // -------------------------------------------------------------------------

  it('should return only entries after the specified since ID', async () => {
    // POST 5 log entries
    for (let i = 1; i <= 5; i++) {
      await request(port, 'POST', `/api/jobs/${jobId}/events`, {
        type: 'log:append',
        timestamp: 1700000000000 + i * 100,
        data: { stream: 'stdout', stepName: 'specify', content: `chunk-${i}` },
      });
    }

    // Fetch entries after id 3
    const getRes = await request(port, 'GET', `/api/jobs/${jobId}/logs?since=3`);
    const body = getRes.body as { entries: Array<Record<string, unknown>>; total: number };

    expect(body.total).toBe(5); // total in buffer
    expect(body.entries).toHaveLength(2); // entries 4 and 5
    expect(body.entries[0]).toMatchObject({ id: 4, content: 'chunk-4' });
    expect(body.entries[1]).toMatchObject({ id: 5, content: 'chunk-5' });
  });

  it('should return no entries when since equals the latest ID', async () => {
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'log:append',
      timestamp: 1700000000000,
      data: { stream: 'stdout', stepName: 'plan', content: 'done' },
    });

    const getRes = await request(port, 'GET', `/api/jobs/${jobId}/logs?since=1`);
    const body = getRes.body as { entries: unknown[]; total: number };

    expect(body.entries).toHaveLength(0);
  });

  it('should return all entries when since is 0', async () => {
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'log:append',
      timestamp: 1700000000000,
      data: { stream: 'stdout', stepName: 'specify', content: 'a' },
    });
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'log:append',
      timestamp: 1700000000100,
      data: { stream: 'stdout', stepName: 'specify', content: 'b' },
    });

    const getRes = await request(port, 'GET', `/api/jobs/${jobId}/logs?since=0`);
    const body = getRes.body as { entries: unknown[]; total: number };

    expect(body.entries).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Test: SSE subscriber receives log:append events in real-time
  // -------------------------------------------------------------------------

  it('should deliver log:append events to SSE subscribers in real-time', async () => {
    // Open SSE connection to the job events stream
    const sse = openSSE(port, `/api/jobs/${jobId}/events`);

    // Wait for the SSE connection to be established
    await sse.response;
    // Give the server a moment to register the subscriber
    await new Promise((r) => setTimeout(r, 50));

    // POST a log:append event
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'log:append',
      timestamp: 1700000000000,
      data: {
        stream: 'stdout',
        stepName: 'specify',
        content: 'Streaming output...\n',
      },
    });

    // Wait for the SSE event to arrive
    await waitFor(() => sse.events.length >= 1);

    expect(sse.events).toHaveLength(1);
    expect(sse.events[0].event).toBe('log:append');

    const eventData = sse.events[0].data as Record<string, unknown>;
    expect(eventData.type).toBe('log:append');

    sse.close();
  });

  it('should deliver both lifecycle and log events on the same SSE stream', async () => {
    const sse = openSSE(port, `/api/jobs/${jobId}/events`);
    await sse.response;
    await new Promise((r) => setTimeout(r, 50));

    // POST a lifecycle event
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'step:start',
      timestamp: 1700000000000,
      data: { step: 'specify' },
    });

    // POST a log event
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'log:append',
      timestamp: 1700000000100,
      data: { stream: 'stdout', stepName: 'specify', content: 'output' },
    });

    // POST another lifecycle event
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'step:complete',
      timestamp: 1700000000200,
      data: { step: 'specify' },
    });

    await waitFor(() => sse.events.length >= 3);

    expect(sse.events[0].event).toBe('step:start');
    expect(sse.events[1].event).toBe('log:append');
    expect(sse.events[2].event).toBe('step:complete');

    sse.close();
  });

  it('should not store log:append events in the lifecycle event RingBuffer', async () => {
    // Count existing lifecycle events (e.g., job:status from beforeEach)
    const eventBus = server.getEventBus();
    const existingCount = eventBus.getBufferedEvents(jobId).length;

    // POST log events
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'log:append',
      timestamp: 1700000000000,
      data: { stream: 'stdout', stepName: 'specify', content: 'log data' },
    });

    // POST a lifecycle event
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'step:start',
      timestamp: 1700000000100,
      data: { step: 'specify' },
    });

    // The lifecycle RingBuffer should only have grown by 1 (the step:start),
    // not 2 — the log:append should NOT be in the RingBuffer
    const buffered = eventBus.getBufferedEvents(jobId);
    expect(buffered).toHaveLength(existingCount + 1);
    expect(buffered[buffered.length - 1].type).toBe('step:start');

    // Verify no log:append events in the RingBuffer
    expect(buffered.every((e) => e.type !== 'log:append')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test: Log buffer cleanup after job completion grace period
  // -------------------------------------------------------------------------

  it('should clean up log buffer after job completion and grace period', async () => {
    vi.useFakeTimers();

    try {
      // POST a log event
      await request(port, 'POST', `/api/jobs/${jobId}/events`, {
        type: 'log:append',
        timestamp: 1700000000000,
        data: { stream: 'stdout', stepName: 'specify', content: 'data to clean' },
      });

      // Verify the log entry exists
      const beforeRes = await request(port, 'GET', `/api/jobs/${jobId}/logs`);
      const beforeBody = beforeRes.body as { entries: unknown[]; total: number };
      expect(beforeBody.total).toBe(1);

      // Complete the job — this triggers scheduleCleanup
      await request(port, 'PUT', `/api/jobs/${jobId}/status`, { status: 'completed' });

      // Log buffer should still exist before grace period
      const duringRes = await request(port, 'GET', `/api/jobs/${jobId}/logs`);
      const duringBody = duringRes.body as { entries: unknown[]; total: number };
      expect(duringBody.total).toBe(1);

      // Advance past the grace period (500ms as configured)
      vi.advanceTimersByTime(600);

      // Log buffer should be cleaned up
      const afterRes = await request(port, 'GET', `/api/jobs/${jobId}/logs`);
      const afterBody = afterRes.body as { entries: unknown[]; total: number };
      expect(afterBody.entries).toEqual([]);
      expect(afterBody.total).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // Test: SSE streaming mode for logs endpoint
  // -------------------------------------------------------------------------

  it('should stream existing and live log entries via SSE with ?stream=true', async () => {
    // POST some initial log entries
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'log:append',
      timestamp: 1700000000000,
      data: { stream: 'stdout', stepName: 'specify', content: 'existing-1' },
    });
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'log:append',
      timestamp: 1700000000100,
      data: { stream: 'stdout', stepName: 'specify', content: 'existing-2' },
    });

    // Open SSE connection to the logs stream
    const sse = openSSE(port, `/api/jobs/${jobId}/logs?stream=true`);
    await sse.response;

    // Wait for the existing entries to be sent
    await waitFor(() => sse.events.length >= 2);

    // Verify existing entries arrived as SSE events
    expect(sse.events[0].event).toBe('log:append');
    expect((sse.events[0].data as Record<string, unknown>).content).toBe('existing-1');
    expect(sse.events[1].event).toBe('log:append');
    expect((sse.events[1].data as Record<string, unknown>).content).toBe('existing-2');

    // Now POST a live event — it should arrive via the SSE subscription
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'log:append',
      timestamp: 1700000000200,
      data: { stream: 'stdout', stepName: 'plan', content: 'live-event' },
    });

    // The live event comes through the EventBus SSE broadcast (full JobEvent format)
    await waitFor(() => sse.events.length >= 3);

    // The live event is broadcast as a full JobEvent via the EventBus subscriber
    const liveEvent = sse.events[2].data as Record<string, unknown>;
    expect(liveEvent.type).toBe('log:append');

    sse.close();
  });

  it('should support ?since= with ?stream=true for incremental SSE', async () => {
    // POST 3 log entries
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'log:append',
      timestamp: 1700000000000,
      data: { stream: 'stdout', stepName: 'specify', content: 'entry-1' },
    });
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'log:append',
      timestamp: 1700000000100,
      data: { stream: 'stdout', stepName: 'specify', content: 'entry-2' },
    });
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'log:append',
      timestamp: 1700000000200,
      data: { stream: 'stdout', stepName: 'specify', content: 'entry-3' },
    });

    // Open SSE connection with since=2 — should only get entry-3 from replay
    const sse = openSSE(port, `/api/jobs/${jobId}/logs?stream=true&since=2`);
    await sse.response;

    await waitFor(() => sse.events.length >= 1);

    // Only entry-3 should be in the initial replay
    expect(sse.events[0].event).toBe('log:append');
    expect((sse.events[0].data as Record<string, unknown>).content).toBe('entry-3');

    sse.close();
  });

  // -------------------------------------------------------------------------
  // Test: log:append events are isolated per job
  // -------------------------------------------------------------------------

  it('should isolate log entries per job', async () => {
    // Create a second job
    const res2 = await request(port, 'POST', '/api/jobs', {
      name: 'test-job-2',
      workflow: 'speckit',
      inputs: {},
    });
    const jobId2 = (res2.body as { jobId: string }).jobId;
    await request(port, 'PUT', `/api/jobs/${jobId2}/status`, { status: 'running' });

    // POST logs to job 1
    await request(port, 'POST', `/api/jobs/${jobId}/events`, {
      type: 'log:append',
      timestamp: 1700000000000,
      data: { stream: 'stdout', stepName: 'specify', content: 'job-1-log' },
    });

    // POST logs to job 2
    await request(port, 'POST', `/api/jobs/${jobId2}/events`, {
      type: 'log:append',
      timestamp: 1700000000000,
      data: { stream: 'stdout', stepName: 'plan', content: 'job-2-log' },
    });

    // Each job should only see its own logs
    const logs1 = await request(port, 'GET', `/api/jobs/${jobId}/logs`);
    const body1 = logs1.body as { entries: Array<Record<string, unknown>>; total: number };
    expect(body1.total).toBe(1);
    expect(body1.entries[0]).toMatchObject({ content: 'job-1-log' });

    const logs2 = await request(port, 'GET', `/api/jobs/${jobId2}/logs`);
    const body2 = logs2.body as { entries: Array<Record<string, unknown>>; total: number };
    expect(body2.total).toBe(1);
    expect(body2.entries[0]).toMatchObject({ content: 'job-2-log' });
  });
});
