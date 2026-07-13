/**
 * SC-004 audit test (#879): asserts that after the PR-feedback migration
 * from `PhaseTracker.tryMarkProcessed` to `QueueManager.enqueueIfAbsent`,
 * neither the monitor nor the handler references `PhaseTracker`, and no
 * `DEDUP_PHASE` declaration remains anywhere under
 * `packages/orchestrator/src/**`.
 *
 * Patterned on `trust-predicate-audit.test.ts`.
 *
 * Deliberately does NOT match the string literal `'address-pr-feedback'`
 * — that legitimately survives as the queue command name in
 * `QueueItem.command`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const MONITOR_PATH = join(HERE, '../services/pr-feedback-monitor-service.ts');
const HANDLER_PATH = join(HERE, '../worker/pr-feedback-handler.ts');
const SRC_ROOT = join(HERE, '..');

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip the audit test itself + snapshots
      if (entry === '__snapshots__') continue;
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('#879 SC-004: PhaseTracker migration audit', () => {
  it('pr-feedback-monitor-service.ts does not reference PhaseTracker', () => {
    const src = readFileSync(MONITOR_PATH, 'utf-8');
    expect(src).not.toMatch(/PhaseTracker/);
  });

  it('pr-feedback-handler.ts does not reference PhaseTracker', () => {
    const src = readFileSync(HANDLER_PATH, 'utf-8');
    expect(src).not.toMatch(/PhaseTracker/);
  });

  it('no DEDUP_PHASE declaration remains under packages/orchestrator/src/**', () => {
    // We look for a *declaration* pattern, not just any use of the identifier:
    // `const DEDUP_PHASE = …` or `let DEDUP_PHASE = …`. This test file itself
    // legitimately mentions the identifier in prose, so we exclude it.
    const auditSelfPath = fileURLToPath(import.meta.url);
    const files = walkTsFiles(SRC_ROOT).filter((f) => f !== auditSelfPath);
    const declPattern = /\b(?:const|let|var)\s+DEDUP_PHASE\b/;

    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      if (declPattern.test(src)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});
