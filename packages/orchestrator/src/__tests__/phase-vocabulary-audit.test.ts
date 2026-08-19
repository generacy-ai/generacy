/**
 * FR-011 / SC-003 (#1121) — phase-vocabulary audit.
 *
 * The `WorkflowPhase` union is hand-duplicated across ~10 sites in 5 packages.
 * Only `PHASE_TO_STAGE` (a `Record<WorkflowPhase, StageType>`) is compiler-
 * exhaustive; every other site is a Zod enum, a literal union, an `as const`
 * array, or a `.strict()` key set that the compiler cannot cross-check. This
 * audit fails the moment one of those sites drifts out of sync with the
 * canonical union — specifically when `review` / `remediate` go missing from a
 * full-vocabulary site or leak into a sequence / intentional-subset site.
 *
 * Strategy (mirrors `label-protocol-audit.test.ts` / `phase-tracker-audit.test.ts`):
 *   - Runtime probes for sites reachable via exported values / Zod `.parse()`.
 *   - Targeted static source scans for local-const / type-only sites.
 *   - A LabelManager runtime probe + `WORKFLOW_LABELS` family check for labels.
 *
 * Site map is authoritative in `specs/1121-.../contracts/phase-vocabulary.md`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WORKFLOW_LABELS, type GitHubClient } from '@generacy-ai/workflow-engine';
import { WorkflowAgentEntriesSchema } from '@generacy-ai/config';
import { LabelManager } from '../worker/label-manager.js';
import type { Logger, WorkflowPhase } from '../worker/types.js';
import {
  PHASE_SEQUENCE,
  PHASE_TO_STAGE,
  getPhaseSequence,
} from '../worker/types.js';
import {
  GateDefinitionSchema,
  PhaseTimeoutOverridesSchema,
} from '../worker/config.js';
import { PauseContextSchema } from '../worker/pause-context.js';

const NEW_PHASES = ['review', 'remediate'] as const;

const HERE = dirname(fileURLToPath(import.meta.url));
const ORCH_SRC = join(HERE, '..');
const WFE_SRC = join(HERE, '../../../workflow-engine/src');
const GENERACY_SRC = join(HERE, '../../../generacy/src');
const PLUGIN_SRC = join(HERE, '../../../generacy-plugin-claude-code/src');

/**
 * Extract the set of quoted lowercase phase tokens from a source declaration.
 * `startAnchor` locates the declaration; the window runs to the first `endToken`
 * after it. Deliberately coarse — it captures every `'kebab'` literal in the
 * window, which is exactly the phase set for the array/union declarations we scan.
 */
