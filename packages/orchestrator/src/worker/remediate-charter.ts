/**
 * Remediation charter builder (#1128, FR-002).
 *
 * Pure, deterministic string builder. The engine constructs the remediation
 * charter in-process and passes it as the CLI prompt via the `remediate` launch
 * intent (mirrors the review charter — no `/speckit:remediate` slash command).
 *
 * The charter directs the agent to make the code changes that resolve the open
 * blocking findings surfaced by the review phase. It deliberately does NOT ask
 * the agent to resolve review threads or mark the PR ready — verification
 * happens in the next review round (the engine recomputes the verdict).
 *
 * Structure is findings-only for now; a "Validate failures to fix" section is
 * reserved for #1129 and can be appended without restructuring (Q2=A).
 */
import type { ReviewFinding } from './review-artifact.js';

export interface RemediateCharterInput {
  /** Open blocking findings only (status `open`, severity >= blockingSeverity). */
  findings: ReviewFinding[];
  /** Current review round (for context). */
  round: number;
  /** Attempt N — remediation-loop counter, for the agent's awareness. */
  remediationCount: number;
  blockingSeverity: 'critical' | 'major' | 'minor';
}

/**
 * Build the remediation charter prompt. Deterministic for a given input;
 * performs no I/O.
 */
export function buildRemediateCharter(input: RemediateCharterInput): string {
  const { findings, round, remediationCount, blockingSeverity } = input;

  const lines: string[] = [];

  lines.push(`# Remediate review findings — round ${round}, attempt ${remediationCount}`);
  lines.push('');
  lines.push(
    'A code review of this pull request branch found blocking problems. Your job ' +
      'is to make the code changes that fix them. Address every finding below ' +
      `(each is at severity \`${blockingSeverity}\` or higher).`,
  );
  lines.push('');

  // Findings-only section. #1129 appends a "Validate failures to fix" section
  // after this block without restructuring (Q2=A).
  lines.push('## Findings to address');
  lines.push('');

  if (findings.length === 0) {
    lines.push('_(No open blocking findings were recorded.)_');
  } else {
    findings.forEach((finding, index) => {
      const location = finding.line !== undefined ? `${finding.file}:${finding.line}` : finding.file;
      lines.push(`### Finding ${index + 1} — ${finding.severity}`);
      lines.push('');
      lines.push(`- **Location:** \`${location}\``);
      lines.push(`- **Title:** ${finding.title}`);
      lines.push(`- **Detail:** ${finding.detail}`);
      lines.push('');
    });
  }

  lines.push('## What to do');
  lines.push('');
  lines.push(
    'Make the code changes needed to resolve the findings above. Do NOT resolve ' +
      'review threads, do NOT mark the pull request ready for review, and do NOT ' +
      'post a GitHub review — verification happens automatically in the next review ' +
      'round, which will re-inspect the diff and recompute the verdict.',
  );

  return lines.join('\n');
}
