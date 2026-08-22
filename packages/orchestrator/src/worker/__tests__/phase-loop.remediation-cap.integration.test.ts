// #1168 (T041) — charter-contract test, reframed from the #1132 remediation-cap
// loop-composition suite (FR-009).
//
// US1's composed suite (`phase-loop.review-composed.integration.test.ts`) now
// owns the real composed-loop coverage: it drives the REAL review + remediate
// executors under PhaseLoop and asserts the #1128 remediation-cap gate composes
// with the counter-reset resume seam end-to-end. This file no longer re-drives
// the loop. It pins the two contracts the cap path is built on — the ones a loop
// test cannot see because they are string/data shapes, not observable
// side-effects:
//
//   1. The remediate CHARTER shape the executor hands the agent each attempt:
//      - names each open blocking finding with its location/title/detail,
//      - stamps the round + attempt (remediationCount) in the header,
//      - restricts the framing to `blockingSeverity` or higher, and
//      - forbids thread-resolution / ready-marking / GitHub-review posting
//        (verification is the next review round's job).
//   2. The `advanceArtifact` MERGE contract that makes the cap *reachable*:
//      - a persistently-unaddressed open blocking finding is carried forward
//        untouched every remediation round (anti-vanish) — this is precisely why
//        the verdict stays `changes-required` until the counter hits the cap, and
//      - a sub-blocking NEW finding raised on a round >= 2 remediation pass is
//        DROPPED (`filterNewFindings`), so it can never inflate the blocking set.
//
// Parameterized over both workflows (`speckit-feature`, `speckit-bugfix`) with the
// per-workflow default blockingSeverity (feature → `major`, bugfix → `critical`)
// so the drop threshold is asserted at each workflow's real bar.
import { describe, it, expect } from 'vitest';
import { buildRemediateCharter } from '../remediate-charter.js';
import { advanceArtifact, filterNewFindings } from '../review/findings-advance.js';
import type { ReviewArtifact, ReviewFinding, Severity } from '../review-artifact.js';
import { deriveFindingId } from '../review-artifact.js';
import type { ReviewDelta } from '../review/review-delta.js';

// feature holds to a stricter blocking bar than a targeted bugfix (#1161 D3).
const BLOCKING_SEVERITY: Record<string, Severity> = {
  'speckit-feature': 'major',
  'speckit-bugfix': 'critical',
};

// A sub-blocking severity for each workflow — one rank below its blocking bar —
// so the round >= 2 advisory-drop assertion exercises the real threshold.
const SUB_BLOCKING_SEVERITY: Record<string, Severity> = {
  'speckit-feature': 'minor', // below `major`
  'speckit-bugfix': 'major', // below `critical`
};

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  const file = overrides.file ?? 'src/cap.ts';
  const title = overrides.title ?? 'unresolved blocker';
  return {
    id: deriveFindingId(file, title),
    severity: 'critical',
    file,
    title,
    detail: 'must fix before ready',
    round: 1,
    status: 'open',
    ...overrides,
    // keep id derived from the effective file/title even when those are overridden
    ...(overrides.id ? { id: overrides.id } : { id: deriveFindingId(file, title) }),
  };
}

function artifact(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
    findings: [],
    verdict: 'changes-required',
    round: 1,
    lastReviewedCommitSha: 'LAST',
    remediationCount: 0,
    markedReadyByEngine: false,
    ...overrides,
  };
}

function delta(overrides: Partial<ReviewDelta> = {}): ReviewDelta {
  return {
    base: { source: 'last-reviewed', base: 'LAST', head: 'HEAD' },
    files: ['src/cap.ts'],
    round: 2,
    ...overrides,
  };
}