function extractTokens(file: string, startAnchor: string, endToken: string): Set<string> {
  const content = readFileSync(file, 'utf-8');
  const start = content.indexOf(startAnchor);
  if (start === -1) throw new Error(`audit anchor not found: "${startAnchor}" in ${file}`);
  const rest = content.slice(start + startAnchor.length);
  const end = rest.indexOf(endToken);
  const slice = end === -1 ? rest : rest.slice(0, end);
  const tokens = new Set<string>();
  const re = /['"`]([a-z][a-z0-9-]*)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) tokens.add(m[1]!);
  return tokens;
}

describe('#1121 phase-vocabulary audit', () => {
  // A1 — canonical union contains both phases (via compiler-exhaustive stage map keys)
  it('A1: WorkflowPhase union includes review and remediate', () => {
    const unionValues = Object.keys(PHASE_TO_STAGE);
    for (const p of NEW_PHASES) expect(unionValues).toContain(p);
  });

  // A2 — sequence placement
  it('A2: PHASE_SEQUENCE places review directly between implement and validate, and excludes remediate', () => {
    const implIdx = PHASE_SEQUENCE.indexOf('implement');
    const validateIdx = PHASE_SEQUENCE.indexOf('validate');
    const reviewIdx = PHASE_SEQUENCE.indexOf('review');
    expect(reviewIdx).toBe(implIdx + 1);
    expect(reviewIdx).toBe(validateIdx - 1);
    expect(PHASE_SEQUENCE).not.toContain('remediate');
  });

  // A3 — per-workflow sequences
  it('A3: feature/bugfix sequences have review after implement; epic is unchanged; no sequence has remediate', () => {
    for (const wf of ['speckit-feature', 'speckit-bugfix']) {
      const seq = getPhaseSequence(wf);
      expect(seq[seq.indexOf('implement') + 1]).toBe('review');
      expect(seq).not.toContain('remediate');
    }
    expect(getPhaseSequence('speckit-epic')).toEqual(['specify', 'clarify', 'plan', 'tasks']);
    expect(getPhaseSequence('speckit-epic')).not.toContain('remediate');
  });

  // A4 — exhaustive stage map values
  it('A4: PHASE_TO_STAGE maps review and remediate to implementation', () => {
    expect(PHASE_TO_STAGE.review).toBe('implementation');
    expect(PHASE_TO_STAGE.remediate).toBe('implementation');
  });

  // A5 — full-vocabulary sites include both phases
  describe('A5: full-vocabulary sites include review and remediate', () => {
    it('#1 GateDefinitionSchema.phase enum accepts both', () => {
      for (const p of NEW_PHASES) {
        expect(() =>
          GateDefinitionSchema.parse({ phase: p, gateLabel: 'x', condition: 'always' }),
        ).not.toThrow();
      }
      // Introspection: the ZodEnum options enumerate both.
      const options = GateDefinitionSchema.shape.phase.options as readonly string[];
      for (const p of NEW_PHASES) expect(options).toContain(p);
    });

    it('#2 PhaseTimeoutOverridesSchema accepts both keys', () => {
      const parsed = PhaseTimeoutOverridesSchema.parse({ review: 60_000, remediate: 60_000 });
      expect(parsed.review).toBe(60_000);
      expect(parsed.remediate).toBe(60_000);
    });

    it('#3 config.ts phaseKeys const includes both', () => {
      const tokens = extractTokens(
        join(ORCH_SRC, 'worker/config.ts'),
        'const phaseKeys = [',
        ']',
      );
      for (const p of NEW_PHASES) expect(tokens).toContain(p);
    });

    it('#4 WorkflowPhaseSchema (via PauseContextSchema) accepts both', () => {
      for (const p of NEW_PHASES) {
        expect(() =>
          PauseContextSchema.parse({ phase: p, writtenAt: '2026-01-01T00:00:00Z', issueRef: 'o/r#1' }),
        ).not.toThrow();
      }
    });

    it('#5 loader.ts overridablePhases const includes both', () => {
      const tokens = extractTokens(
        join(ORCH_SRC, 'config/loader.ts'),
        'const overridablePhases = [',
        ']',
      );
      for (const p of NEW_PHASES) expect(tokens).toContain(p);
    });

    it('#6 template-schema phases object accepts both', () => {
      const parsed = WorkflowAgentEntriesSchema.parse({ phases: { review: {}, remediate: {} } });
      expect(parsed.phases?.review).toBeDefined();
      expect(parsed.phases?.remediate).toBeDefined();
    });

    it('#7 resume.ts KNOWN_PHASES const includes both', () => {
      const tokens = extractTokens(
        join(GENERACY_SRC, 'cli/commands/cockpit/resume.ts'),
        'KNOWN_PHASES: readonly WorkflowPhase[] = [',
        ']',
      );
      for (const p of NEW_PHASES) expect(tokens).toContain(p);
    });

    it('#8 CorePhase union in workflow-engine includes both', () => {
      const tokens = extractTokens(
        join(WFE_SRC, 'types/github.ts'),
        'export type CorePhase =',
        ';',
      );
      for (const p of NEW_PHASES) expect(tokens).toContain(p);
    });
  });

  // A6 — label families
  describe('A6: label families registered', () => {
    beforeEach(() => {
      LabelManager.resetEnsureCacheForTests();
    });

    it('LabelManager applies phase:review and completed:review during the sequence', async () => {
      const applied: string[] = [];
      const github = {
        getIssue: vi.fn().mockResolvedValue({ labels: [] }),
        addLabels: vi.fn().mockImplementation(async (_o, _r, _i, labels: string[]) => {
          for (const l of labels) applied.push(l);
        }),
        removeLabels: vi.fn().mockResolvedValue(undefined),
        listLabels: vi.fn().mockResolvedValue(WORKFLOW_LABELS),
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

      expect(applied).toContain('phase:review');
      expect(applied).toContain('completed:review');
      // Every applied label is registered.
      const registered = new Set(WORKFLOW_LABELS.map((l) => l.name));
      expect(applied.filter((l) => !registered.has(l))).toEqual([]);
    });

    it('WORKFLOW_LABELS carries all four families for both review and remediate', () => {
      const registered = new Set(WORKFLOW_LABELS.map((l) => l.name));
      for (const p of NEW_PHASES) {
        expect(registered).toContain(`phase:${p}`);
        expect(registered).toContain(`completed:${p}`);
        expect(registered).toContain(`failed:${p}`);
        expect(registered).toContain(`failed:${p}-repeated`);
      }
    });

    it('WORKFLOW_LABELS has no waiting-for gate label for review or remediate', () => {
      const registered = new Set(WORKFLOW_LABELS.map((l) => l.name));
      for (const p of NEW_PHASES) {
        expect(registered).not.toContain(`waiting-for:${p}`);
      }
    });
  });

  // A7 — intentional subsets documented (must NOT include the new phases)
  describe('A7: launcher PhaseIntent unions are intentional subsets', () => {
    /**
     * Documented exclusion set (D-3): these two `PhaseIntent['phase']` unions
     * enumerate *provider-launchable CLI phases* only. They already exclude
     * `validate`; `review`/`remediate` are stub-executed without a launcher and
     * MUST stay excluded. If a future edit adds them here, this assertion forces
     * a conscious update rather than a silent widening.
     */
    const SUBSET_SITES = [
      join(ORCH_SRC, 'launcher/types.ts'),
      join(PLUGIN_SRC, 'launch/types.ts'),
    ];

    for (const site of SUBSET_SITES) {
      it(`${site.includes('plugin') ? 'plugin' : 'orchestrator'} PhaseIntent excludes review/remediate but keeps the launchable subset`, () => {
        const tokens = extractTokens(site, 'Speckit phase to execute', ';');
        // Positive: the launchable subset is intact.
        for (const p of ['specify', 'clarify', 'plan', 'tasks', 'implement']) {
          expect(tokens).toContain(p);
        }
        // Negative: the new phases (and validate) are deliberately absent.
        for (const p of [...NEW_PHASES, 'validate']) {
          expect(tokens).not.toContain(p);
        }
      });
    }
  });
});
