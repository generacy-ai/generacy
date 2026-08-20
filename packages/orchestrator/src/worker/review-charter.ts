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

import type { ReviewScope } from './handler-outcome.js';

export interface ReviewCharterInput {
  profile: 'standard' | 'verification';
  /** Relative sidecar path (agent's write target), e.g. `.generacy/review-findings-<id>.json`. */
  sidecarRelPath: string;
  blockingSeverity: 'critical' | 'major' | 'minor';
  round: number;
  /**
   * Resolution-scoped review window (#1131). When present, the charter names the
   * exact `baseSha..headSha` range as the review target instead of "the whole PR
   * diff". Absent ⇒ whole-PR review, byte-identical to pre-#1131.
   */
  diffWindow?: ReviewScope;
}

/**
 * Build the review charter prompt. Deterministic for a given input; performs no
 * I/O. The `verification` profile additionally instructs the agent to emit
 * "needs verification" findings for the `validate` phase to confirm.
 */
export function buildReviewCharter(input: ReviewCharterInput): string {
  const { profile, sidecarRelPath, blockingSeverity, round, diffWindow } = input;

  const lines: string[] = [];

  lines.push(`# Code review — round ${round}`);
  lines.push('');
  if (diffWindow) {
    // FR-002 (#1131) — resolution-scoped: name the exact base..head range.
    lines.push(
      'You are performing a correctness and regression review of a merge-conflict ' +
        `resolution. Inspect ONLY the diff in the range \`${diffWindow.baseSha}..${diffWindow.headSha}\` ` +
        '(the merge commit that resolved the conflict, relative to the pre-merge ' +
        'branch tip) for defects: logic errors, regressions, broken invariants, ' +
        'security issues, and incorrect handling of edge cases introduced by the ' +
        'resolution. Ignore files and changes outside this range.',
    );
  } else {
    lines.push(
      'You are performing a correctness and regression review of the changes on ' +
        'this pull request branch. Inspect the PR diff (the commits on this branch ' +
        'relative to its base) for defects: logic errors, regressions, broken ' +
        'invariants, security issues, and incorrect handling of edge cases.',
    );
  }
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
    // #1134 FR-001 — bugfix verification charter. Replace the generic
    // "needs verification" paragraph with four delineated bugfix questions.
    // Each concern the agent cannot confirm by static reading becomes its own
    // "needs verification" finding for the `validate` phase to confirm.
    lines.push('## Bugfix verification');
    lines.push('');
    lines.push(
      'This change is a bug fix. In addition to defects, interrogate the four ' +
        'questions below. Record each concern you cannot confirm by static ' +
        'reading alone as its own "needs verification" finding describing exactly ' +
        'what the `validate` phase must confirm.',
    );
    lines.push('');
    lines.push('### 1. Root cause vs symptom');
    lines.push('');
    lines.push(
      'Does the change fix the underlying cause of the bug, or does it only mask ' +
        'a symptom? A fix that suppresses the observable symptom without addressing ' +
        'the root cause is a finding.',
    );
    lines.push('');
    lines.push('### 2. Regression test present that fails without the fix');
    lines.push('');
    lines.push(
      'Is there a new or changed test that would fail on the base ref (without ' +
        'this change) and pass with it? The absence of such a regression test is a ' +
        'finding.',
    );
    lines.push('');
    lines.push('### 3. Scope creep');
    lines.push('');
    lines.push(
      'Does the diff include changes beyond what the fix strictly requires ' +
        '(unrelated refactors, formatting churn, or feature work)? Out-of-scope ' +
        'changes are a finding.',
    );
    lines.push('');
    lines.push('### 4. Regression risk in changed lines');
    lines.push('');
    lines.push(
      'Do the changed lines risk breaking adjacent or dependent behavior? Call out ' +
        'any such regression risk in the changed lines as a finding.',
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
