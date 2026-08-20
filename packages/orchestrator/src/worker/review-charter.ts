/**
 * Review charter builder (#1124 Decision 1, FR-002/003/004/005).
 *
 * Pure, deterministic string builder. The engine constructs the review charter
 * in-process (selected by `review.profile`) and passes it as the CLI prompt via
 * the new `review` launch intent (Q4→B — no `/speckit:review` slash command).
 *
 * The charter directs a correctness/regression review of the PR diff and
 * instructs the agent to write structured findings to a known sidecar path. The
 * engine — not the agent — owns the verdict, so the charter never asks the agent
 * to decide `clean` vs `changes-required`; it asks only for findings.
 */

export interface ReviewCharterInput {
  profile: 'standard' | 'verification';
  /** Relative sidecar path (agent's write target), e.g. `.generacy/review-findings-<id>.json`. */
  sidecarRelPath: string;
  blockingSeverity: 'critical' | 'major' | 'minor';
  round: number;
}

/**
 * Build the review charter prompt. Deterministic for a given input; performs no
 * I/O. The `verification` profile additionally instructs the agent to emit
 * "needs verification" findings for the `validate` phase to confirm.
 */
export function buildReviewCharter(input: ReviewCharterInput): string {
  const { profile, sidecarRelPath, blockingSeverity, round } = input;

  const lines: string[] = [];

  lines.push(`# Code review — round ${round}`);
  lines.push('');
  lines.push(
    'You are performing a correctness and regression review of the changes on ' +
      'this pull request branch. Inspect the PR diff (the commits on this branch ' +
      'relative to its base) for defects: logic errors, regressions, broken ' +
      'invariants, security issues, and incorrect handling of edge cases.',
  );
  lines.push('');

  // FR-003 — explicit prohibition on running tests or builds.
  lines.push('## Do NOT run tests or builds');
  lines.push('');
  lines.push(
    'This is a static review. Do NOT run the test suite, do NOT run any build, ' +
      'and do NOT execute the code. Verification by execution happens in a later ' +
      'phase. Read the diff and reason about correctness directly.',
  );
  lines.push('');

  // FR-004 → US3 — flag an implausibly empty/trivial diff.
  lines.push('## Empty or trivial diff');
  lines.push('');
  lines.push(
    'If the diff is empty, or is implausibly small or trivial relative to what ' +
      `the issue asks for, record that as a finding at severity \`${blockingSeverity}\` ` +
      'or higher (an empty diff means the implementation did not happen and the ' +
      'change must not pass review).',
  );
  lines.push('');

  if (profile === 'verification') {
    lines.push('## Verification findings');
    lines.push('');
    lines.push(
      'In addition to defects, emit "needs verification" findings: concrete ' +
        'behaviors or claims in this change that you cannot confirm by static ' +
        'reading alone and that the `validate` phase must confirm. Record each as ' +
        'its own finding describing exactly what must be verified.',
    );
    lines.push('');
  }

  // FR-005 — name the sidecar write target and describe the ReviewFinding[] shape.
  lines.push('## Write your findings');
  lines.push('');
  lines.push(
    `Write your findings as a JSON file at the path \`${sidecarRelPath}\` ` +
      '(relative to the repository root). The file must contain a single JSON ' +
      'object with a `findings` array. Each element of `findings` is an object ' +
      'with these fields:',
  );
  lines.push('');
  lines.push('- `severity`: one of `"critical"`, `"major"`, `"minor"`.');
  lines.push('- `file`: repository-relative path the finding concerns.');
  lines.push('- `line`: (optional) 1-based line number the finding anchors to.');
  lines.push('- `title`: a short one-line summary of the problem.');
  lines.push('- `detail`: a full explanation of the problem.');
  lines.push(`- \`round\`: the review round number (${round}).`);
  lines.push('- `status`: `"open"` for a new/unresolved finding.');
  lines.push('');
  lines.push(
    'Emit an empty `findings` array if you find no problems. Do NOT include a ' +
      'verdict field — the engine computes the verdict from your findings. Write ' +
      'the file even when there are no findings.',
  );
  lines.push('');
  lines.push(
    'Example:\n' +
      '```json\n' +
      '{\n' +
      '  "findings": [\n' +
      '    {\n' +
      '      "severity": "critical",\n' +
      '      "file": "src/foo.ts",\n' +
      '      "line": 42,\n' +
      '      "title": "Null dereference on empty input",\n' +
      '      "detail": "When `items` is empty, `items[0]` is accessed without a guard.",\n' +
      `      "round": ${round},\n` +
      '      "status": "open"\n' +
      '    }\n' +
      '  ]\n' +
      '}\n' +
      '```',
  );

  return lines.join('\n');
}
