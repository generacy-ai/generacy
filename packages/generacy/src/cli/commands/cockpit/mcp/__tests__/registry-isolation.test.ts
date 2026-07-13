/**
 * #935 SC-004 — Two concurrent `acquireEpicBus` calls against different scope
 * refs in the same repo must not observe each other's events.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandRunner } from '@generacy-ai/cockpit';
import { acquireEpicBus, _resetRegistryForTests } from '../event-bus-registry.js';
import type { CockpitStreamEvent } from '../../watch/stream-event.js';

function stubRunner(): CommandRunner {
  return async () => ({ stdout: '', stderr: '', exitCode: 0 });
}

function makeEvent(n: number): CockpitStreamEvent {
  return {
    type: 'issue-transition',
    ts: '2026-07-13T00:00:00.000Z',
    repo: 'owner/repo',
    kind: 'issue',
    number: n,
    from: null,
    to: 'waiting:clarification',
    sourceLabel: 'waiting-for:clarification',
    url: `https://github.com/owner/repo/issues/${n}`,
    event: 'label-change',
    labels: ['waiting-for:clarification'],
  };
}

afterEach(() => {
  _resetRegistryForTests();
});

describe('#935 SC-004: registry isolation across scope refs', () => {
  it('two concurrent acquires on distinct scope refs get distinct buses; events do not cross', async () => {
    const runner = stubRunner();
    const busA = await acquireEpicBus({
      epicRef: 'owner/repo#100',
      runner,
      noPoll: true,
      runCycle: async () => undefined,
    });
    const busB = await acquireEpicBus({
      epicRef: 'owner/repo#200',
      runner,
      noPoll: true,
      runCycle: async () => undefined,
    });

    expect(busA.bus).not.toBe(busB.bus);
    expect(busA.bus.busNonce).not.toBe(busB.bus.busNonce);

    // Emit on A only.
    busA.bus.emit(makeEvent(1));

    // B should not have received it.
    // Use the tail/cursor invariant: B's nextCursor is untouched (starts at 1).
    const entryB = busB.bus.emit(makeEvent(2));
    expect(entryB.cursor).toBe(1);

    // A's counter advanced because A had one prior emit.
    const entryA = busA.bus.emit(makeEvent(3));
    expect(entryA.cursor).toBe(2);

    busA.release();
    busB.release();
  });
});
