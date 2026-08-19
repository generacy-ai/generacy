/**
 * US2 (#1123) — pause/resume survives the two new phases (FR-005, SC-004).
 *
 * Two independent proofs, both against the **real** shipped machinery (no
 * product behavior is added here):
 *
 *  1. The pause-context sidecar (`writePauseContext` / `readPauseContext`,
 *     companion #3 — `pause-context.ts` `WorkflowPhaseSchema`) round-trips a
 *     `review` pause back to `review` and a `remediate` pause back to
 *     `remediate` (Q3=A — remediate re-enters the remediation step, NOT review).
 *     The test fails if the z.enum omits either phase.
 *
 *  2. `LabelManager` applies then clears the `phase:*` / `waiting-for:*` /
 *     `agent:*` label families **symmetrically** across a pause→resume cycle for
 *     both phases, leaving 0 residual pause/phase labels (SC-004). Assertions are
 *     **name-agnostic** per PD-4 — they assert the families round-trip to empty,
 *     not specific label strings.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writePauseContext,
  readPauseContext,
  PauseContextSchema,
} from '../pause-context.js';
import { LabelManager } from '../label-manager.js';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { Logger, WorkflowPhase } from '../types.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

// ---------------------------------------------------------------------------
// Stateful in-memory GitHub label store — mutates a Set so a full pause→resume
// cycle can be replayed through the real LabelManager and the residual label
// state asserted at the end.
// ---------------------------------------------------------------------------
function createLabelStore() {
  const labels = new Set<string>();
  const github = {
    getIssue: async () => ({ labels: [...labels].map((name) => ({ name })) }),
    addLabels: async (_o: string, _r: string, _n: number, add: string[]) => {
      for (const l of add) labels.add(l);
    },
    removeLabels: async (_o: string, _r: string, _n: number, rm: string[]) => {
      for (const l of rm) labels.delete(l);
    },
    listLabels: async () => [],
    createLabel: async () => {},
  } as unknown as GitHubClient;
  return { labels, github };
}

const PAUSE_FAMILIES = ['phase:', 'waiting-for:', 'agent:'];
function pauseFamilyLabels(labels: Set<string>): string[] {
  return [...labels].filter((l) => PAUSE_FAMILIES.some((p) => l.startsWith(p)));
}

describe('US2 — pause/resume survives review and remediate', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'pause-resume-1123-'));
    LabelManager.resetEnsureCacheForTests();
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  // T012 — review pause round-trips to review (autonomous phase, sidecar path).
  it('round-trips a review pause back to review via the pause-context sidecar (FR-005, SC-004)', async () => {
    const workflowId = 'speckit-feature-1123';
    await writePauseContext(workdir, workflowId, {
      phase: 'review',
      writtenAt: new Date().toISOString(),
      issueRef: 'test/repo#1123',
    });

    const readback = await readPauseContext(workdir, workflowId);

    expect(readback).not.toBeNull();
    expect(readback!.phase).toBe('review');
  });

  // T013 — remediate pause round-trips to remediate, NOT review (Q3=A).
  it('round-trips a remediate pause back to remediate (not review) (FR-005, SC-004, Q3=A)', async () => {
    const workflowId = 'speckit-feature-1123';
    await writePauseContext(workdir, workflowId, {
      phase: 'remediate',
      writtenAt: new Date().toISOString(),
      issueRef: 'test/repo#1123',
    });

    const readback = await readPauseContext(workdir, workflowId);

    expect(readback).not.toBeNull();
    expect(readback!.phase).toBe('remediate');
    // Explicit anti-drift: remediate must NOT resolve back to review.
    expect(readback!.phase).not.toBe('review');
  });

  // T012/T013 (schema guard) — both new phases are accepted by the sidecar's
  // WorkflowPhaseSchema. Fails if the z.enum omits either phase.
  it('PauseContextSchema accepts both review and remediate as valid phases', () => {
    for (const phase of ['review', 'remediate'] as WorkflowPhase[]) {
      const parsed = PauseContextSchema.safeParse({
        phase,
        writtenAt: new Date().toISOString(),
        issueRef: 'test/repo#1123',
      });
      expect(parsed.success).toBe(true);
    }
  });

  // T014 — label families apply then clear symmetrically across a pause→resume
  // cycle for BOTH phases. Name-agnostic: assert the pause/phase families
  // round-trip to empty, not specific label strings.
  it.each(['review', 'remediate'] as WorkflowPhase[])(
    'applies then clears phase:/waiting-for:/agent: labels symmetrically across pause→resume for %s (SC-004)',
    async (phase) => {
      const { labels, github } = createLabelStore();
      const lm = new LabelManager(github, 'test', 'repo', 1123, mockLogger);
      const gateLabel = `waiting-for:${phase}-review`;

      // --- pre-condition: no pause/phase labels ---
      expect(pauseFamilyLabels(labels)).toEqual([]);

      // --- run: phase starts ---
      await lm.onPhaseStart(phase);
      expect(labels.has(`phase:${phase}`)).toBe(true);

      // --- pause: gate hit applies waiting-for:* + agent:paused, clears phase:* ---
      await lm.onGateHit(phase, gateLabel);
      const paused = pauseFamilyLabels(labels);
      expect(paused).toContain(gateLabel);
      expect(paused).toContain('agent:paused');
      expect(labels.has(`phase:${phase}`)).toBe(false);

      // Snapshot exactly what the pause added (name-agnostic clear on resume).
      const pauseAdded = pauseFamilyLabels(labels);

      // --- resume: monitor clears the pause labels, phase re-enters ---
      await github.removeLabels('test', 'repo', 1123, pauseAdded);
      await lm.onPhaseStart(phase);

      // --- complete: phase:* → completed:* ---
      await lm.onPhaseComplete(phase);

      // --- post-condition: 0 residual pause/phase labels (symmetric) ---
      expect(pauseFamilyLabels(labels)).toEqual([]);
      // The only surviving marker is the completion label — not a pause family.
      expect(labels.has(`completed:${phase}`)).toBe(true);
    },
  );
});
