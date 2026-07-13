/**
 * FR-007 (#889) — hybrid audit: every label symbol the orchestrator can apply
 * must be registered in `WORKFLOW_LABELS`.
 *
 * (a) Load-bearing static scan: walks `packages/orchestrator/src/**` and
 *     `packages/workflow-engine/src/**` for string literals matching the
 *     protocol-label shape, unions all matches, and asserts the difference
 *     against `WORKFLOW_LABELS` is empty.
 * (b) Secondary runtime probe: drives `LabelManager` through every retry site
 *     with a mock `GitHubClient`, captures every `addLabels` invocation, and
 *     asserts every captured label is in `WORKFLOW_LABELS`. Simultaneously
 *     asserts `listLabels` is called exactly once across the sequence, proving
 *     the FR-002 memoization.
 *
 * Patterned on `phase-tracker-audit.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WORKFLOW_LABELS, type GitHubClient } from '@generacy-ai/workflow-engine';
import { LabelManager } from '../worker/label-manager.js';
import type { Logger, WorkflowPhase } from '../worker/types.js';
import { PHASE_SEQUENCE } from '../worker/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORCH_SRC = join(HERE, '..');
const WFE_SRC = join(HERE, '../../../workflow-engine/src');

/**
 * Curated exceptions — legitimate literals that match the shape but are NOT
 * GitHub protocol labels. Extend with justification comments.
 */
const AUDIT_EXCLUSIONS = new Set<string>([
  // SSE agent-connection lifecycle events (packages/orchestrator/src/sse/events.ts)
  'agent:connected',
  'agent:disconnected',
  'agent:status',
  // workflow-engine phase-lifecycle event names (packages/workflow-engine/src/types/events.ts)
  'phase:start',
  'phase:complete',
  'phase:error',
]);

/**
 * Regex tuned to the protocol label grammar:
 *   `<prefix>:<kebab-lowercase>`
 * where <prefix> is one of the five known prefixes. Bounded on both sides by
 * a quote so accidental substrings in prose or comments do not match.
 */
const LABEL_LITERAL = /(['"`])(phase|completed|waiting-for|failed|agent):([a-z0-9-]+)\1/g;

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === '__snapshots__' || entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('FR-007: label protocol audit', () => {
  it('every protocol label literal in orchestrator + workflow-engine is registered in WORKFLOW_LABELS', () => {
    const files = [...walkTsFiles(ORCH_SRC), ...walkTsFiles(WFE_SRC)];
    const discovered = new Set<string>();

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      let m: RegExpExecArray | null;
      LABEL_LITERAL.lastIndex = 0;
      while ((m = LABEL_LITERAL.exec(content)) !== null) {
        const symbol = `${m[2]}:${m[3]}`;
        if (!AUDIT_EXCLUSIONS.has(symbol)) {
          discovered.add(symbol);
        }
      }
    }

    const registered = new Set(WORKFLOW_LABELS.map((l) => l.name));
    const unregistered = [...discovered].filter((s) => !registered.has(s));

    // Sort for deterministic failure output
    unregistered.sort();
    expect(unregistered).toEqual([]);
  });
});

describe('FR-007: runtime-registry probe on LabelManager retry sites', () => {
  beforeEach(() => {
    LabelManager.resetEnsureCacheForTests();
  });

  it('every label applied by every retry site is registered, and ensureRepoLabelsExist runs exactly once', async () => {
    const listLabelsCalls: number[] = [];
    const applied: string[] = [];
    const github = {
      getIssue: vi.fn().mockResolvedValue({ labels: [] }),
      addLabels: vi.fn().mockImplementation(async (_o, _r, _i, labels: string[]) => {
        for (const l of labels) applied.push(l);
      }),
      removeLabels: vi.fn().mockResolvedValue(undefined),
      listLabels: vi.fn().mockImplementation(async () => {
        listLabelsCalls.push(1);
        return WORKFLOW_LABELS;
      }),
      createLabel: vi.fn().mockResolvedValue(undefined),
    };
    const logger: Logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => logger,
    };

    const lm = new LabelManager(github as unknown as GitHubClient, 'o', 'r', 1, logger);

    for (const phase of PHASE_SEQUENCE as WorkflowPhase[]) {
      await lm.onPhaseStart(phase);
      await lm.onPhaseComplete(phase);
    }
    await lm.onGateHit('implement', 'waiting-for:merge-conflicts');
    await lm.onGateHit('specify', 'waiting-for:spec-review');
    await lm.onGateHit('clarify', 'waiting-for:clarification');
    await lm.onGateHit('plan', 'waiting-for:plan-review');
    await lm.onGateHit('tasks', 'waiting-for:tasks-review');
    await lm.onError('implement');
    await lm.onWorkflowComplete();

    const registered = new Set(WORKFLOW_LABELS.map((l) => l.name));
    const unregistered = applied.filter((l) => !registered.has(l));
    expect(unregistered).toEqual([]);

    // FR-002: memoized ensure-pass ran exactly once across the whole sequence
    expect(listLabelsCalls).toHaveLength(1);
  });
});
