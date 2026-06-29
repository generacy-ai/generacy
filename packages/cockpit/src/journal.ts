import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  JournalLivenessResult,
  ReadJournalLivenessOptions,
} from './types.js';

const MAX_TAIL_LINES = 32;

const NO_JOURNAL: JournalLivenessResult = {
  stuck: false,
  stuckReason: 'no-journal',
  lastEntryAt: null,
};

const MISSING_FILE: JournalLivenessResult = {
  stuck: false,
  stuckReason: null,
  lastEntryAt: null,
};

function defaultLogger(): { warn: (msg: string) => void } {
  return { warn: (msg) => process.stderr.write(`${msg}\n`) };
}

function isErrnoException(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === code
  );
}

function parseTimestamp(line: string): { iso: string; ms: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object') return null;
  const ts = (parsed as { timestamp?: unknown }).timestamp;
  if (typeof ts !== 'string') return null;
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  return { iso: ts, ms };
}

export async function readJournalLiveness(
  options: ReadJournalLivenessOptions,
): Promise<JournalLivenessResult> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? ((): Date => new Date());
  const logger = options.logger ?? defaultLogger();
  const path = join(
    cwd,
    'specs',
    String(options.issueNumber),
    'conversation-log.jsonl',
  );

  try {
    await stat(path);
  } catch (err) {
    if (isErrnoException(err, 'ENOENT')) {
      return MISSING_FILE;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`cockpit: journal stat failed for ${path}: ${msg}`);
    return NO_JOURNAL;
  }

  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`cockpit: journal read failed for ${path}: ${msg}`);
    return NO_JOURNAL;
  }

  if (raw.length === 0) {
    logger.warn(`cockpit: journal empty at ${path}`);
    return NO_JOURNAL;
  }

  const lines = raw.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lines.length === 0) {
    logger.warn(`cockpit: journal empty at ${path}`);
    return NO_JOURNAL;
  }

  const start = Math.max(0, lines.length - MAX_TAIL_LINES);
  let parsed: { iso: string; ms: number } | null = null;
  for (let i = lines.length - 1; i >= start; i--) {
    const candidate = parseTimestamp(lines[i]!);
    if (candidate != null) {
      parsed = candidate;
      break;
    }
  }
  if (parsed == null) {
    logger.warn(
      `cockpit: journal at ${path} has no parsable timestamped entry in last ${MAX_TAIL_LINES} lines`,
    );
    return NO_JOURNAL;
  }

  const ageMs = now().getTime() - parsed.ms;
  if (ageMs < 0) {
    return { stuck: false, stuckReason: null, lastEntryAt: parsed.iso };
  }
  const stuck = ageMs > options.thresholdMinutes * 60_000;
  return {
    stuck,
    stuckReason: stuck ? 'stale' : null,
    lastEntryAt: parsed.iso,
  };
}
