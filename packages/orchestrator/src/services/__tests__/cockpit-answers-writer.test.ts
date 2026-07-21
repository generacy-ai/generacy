import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CockpitAnswersWriter,
  type CockpitAnswer,
} from '../cockpit-answers-writer.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeAnswer(deliveryId: string, extra: Record<string, unknown> = {}): CockpitAnswer {
  return {
    kind: 'gate-answer',
    deliveryId,
    gateId: 'g_test',
    generation: 0,
    answeredAt: '2026-07-21T15:04:11.100Z',
    answer: { choice: 'proceed' },
    ...extra,
  };
}

describe('CockpitAnswersWriter', () => {
  let tempDir: string;
  let answersPath: string;
  let writer: CockpitAnswersWriter | null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cockpit-answers-'));
    answersPath = join(tempDir, 'cockpit', 'answers.ndjson');
    writer = null;
  });

  afterEach(async () => {
    if (writer) {
      await writer.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('init() creates parent dir when missing and opens fresh file', async () => {
    writer = new CockpitAnswersWriter({
      path: answersPath,
      rotationBytes: 10_000,
      rotationKeep: 3,
      logger: silentLogger,
    });
    await writer.init();
    expect(existsSync(answersPath)).toBe(true);
    expect(writer.hasDelivered('unknown')).toBe(false);
  });

  it('init() populates dedup set from existing file', async () => {
    await fs.mkdir(join(tempDir, 'cockpit'), { recursive: true });
    const lines = [
      JSON.stringify(makeAnswer('dlv_1')),
      JSON.stringify(makeAnswer('dlv_2')),
      JSON.stringify(makeAnswer('dlv_3')),
    ];
    await fs.writeFile(answersPath, lines.join('\n') + '\n');

    writer = new CockpitAnswersWriter({
      path: answersPath,
      rotationBytes: 10_000,
      rotationKeep: 3,
      logger: silentLogger,
    });
    await writer.init();

    expect(writer.hasDelivered('dlv_1')).toBe(true);
    expect(writer.hasDelivered('dlv_2')).toBe(true);
    expect(writer.hasDelivered('dlv_3')).toBe(true);
    expect(writer.hasDelivered('dlv_4')).toBe(false);
  });

  it('init() tolerates malformed lines and continues', async () => {
    await fs.mkdir(join(tempDir, 'cockpit'), { recursive: true });
    const lines = [
      JSON.stringify(makeAnswer('dlv_1')),
      '{ this is not valid json',
      JSON.stringify(makeAnswer('dlv_2')),
      '',
      '   ',
    ];
    await fs.writeFile(answersPath, lines.join('\n') + '\n');

    writer = new CockpitAnswersWriter({
      path: answersPath,
      rotationBytes: 10_000,
      rotationKeep: 3,
      logger: silentLogger,
    });
    await writer.init();

    expect(writer.hasDelivered('dlv_1')).toBe(true);
    expect(writer.hasDelivered('dlv_2')).toBe(true);
  });

  it('append() writes exactly one line ending with \\n and dedups', async () => {
    writer = new CockpitAnswersWriter({
      path: answersPath,
      rotationBytes: 10_000,
      rotationKeep: 3,
      logger: silentLogger,
    });
    await writer.init();
    await writer.append(makeAnswer('dlv_a'));
    expect(writer.hasDelivered('dlv_a')).toBe(true);

    const contents = await fs.readFile(answersPath, 'utf8');
    const lines = contents.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(contents.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(lines[0]!) as CockpitAnswer;
    expect(parsed.deliveryId).toBe('dlv_a');
  });

  it('same deliveryId — second append inside mutex is a no-op and returns deduped:true', async () => {
    writer = new CockpitAnswersWriter({
      path: answersPath,
      rotationBytes: 10_000,
      rotationKeep: 3,
      logger: silentLogger,
    });
    await writer.init();
    const first = await writer.append(makeAnswer('dlv_dup'));
    const second = await writer.append(makeAnswer('dlv_dup'));
    expect(first).toEqual({ deduped: false });
    expect(second).toEqual({ deduped: true });
    expect(writer.hasDelivered('dlv_dup')).toBe(true);

    const contents = await fs.readFile(answersPath, 'utf8');
    const lines = contents.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
  });

  it('concurrent appends of same deliveryId write exactly once', async () => {
    writer = new CockpitAnswersWriter({
      path: answersPath,
      rotationBytes: 10_000,
      rotationKeep: 3,
      logger: silentLogger,
    });
    await writer.init();

    const results = await Promise.all([
      writer.append(makeAnswer('dlv_race')),
      writer.append(makeAnswer('dlv_race')),
      writer.append(makeAnswer('dlv_race')),
    ]);
    const dedupedCount = results.filter((r) => r.deduped).length;
    const appendedCount = results.filter((r) => !r.deduped).length;
    expect(appendedCount).toBe(1);
    expect(dedupedCount).toBe(2);

    const contents = await fs.readFile(answersPath, 'utf8');
    const lines = contents.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
  });

  it('rotates when threshold is crossed', async () => {
    writer = new CockpitAnswersWriter({
      path: answersPath,
      rotationBytes: 200,
      rotationKeep: 3,
      logger: silentLogger,
    });
    await writer.init();
    for (let i = 0; i < 10; i += 1) {
      await writer.append(makeAnswer(`dlv_${i}`));
    }
    expect(existsSync(`${answersPath}.1`)).toBe(true);
  });

  it('rotation retains exactly N siblings', async () => {
    writer = new CockpitAnswersWriter({
      path: answersPath,
      rotationBytes: 100,
      rotationKeep: 2,
      logger: silentLogger,
    });
    await writer.init();
    for (let i = 0; i < 30; i += 1) {
      await writer.append(makeAnswer(`dlv_${i}`));
    }
    expect(existsSync(`${answersPath}.1`)).toBe(true);
    expect(existsSync(`${answersPath}.2`)).toBe(true);
    expect(existsSync(`${answersPath}.3`)).toBe(false);
  });

  it('rotation with N=1 keeps only .1', async () => {
    writer = new CockpitAnswersWriter({
      path: answersPath,
      rotationBytes: 100,
      rotationKeep: 1,
      logger: silentLogger,
    });
    await writer.init();
    for (let i = 0; i < 20; i += 1) {
      await writer.append(makeAnswer(`dlv_${i}`));
    }
    expect(existsSync(`${answersPath}.1`)).toBe(true);
    expect(existsSync(`${answersPath}.2`)).toBe(false);
  });

  it('rotation displaces old .N by unlinking', async () => {
    writer = new CockpitAnswersWriter({
      path: answersPath,
      rotationBytes: 100,
      rotationKeep: 2,
      logger: silentLogger,
    });
    await writer.init();
    // Fill enough to force >2 rotations
    for (let i = 0; i < 20; i += 1) {
      await writer.append(makeAnswer(`dlv_${i}`));
    }
    // Only .1 and .2 should exist even after many rotations
    expect(existsSync(`${answersPath}.1`)).toBe(true);
    expect(existsSync(`${answersPath}.2`)).toBe(true);
    expect(existsSync(`${answersPath}.3`)).toBe(false);
  });

  it('concurrent appends serialize — line count + no truncation', async () => {
    writer = new CockpitAnswersWriter({
      path: answersPath,
      rotationBytes: 100_000,
      rotationKeep: 3,
      logger: silentLogger,
    });
    await writer.init();

    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        writer!.append(makeAnswer(`dlv_${i}`)),
      ),
    );

    const contents = await fs.readFile(answersPath, 'utf8');
    const lines = contents.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(N);
    for (const line of lines) {
      const parsed = JSON.parse(line) as CockpitAnswer;
      expect(typeof parsed.deliveryId).toBe('string');
      expect(parsed.deliveryId.startsWith('dlv_')).toBe(true);
    }
    // trailing newline
    expect(contents.endsWith('\n')).toBe(true);
  });

  it('markUnhealthy() causes append to reject', async () => {
    writer = new CockpitAnswersWriter({
      path: answersPath,
      rotationBytes: 10_000,
      rotationKeep: 3,
      logger: silentLogger,
    });
    await writer.init();
    writer.markUnhealthy();
    expect(writer.isHealthy()).toBe(false);
    await expect(writer.append(makeAnswer('dlv_x'))).rejects.toThrow();
  });
});
