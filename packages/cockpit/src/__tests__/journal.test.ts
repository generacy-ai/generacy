import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJournalLiveness } from '../journal.js';

const ISSUE = 12345;
const THRESHOLD_MIN = 15;
const NOW_ISO = '2026-06-29T20:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

function fixedNow(): () => Date {
  return () => new Date(NOW_MS);
}

function captureLogger(): {
  logger: { warn: (msg: string) => void };
  warnings: string[];
} {
  const warnings: string[] = [];
  return {
    logger: { warn: (msg) => warnings.push(msg) },
    warnings,
  };
}

async function writeJournal(cwd: string, contents: string): Promise<string> {
  const dir = join(cwd, 'specs', String(ISSUE));
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'conversation-log.jsonl');
  await writeFile(path, contents, 'utf-8');
  return path;
}

describe('readJournalLiveness', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'cockpit-journal-'));
  });

  afterEach(async () => {
    // Restore mode in case a permission-denied test was skipped mid-flight.
    try {
      await chmod(join(cwd, 'specs', String(ISSUE), 'conversation-log.jsonl'), 0o644);
    } catch {
      /* ignore */
    }
    await rm(cwd, { recursive: true, force: true });
  });

  it('missing file → { stuck:false, stuckReason:null, lastEntryAt:null } and no log', async () => {
    const { logger, warnings } = captureLogger();
    const result = await readJournalLiveness({
      issueNumber: ISSUE,
      thresholdMinutes: THRESHOLD_MIN,
      cwd,
      now: fixedNow(),
      logger,
    });
    expect(result).toEqual({ stuck: false, stuckReason: null, lastEntryAt: null });
    expect(warnings).toEqual([]);
  });

  it('file unreadable (EACCES) → no-journal + warn', async () => {
    if (process.getuid?.() === 0) {
      // root bypasses unix permission bits — skip.
      return;
    }
    const path = await writeJournal(cwd, `{"timestamp":"${NOW_ISO}"}\n`);
    await chmod(path, 0o000);
    const { logger, warnings } = captureLogger();
    const result = await readJournalLiveness({
      issueNumber: ISSUE,
      thresholdMinutes: THRESHOLD_MIN,
      cwd,
      now: fixedNow(),
      logger,
    });
    expect(result).toEqual({
      stuck: false,
      stuckReason: 'no-journal',
      lastEntryAt: null,
    });
    expect(warnings.length).toBe(1);
    await chmod(path, 0o644);
  });

  it('empty file → no-journal + warn', async () => {
    await writeJournal(cwd, '');
    const { logger, warnings } = captureLogger();
    const result = await readJournalLiveness({
      issueNumber: ISSUE,
      thresholdMinutes: THRESHOLD_MIN,
      cwd,
      now: fixedNow(),
      logger,
    });
    expect(result).toEqual({
      stuck: false,
      stuckReason: 'no-journal',
      lastEntryAt: null,
    });
    expect(warnings.length).toBe(1);
  });

  it('last 32 lines all unparsable → no-journal + warn', async () => {
    const lines = Array.from({ length: 40 }, () => 'not-json-{{').join('\n');
    await writeJournal(cwd, `${lines}\n`);
    const { logger, warnings } = captureLogger();
    const result = await readJournalLiveness({
      issueNumber: ISSUE,
      thresholdMinutes: THRESHOLD_MIN,
      cwd,
      now: fixedNow(),
      logger,
    });
    expect(result.stuckReason).toBe('no-journal');
    expect(result.stuck).toBe(false);
    expect(result.lastEntryAt).toBeNull();
    expect(warnings.length).toBe(1);
  });

  it('parsable entry missing timestamp → no-journal + warn', async () => {
    await writeJournal(cwd, `{"event":"x"}\n`);
    const { logger, warnings } = captureLogger();
    const result = await readJournalLiveness({
      issueNumber: ISSUE,
      thresholdMinutes: THRESHOLD_MIN,
      cwd,
      now: fixedNow(),
      logger,
    });
    expect(result.stuckReason).toBe('no-journal');
    expect(warnings.length).toBe(1);
  });

  it('parsable entry with invalid timestamp string → no-journal + warn', async () => {
    await writeJournal(cwd, `{"timestamp":"not-a-date"}\n`);
    const { logger, warnings } = captureLogger();
    const result = await readJournalLiveness({
      issueNumber: ISSUE,
      thresholdMinutes: THRESHOLD_MIN,
      cwd,
      now: fixedNow(),
      logger,
    });
    expect(result.stuckReason).toBe('no-journal');
    expect(warnings.length).toBe(1);
  });

  it('fresh entry (age < threshold) → stuck:false, stuckReason:null, lastEntryAt set', async () => {
    const fresh = new Date(NOW_MS - 5 * 60_000).toISOString();
    await writeJournal(cwd, `{"timestamp":"${fresh}"}\n`);
    const { logger, warnings } = captureLogger();
    const result = await readJournalLiveness({
      issueNumber: ISSUE,
      thresholdMinutes: THRESHOLD_MIN,
      cwd,
      now: fixedNow(),
      logger,
    });
    expect(result).toEqual({
      stuck: false,
      stuckReason: null,
      lastEntryAt: fresh,
    });
    expect(warnings).toEqual([]);
  });

  it('boundary entry (age == threshold exactly) → stuck:false', async () => {
    const boundary = new Date(NOW_MS - THRESHOLD_MIN * 60_000).toISOString();
    await writeJournal(cwd, `{"timestamp":"${boundary}"}\n`);
    const { logger, warnings } = captureLogger();
    const result = await readJournalLiveness({
      issueNumber: ISSUE,
      thresholdMinutes: THRESHOLD_MIN,
      cwd,
      now: fixedNow(),
      logger,
    });
    expect(result.stuck).toBe(false);
    expect(result.stuckReason).toBeNull();
    expect(result.lastEntryAt).toBe(boundary);
    expect(warnings).toEqual([]);
  });

  it('stale entry (age > threshold) → stuck:true, stuckReason:"stale"', async () => {
    const stale = new Date(NOW_MS - 60 * 60_000).toISOString();
    await writeJournal(cwd, `{"timestamp":"${stale}"}\n`);
    const { logger, warnings } = captureLogger();
    const result = await readJournalLiveness({
      issueNumber: ISSUE,
      thresholdMinutes: THRESHOLD_MIN,
      cwd,
      now: fixedNow(),
      logger,
    });
    expect(result).toEqual({
      stuck: true,
      stuckReason: 'stale',
      lastEntryAt: stale,
    });
    expect(warnings).toEqual([]);
  });

  it('future timestamp (negative age) → stuck:false defensively', async () => {
    const future = new Date(NOW_MS + 60 * 60_000).toISOString();
    await writeJournal(cwd, `{"timestamp":"${future}"}\n`);
    const { logger, warnings } = captureLogger();
    const result = await readJournalLiveness({
      issueNumber: ISSUE,
      thresholdMinutes: THRESHOLD_MIN,
      cwd,
      now: fixedNow(),
      logger,
    });
    expect(result).toEqual({
      stuck: false,
      stuckReason: null,
      lastEntryAt: future,
    });
    expect(warnings).toEqual([]);
  });

  it('walks backward past unparsable tail to find a parsable entry', async () => {
    const fresh = new Date(NOW_MS - 5 * 60_000).toISOString();
    const lines = [
      `{"timestamp":"${fresh}"}`,
      'corrupted-line-{',
      'another-bad-line',
      '',
    ];
    await writeJournal(cwd, lines.join('\n'));
    const { logger, warnings } = captureLogger();
    const result = await readJournalLiveness({
      issueNumber: ISSUE,
      thresholdMinutes: THRESHOLD_MIN,
      cwd,
      now: fixedNow(),
      logger,
    });
    expect(result.lastEntryAt).toBe(fresh);
    expect(result.stuck).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('never throws — bubbles all errors into result + warn', async () => {
    // Pass an issue number that resolves to a directory we don't have.
    const { logger } = captureLogger();
    await expect(
      readJournalLiveness({
        issueNumber: 9_999_999,
        thresholdMinutes: THRESHOLD_MIN,
        cwd,
        now: fixedNow(),
        logger,
      }),
    ).resolves.toEqual({ stuck: false, stuckReason: null, lastEntryAt: null });
  });
});
