import type { ReviewFinding } from '../review-artifact.js';

/**
 * Parts consumed by `buildVerificationPrompt` (FR-004).
 */
export interface VerificationPromptParts {
  /** stated explicitly in the output (SC-006) */
  round: number;
  /** enumerated verbatim in the output (SC-006) */
  openFindings: ReviewFinding[];
  /** charter selection originates in #1124 */
  charter: 'standard' | 'verification';
}

/**
 * FR-004 / SC-006: build the verification prompt string. The output MUST contain
 * the literal round number (e.g. `Round 2`), each open finding's `title` and
 * `detail` verbatim, and the verification-charter framing when
 * `parts.charter === 'verification'`.
 */
export function buildVerificationPrompt(parts: VerificationPromptParts): string {
  const lines: string[] = [];

  if (parts.charter === 'verification') {
    lines.push(
      'Verification pass — this is a re-review scoped to the delta since the last ' +
        'review plus the still-open findings below. Confirm each open finding is ' +
        'addressed. Do NOT raise new sub-blocking (advisory) findings; only report ' +
        'genuinely new blocking regressions.',
    );
  } else {
    lines.push('Standard review pass.');
  }

  lines.push('');
  lines.push(`Round ${parts.round}`);
  lines.push('');

  if (parts.openFindings.length === 0) {
    lines.push('Open findings: none.');
  } else {
    lines.push('Open findings to verify:');
    for (const f of parts.openFindings) {
      const location = f.line != null ? `${f.file}:${f.line}` : f.file;
      lines.push('');
      lines.push(`- [${f.severity}] ${f.title} (${location})`);
      lines.push(`  ${f.detail}`);
    }
  }

  return lines.join('\n');
}
