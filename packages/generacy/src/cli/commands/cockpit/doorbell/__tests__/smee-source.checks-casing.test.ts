import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmeeDoorbellSource } from '../smee-source.js';
import type { CockpitStreamEvent } from '../../watch/stream-event.js';
import type { GhWrapper } from '@generacy-ai/cockpit';
import type { SnapshotMap } from '../../watch/snapshot.js';
import { snapshotKey } from '../../watch/snapshot.js';
import {
  FAKE_RESOLVED,
  checkRunFrame,
  fakePrSnapshot,
  issueFrame,
  setPrev,
  startFakeSmee,
  waitFor,
  type FakeServer,
} from './helpers/smee-harness.js';

// #1113 — Pin the read-through PrSnapshot cache path to `snapshotKey`. PR #1109
// (fix for #1106) lowercases `repo` inside `snapshotKey` at both write and read
// sites, so a write/read casing mismatch still hits the cache. These rows drive
// `processEventBlock` end-to-end with the write key and read payload in opposite
// casings; the read-mixed rows go red if `smee-source.ts:375`'s
// `snapshotKey(ev.repo, 'pr', ev.number)` is ever inlined as
// `` `${ev.repo}#pr#${ev.number}` `` (payload-canonical casing → cache miss →
// `checks: undefined`).
//
// Lives in a non-`*.integration.test.ts` file so it runs under `pnpm test` and
// therefore gates the speckit `validate` phase (#1115 review).

// Stub resolveEpic to return a fixed resolved epic — the smee source uses it
// at startup and on refresh. Module mocks are hoisted per-file by vitest and
// cannot be moved into the shared harness.
vi.mock('@generacy-ai/cockpit', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveEpic: vi.fn(async () => FAKE_RESOLVED),
  };
});

describe('#1113 read-through cache path — casing drift across snapshotKey', () => {
  let fake: FakeServer;

  beforeEach(async () => {
    fake = await startFakeSmee();
  });

  afterEach(async () => {
    await fake.close();
  });

  it('write-mixed × pr-checks: cached under O/R, payload o/r → checks=green', async () => {
    const events: CockpitStreamEvent[] = [];
    const source = new SmeeDoorbellSource({
      channelUrl: fake.url,
      epicRef: 'o/r#100',
      gh: {} as unknown as GhWrapper,
      logger: { warn: () => undefined, info: () => undefined },
      onEvent: async (ev) => {
        events.push(ev);
      },
      onReconnectAttempt: () => undefined,
      onReconnectSuccess: () => undefined,
      baseReconnectDelayMs: 10,
    });

    await source.start();
    const prev: SnapshotMap = new Map();
    prev.set(snapshotKey('O/R', 'pr', 42), fakePrSnapshot('O/R', 42, 'success'));
    setPrev(source, prev);

    await waitFor(() => fake.activeResponses.size > 0);
    fake.writeFrame(checkRunFrame({ prNumber: 42, repoOwner: 'o', repoName: 'r' }));
    await waitFor(() => events.length >= 1);

    const ev = events[0]!;
    expect(ev.type).toBe('issue-transition');
    if (ev.type === 'issue-transition') {
      expect(ev.event).toBe('pr-checks');
      expect(ev.checks).toBe('green');
    }

    await source.stop();
  }, 10_000);

  // SC-002 mutation-killer: write lowercase, read mixed. Inlining the line-375
  // key produces `'O/R#pr#42'`, which misses the lowercase-written cache entry.
  it('read-mixed × pr-checks: cached under o/r, payload O/R → checks=green', async () => {
    const events: CockpitStreamEvent[] = [];
    const source = new SmeeDoorbellSource({
      channelUrl: fake.url,
      epicRef: 'o/r#100',
      gh: {} as unknown as GhWrapper,
      logger: { warn: () => undefined, info: () => undefined },
      onEvent: async (ev) => {
        events.push(ev);
      },
      onReconnectAttempt: () => undefined,
      onReconnectSuccess: () => undefined,
      baseReconnectDelayMs: 10,
    });

    await source.start();
    const prev: SnapshotMap = new Map();
    prev.set(snapshotKey('o/r', 'pr', 42), fakePrSnapshot('o/r', 42, 'success'));
    setPrev(source, prev);

    await waitFor(() => fake.activeResponses.size > 0);
    fake.writeFrame(checkRunFrame({ prNumber: 42, repoOwner: 'O', repoName: 'R' }));
    await waitFor(() => events.length >= 1);

    const ev = events[0]!;
    expect(ev.type).toBe('issue-transition');
    if (ev.type === 'issue-transition') {
      expect(ev.event).toBe('pr-checks');
      expect(ev.checks).toBe('green');
    }

    await source.stop();
  }, 10_000);

  it('write-mixed × completed:validate: cached under O/R, payload o/r → checks=green', async () => {
    const events: CockpitStreamEvent[] = [];
    const source = new SmeeDoorbellSource({
      channelUrl: fake.url,
      epicRef: 'o/r#100',
      gh: {} as unknown as GhWrapper,
      logger: { warn: () => undefined, info: () => undefined },
      onEvent: async (ev) => {
        events.push(ev);
      },
      onReconnectAttempt: () => undefined,
      onReconnectSuccess: () => undefined,
      baseReconnectDelayMs: 10,
    });

    await source.start();
    const prev: SnapshotMap = new Map();
    prev.set(snapshotKey('O/R', 'pr', 42), fakePrSnapshot('O/R', 42, 'success'));
    setPrev(source, prev);

    await waitFor(() => fake.activeResponses.size > 0);
    fake.writeFrame(
      issueFrame('labeled', {
        number: 42,
        label: 'completed:validate',
        labels: ['completed:validate'],
        repoOwner: 'o',
        repoName: 'r',
      }),
    );
    await waitFor(() => events.length >= 1);

    const ev = events[0]!;
    expect(ev.type).toBe('issue-transition');
    if (ev.type === 'issue-transition') {
      expect(ev.event).toBe('label-change');
      expect(ev.sourceLabel).toBe('completed:validate');
      expect(ev.checks).toBe('green');
    }

    await source.stop();
  }, 10_000);

  // SC-002 mutation-killer (label-change branch): write lowercase, read mixed.
  it('read-mixed × completed:validate: cached under o/r, payload O/R → checks=green', async () => {
    const events: CockpitStreamEvent[] = [];
    const source = new SmeeDoorbellSource({
      channelUrl: fake.url,
      epicRef: 'o/r#100',
      gh: {} as unknown as GhWrapper,
      logger: { warn: () => undefined, info: () => undefined },
      onEvent: async (ev) => {
        events.push(ev);
      },
      onReconnectAttempt: () => undefined,
      onReconnectSuccess: () => undefined,
      baseReconnectDelayMs: 10,
    });

    await source.start();
    const prev: SnapshotMap = new Map();
    prev.set(snapshotKey('o/r', 'pr', 42), fakePrSnapshot('o/r', 42, 'success'));
    setPrev(source, prev);

    await waitFor(() => fake.activeResponses.size > 0);
    fake.writeFrame(
      issueFrame('labeled', {
        number: 42,
        label: 'completed:validate',
        labels: ['completed:validate'],
        repoOwner: 'O',
        repoName: 'R',
      }),
    );
    await waitFor(() => events.length >= 1);

    const ev = events[0]!;
    expect(ev.type).toBe('issue-transition');
    if (ev.type === 'issue-transition') {
      expect(ev.event).toBe('label-change');
      expect(ev.sourceLabel).toBe('completed:validate');
      expect(ev.checks).toBe('green');
    }

    await source.stop();
  }, 10_000);
});
