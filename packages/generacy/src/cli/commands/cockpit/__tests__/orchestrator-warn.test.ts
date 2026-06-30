import { beforeEach, describe, expect, it } from 'vitest';
import {
  createFirstFailureWarner,
  type WarnSink,
} from '../shared/orchestrator-warn.js';

class CaptureSink implements WarnSink {
  public readonly messages: string[] = [];
  write(message: string): void {
    this.messages.push(message);
  }
}

describe('createFirstFailureWarner', () => {
  let sink: CaptureSink;

  beforeEach(() => {
    sink = new CaptureSink();
  });

  it('writes one message on the first call and flips hasFired() from false to true', () => {
    const warner = createFirstFailureWarner(sink);
    expect(warner.hasFired()).toBe(false);
    expect(sink.messages).toHaveLength(0);

    warner('timeout');

    expect(warner.hasFired()).toBe(true);
    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0]).toBe(
      'cockpit: orchestrator unavailable: timeout\n',
    );
  });

  it('is silent on the second and later calls; sink stays at length 1 and hasFired() stays true', () => {
    const warner = createFirstFailureWarner(sink);
    warner('timeout');
    warner('cloud-unreachable');
    warner('http-error');

    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0]).toBe(
      'cockpit: orchestrator unavailable: timeout\n',
    );
    expect(warner.hasFired()).toBe(true);
  });

  it('interpolates the literal reason on the first call', () => {
    const warner = createFirstFailureWarner(sink);
    warner('no-token');

    expect(sink.messages[0]).toBe(
      'cockpit: orchestrator unavailable: no-token\n',
    );
  });

  it('interpolates a different literal reason on the first call', () => {
    const warner = createFirstFailureWarner(sink);
    warner('http-error');

    expect(sink.messages[0]).toBe(
      'cockpit: orchestrator unavailable: http-error\n',
    );
  });

  it('with many different reasons across many calls, still emits exactly one line (the first reason)', () => {
    const warner = createFirstFailureWarner(sink);
    const reasons = [
      'timeout',
      'cloud-unreachable',
      'http-error',
      'no-token',
      'something-else',
      'timeout',
    ];
    for (const reason of reasons) {
      warner(reason);
    }

    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0]).toBe(
      'cockpit: orchestrator unavailable: timeout\n',
    );
    expect(warner.hasFired()).toBe(true);
  });

  it('two independent warners maintain independent state', () => {
    const sinkA = new CaptureSink();
    const sinkB = new CaptureSink();
    const warnerA = createFirstFailureWarner(sinkA);
    const warnerB = createFirstFailureWarner(sinkB);

    warnerA('reason-a');
    expect(warnerA.hasFired()).toBe(true);
    expect(warnerB.hasFired()).toBe(false);
    expect(sinkA.messages).toHaveLength(1);
    expect(sinkB.messages).toHaveLength(0);

    warnerB('reason-b');
    expect(warnerB.hasFired()).toBe(true);
    expect(sinkB.messages).toEqual([
      'cockpit: orchestrator unavailable: reason-b\n',
    ]);
  });
});
