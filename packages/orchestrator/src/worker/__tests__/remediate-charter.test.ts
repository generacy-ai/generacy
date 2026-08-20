// #1128 — remediation charter builder (pure, findings-only prompt shape).
import { describe, it, expect } from 'vitest';
import { buildRemediateCharter } from '../remediate-charter.js';
import type { ReviewFinding } from '../review-artifact.js';

const CRITICAL: ReviewFinding = {
  severity: 'critical',
  file: 'src/a.ts',
  line: 42,
  title: 'Null deref on empty input',
  detail: 'Guard the array access before indexing.',
  round: 1,
  status: 'open',
};

const MAJOR_NO_LINE: ReviewFinding = {
  severity: 'major',
  file: 'src/b.ts',
  title: 'Unhandled rejection',
  detail: 'Await the promise or attach a catch.',
  round: 1,
  status: 'open',
};

describe('#1128 — buildRemediateCharter', () => {
  it('renders each finding with severity, location, title, and detail', () => {
    const charter = buildRemediateCharter({
      findings: [CRITICAL, MAJOR_NO_LINE],
      round: 2,
      remediationCount: 1,
      blockingSeverity: 'major',
    });

    expect(charter).toContain('## Findings to address');
    // Severity + location (file:line when present).
    expect(charter).toContain('### Finding 1 — critical');
    expect(charter).toContain('`src/a.ts:42`');
    expect(charter).toContain('Null deref on empty input');
    expect(charter).toContain('Guard the array access before indexing.');
    // Location falls back to bare file when line is absent.
    expect(charter).toContain('### Finding 2 — major');
    expect(charter).toContain('`src/b.ts`');
    expect(charter).not.toContain('src/b.ts:');
  });

  it('surfaces round + attempt context in the title', () => {
    const charter = buildRemediateCharter({
      findings: [CRITICAL],
      round: 3,
      remediationCount: 2,
      blockingSeverity: 'critical',
    });
    expect(charter).toContain('round 3');
    expect(charter).toContain('attempt 2');
  });

  it('forbids resolving threads, marking ready, and posting a review', () => {
    const charter = buildRemediateCharter({
      findings: [CRITICAL],
      round: 1,
      remediationCount: 0,
      blockingSeverity: 'critical',
    });
    expect(charter).toMatch(/do NOT resolve/i);
    expect(charter).toMatch(/do NOT mark the pull request ready/i);
    expect(charter).toMatch(/do NOT post a GitHub review/i);
    expect(charter).toMatch(/next review round/i);
  });

  it('renders a placeholder when there are no open blocking findings', () => {
    const charter = buildRemediateCharter({
      findings: [],
      round: 1,
      remediationCount: 0,
      blockingSeverity: 'minor',
    });
    expect(charter).toContain('## Findings to address');
    expect(charter).toContain('No open blocking findings');
  });

  it('leaves the findings section extensible for a future validate-evidence section (#1129)', () => {
    const charter = buildRemediateCharter({
      findings: [CRITICAL],
      round: 1,
      remediationCount: 0,
      blockingSeverity: 'critical',
    });
    // The findings section precedes the closing "What to do" section, so #1129
    // can append a "Validate failures to fix" block between them without
    // restructuring the existing headings.
    const findingsIdx = charter.indexOf('## Findings to address');
    const whatToDoIdx = charter.indexOf('## What to do');
    expect(findingsIdx).toBeGreaterThanOrEqual(0);
    expect(whatToDoIdx).toBeGreaterThan(findingsIdx);
  });

  it('is deterministic for a given input', () => {
    const input = {
      findings: [CRITICAL, MAJOR_NO_LINE],
      round: 2,
      remediationCount: 1,
      blockingSeverity: 'major' as const,
    };
    expect(buildRemediateCharter(input)).toBe(buildRemediateCharter(input));
  });
});
