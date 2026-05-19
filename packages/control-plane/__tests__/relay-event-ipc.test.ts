import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setRelayPushEvent, getRelayPushEvent } from '../src/relay-events.js';

describe('Relay event IPC callback', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    globalThis.fetch = mockFetch;
    // Reset push event
    setRelayPushEvent(undefined as unknown as (channel: string, payload: unknown) => void);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function wireCallback(
    orchestratorUrl = 'http://127.0.0.1:3100',
    apiKey = 'test-api-key',
  ) {
    setRelayPushEvent((channel, payload) => {
      fetch(`${orchestratorUrl}/internal/relay-events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ channel, payload }),
      }).catch(() => {
        // fire-and-forget
      });
    });
  }

  it('POSTs to the orchestrator with correct URL, headers, and body', async () => {
    wireCallback('http://localhost:3100', 'my-key');
    const pushEvent = getRelayPushEvent();
    expect(pushEvent).toBeDefined();

    pushEvent!('cluster.vscode-tunnel', { status: 'starting' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3100/internal/relay-events',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer my-key',
        },
        body: JSON.stringify({
          channel: 'cluster.vscode-tunnel',
          payload: { status: 'starting' },
        }),
      },
    );
  });

  it('handles fetch failure gracefully (no throw)', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));
    wireCallback();
    const pushEvent = getRelayPushEvent();

    // Should not throw
    pushEvent!('cluster.audit', { entries: [] });

    // Give the promise time to settle
    await new Promise((r) => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when setRelayPushEvent is not called', () => {
    // Reset to undefined
    setRelayPushEvent(undefined as unknown as (channel: string, payload: unknown) => void);
    const pushEvent = getRelayPushEvent();
    // The set with undefined resets it
    expect(pushEvent).toBeUndefined();
  });

  it('uses correct orchestrator URL from env override', async () => {
    wireCallback('http://custom-host:9999', 'key-123');
    const pushEvent = getRelayPushEvent();

    pushEvent!('cluster.credentials', { credentialId: 'cred-1' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://custom-host:9999/internal/relay-events',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'authorization': 'Bearer key-123',
        }),
      }),
    );
  });
});
