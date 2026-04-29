import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';

import { handlePostAuditBatch, setRelayPushEvent } from '../src/routes/audit.js';
import type { ActorContext } from '../src/context.js';
import { ControlPlaneError } from '../src/errors.js';

function createMockReq(body: string): http.IncomingMessage {
  const { Readable } = require('node:stream');
  const readable = new Readable({
    read() {
      this.push(body);
      this.push(null);
    },
  });
  readable.method = 'POST';
  readable.url = '/internal/audit-batch';
  readable.headers = { 'content-type': 'application/json' };
  return readable as http.IncomingMessage;
}

function createMockRes(): http.ServerResponse & { _body: string; _status: number } {
  const res = {
    _body: '',
    _status: 0,
    writeHead(status: number, _headers?: Record<string, string>) {
      res._status = status;
      return res;
    },
    end(body?: string) {
      res._body = body ?? '';
      return res;
    },
  } as unknown as http.ServerResponse & { _body: string; _status: number };
  return res;
}

const actor: ActorContext = { userId: 'user-1', sessionId: 'sess-1' };

describe('POST /internal/audit-batch', () => {
  let pushEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pushEvent = vi.fn();
    setRelayPushEvent(pushEvent);
  });

  it('accepts a valid batch and emits entries via pushEvent', async () => {
    const batch = {
      entries: [
        {
          timestamp: new Date().toISOString(),
          action: 'credential.mint',
          actor: { workerId: 'w1' },
          clusterId: 'c1',
          success: true,
        },
        {
          timestamp: new Date().toISOString(),
          action: 'session.begin',
          actor: { workerId: 'w1', sessionId: 's1' },
          clusterId: 'c1',
          success: true,
        },
      ],
      droppedSinceLastBatch: 0,
    };

    const req = createMockReq(JSON.stringify(batch));
    const res = createMockRes();

    await handlePostAuditBatch(req, res, actor, {});

    expect(res._status).toBe(200);
    expect(pushEvent).toHaveBeenCalledTimes(2);
    expect(pushEvent).toHaveBeenCalledWith('cluster.audit', batch.entries[0]);
    expect(pushEvent).toHaveBeenCalledWith('cluster.audit', batch.entries[1]);
  });

  it('rejects invalid JSON', async () => {
    const req = createMockReq('not json');
    const res = createMockRes();

    await expect(handlePostAuditBatch(req, res, actor, {})).rejects.toThrow(ControlPlaneError);
  });

  it('rejects a batch that fails schema validation', async () => {
    const bad = { entries: 'not-an-array', droppedSinceLastBatch: -1 };
    const req = createMockReq(JSON.stringify(bad));
    const res = createMockRes();

    await expect(handlePostAuditBatch(req, res, actor, {})).rejects.toThrow(ControlPlaneError);
  });

  it('rejects a batch with > 50 entries', async () => {
    const entries = Array.from({ length: 51 }, () => ({
      timestamp: new Date().toISOString(),
      action: 'credential.mint',
      actor: { workerId: 'w1' },
      clusterId: 'c1',
      success: true,
    }));
    const batch = { entries, droppedSinceLastBatch: 0 };

    const req = createMockReq(JSON.stringify(batch));
    const res = createMockRes();

    await expect(handlePostAuditBatch(req, res, actor, {})).rejects.toThrow(ControlPlaneError);
  });
});