describe.each([['speckit-feature'], ['speckit-bugfix']])(
  'remediation cap — charter + merge contract (#1168 T041) [%s]',
  (workflowName) => {
    const blockingSeverity = BLOCKING_SEVERITY[workflowName]!;
    const subBlocking = SUB_BLOCKING_SEVERITY[workflowName]!;

    describe('remediate charter shape', () => {
      it('names each open blocking finding with its location/title/detail + round/attempt', () => {
        const findings: ReviewFinding[] = [
          finding({ file: 'src/cap.ts', line: 12, title: 'unresolved blocker', detail: 'must fix', severity: blockingSeverity }),
          finding({ file: 'src/other.ts', title: 'second blocker', detail: 'also fix', severity: blockingSeverity }),
        ];

        const charter = buildRemediateCharter({
          findings,
          round: 2,
          remediationCount: 1,
          blockingSeverity,
        });

        // header stamps the round + attempt (remediationCount).
        expect(charter).toContain('# Remediate review findings — round 2, attempt 1');
        expect(charter).toContain('## Findings to address');
        // framing restricted to the blocking bar or higher.
        expect(charter).toContain(`severity \`${blockingSeverity}\``);

        // finding 1 has a line → `file:line`; finding 2 has none → bare file.
        expect(charter).toContain('### Finding 1 — ' + blockingSeverity);
        expect(charter).toContain('- **Location:** `src/cap.ts:12`');
        expect(charter).toContain('- **Title:** unresolved blocker');
        expect(charter).toContain('- **Detail:** must fix');
        expect(charter).toContain('### Finding 2 — ' + blockingSeverity);
        expect(charter).toContain('- **Location:** `src/other.ts`');

        // verification is the NEXT review round's job — remediate never resolves
        // threads, marks ready, or posts a review.
        expect(charter).toContain('## What to do');
        expect(charter).toContain('Do NOT resolve');
        expect(charter).toContain('do NOT mark the pull request ready for review');
        expect(charter).toContain('do NOT');
        expect(charter).toContain('post a GitHub review');
      });

      it('a location with no line renders as a bare file path', () => {
        const charter = buildRemediateCharter({
          findings: [finding({ file: 'src/nolines.ts', line: undefined, severity: blockingSeverity })],
          round: 3,
          remediationCount: 2,
          blockingSeverity,
        });

        expect(charter).toContain('# Remediate review findings — round 3, attempt 2');
        expect(charter).toContain('- **Location:** `src/nolines.ts`');
        expect(charter).not.toContain('src/nolines.ts:');
      });

      it('an empty findings list still produces a well-formed charter', () => {
        const charter = buildRemediateCharter({
          findings: [],
          round: 2,
          remediationCount: 1,
          blockingSeverity,
        });

        expect(charter).toContain('## Findings to address');
        expect(charter).toContain('_(No open blocking findings were recorded.)_');
      });
    });

    describe('advanceArtifact merge contract (cap reachability)', () => {
      it('carries a persistently-unaddressed open blocker forward every remediation round (anti-vanish)', () => {
        // The blocker is in the delta each round but the stub remediation never
        // fixes it and the reviewer re-emits nothing addressed. It MUST survive so
        // the verdict stays `changes-required` and the counter can climb to the cap.
        const open = finding({ severity: blockingSeverity, round: 1, status: 'open' });
        let prior = artifact({ findings: [open], round: 1 });

        for (let round = 2; round <= 4; round++) {
          const merged = advanceArtifact(
            prior,
            delta({ files: [open.file], round }),
            [], // nothing addressed
            [], // no new findings
            blockingSeverity,
          );
          expect(merged).toHaveLength(1);
          expect(merged[0]!.id).toBe(open.id);
          expect(merged[0]!.status).toBe('open');
          prior = artifact({ findings: merged, round });
        }
      });

      it('drops a sub-blocking NEW finding raised on a round >= 2 remediation pass', () => {
        const prior = artifact({ findings: [], round: 1 });
        const advisory = finding({
          file: 'src/nit.ts',
          title: 'nit: naming',
          severity: subBlocking,
          round: 2,
          status: 'open',
        });
        const blocker = finding({
          file: 'src/regression.ts',
          title: 'introduced regression',
          severity: blockingSeverity,
          round: 2,
          status: 'open',
        });

        const merged = advanceArtifact(
          prior,
          delta({ files: ['src/nit.ts', 'src/regression.ts'], round: 2 }),
          [],
          [advisory, blocker],
          blockingSeverity,
        );

        const ids = merged.map((f) => f.id);
        expect(ids).toContain(blocker.id);
        expect(ids).not.toContain(advisory.id);
      });

      it('filterNewFindings keeps all findings on round 1 but drops sub-blocking on round >= 2', () => {
        const advisory = finding({ severity: subBlocking, round: 1 });
        const blocker = finding({
          file: 'src/b.ts',
          title: 'blocker',
          severity: blockingSeverity,
          round: 1,
        });

        expect(filterNewFindings([advisory, blocker], 1, blockingSeverity)).toHaveLength(2);

        const round2 = filterNewFindings(
          [
            { ...advisory, round: 2 },
            { ...blocker, round: 2 },
          ],
          2,
          blockingSeverity,
        );
        expect(round2).toHaveLength(1);
        expect(round2[0]!.severity).toBe(blockingSeverity);
      });
    });
  },
);
