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
    let hasSynthetic = false;
    for (const f of parts.openFindings) {
      const location = f.line != null ? `${f.file}:${f.line}` : f.file;
      lines.push('');
      if (f.synthetic !== undefined) {
        // Engine-synthesized, no path anchor: the `file` field holds the failing
        // validate command / the `(pr-review)` placeholder. Flag it so the agent
        // knows the "location" is not a file to open, and re-emits it verbatim.
        hasSynthetic = true;
        lines.push(`- [${f.severity}] ${f.title} (${location}) [synthetic: ${f.synthetic}]`);
      } else {
        lines.push(`- [${f.severity}] ${f.title} (${location})`);
      }
      lines.push(`  ${f.detail}`);
    }
    if (hasSynthetic) {
      lines.push('');
      lines.push(
        'Findings tagged `[synthetic: validate]` were synthesized by the engine from a ' +
          'failing `validate` run — their `file` is the validate command that failed, not ' +
          'a repository path. Findings tagged `[synthetic: external-body]` were seeded from ' +
          'a PR-level review comment with no file anchor — their `file` is the `(pr-review)` ' +
          'placeholder. For each, judge whether the changes since the last review address ' +
          'the failure or feedback described in its detail. If they do, re-emit the finding ' +
          'with the EXACT SAME `file` and `title` and `status: "resolved"`; if not, re-emit ' +
          'it with `status: "open"`.',
      );
    }
  }

  return lines.join('\n');
}
