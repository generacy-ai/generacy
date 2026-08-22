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
  /**
   * Convergence verification pass (#1126, activated #1161). Set ONLY on round
   * >= 2, when a prior engine artifact exists. Carries the
   * `buildVerificationPrompt` output (the still-open findings framing) plus the
   * delta window the re-review is scoped to. When present, the charter is
   * delta-scoped and verification-framed: it names ONLY the changed files since
   * the last reviewed commit, enumerates the still-open findings to confirm, and
   * restricts NEW findings to `blockingSeverity` or higher. Absent ⇒ round-1
   * whole-PR review (data-model "Round-1 special case").
   */
  verification?: {
    /** `buildVerificationPrompt` output — the still-open-findings framing. */
    prompt: string;
    /** Changed files since `lastReviewedCommitSha` (the delta window). */
    deltaFiles: string[];
  };
}

/**
 * Build the review charter prompt. Deterministic for a given input; performs no
 * I/O. The `verification` profile additionally instructs the agent to emit
 * "needs verification" findings for the `validate` phase to confirm.
 */
export function buildReviewCharter(input: ReviewCharterInput): string {
  const { profile, sidecarRelPath, blockingSeverity, round, diffWindow, verification } = input;

  const lines: string[] = [];

  lines.push(`# Code review — round ${round}`);
  lines.push('');
  if (verification) {
    // #1126 (activated #1161) — convergence verification pass (round >= 2).
    // Delta-scoped: name ONLY the files changed since the last reviewed commit,
    // then embed the still-open-findings framing produced by
    // `buildVerificationPrompt`. New findings are restricted to blocking
    // severity below (the verification pass must not raise fresh advisory noise).
    lines.push(
      'You are performing a VERIFICATION re-review of changes made since the ' +
        'previous review round. Inspect ONLY the delta below — the files changed ' +
        'since the last reviewed commit — for defects: logic errors, regressions, ' +
        'broken invariants, security issues, and incorrect handling of edge cases. ' +
        'Ignore files and changes outside this delta.',
    );
    lines.push('');
    if (verification.deltaFiles.length === 0) {
      lines.push('Delta since last review: no files changed.');
    } else {
      lines.push('Files changed since the last reviewed commit:');
      lines.push('');
      for (const file of verification.deltaFiles) {
        lines.push(`- ${file}`);
      }
    }
    lines.push('');
    lines.push(verification.prompt);
  } else if (diffWindow) {
    if (diffWindow.conflictedPaths && diffWindow.conflictedPaths.length > 0) {
      // FR-003 (#1164) — conflicted-path allowlist. The raw `baseSha..headSha`
      // parent-1 diff also contains everything the merged-in base branch brought
      // along; scope the review to the files that actually had conflict markers.
      lines.push(
        'You are performing a correctness and regression review of a merge-conflict ' +
          'resolution. Inspect ONLY these conflicted paths — the files that had ' +
          'conflict markers the resolution had to reconcile — for defects: logic ' +
          'errors, regressions, broken invariants, security issues, and incorrect ' +
          'handling of edge cases introduced by the resolution. Ignore all other ' +
          'files, including changes brought in from the merged-in base branch.',
      );
      lines.push('');
      lines.push('Conflicted paths:');
      lines.push('');
      for (const path of diffWindow.conflictedPaths) {
        lines.push(`- ${path}`);
      }
    } else {
      // FR-002 (#1131) — resolution-scoped: name the exact base..head range.
      lines.push(
        'You are performing a correctness and regression review of a merge-conflict ' +
          `resolution. Inspect ONLY the diff in the range \`${diffWindow.baseSha}..${diffWindow.headSha}\` ` +
          '(the merge commit that resolved the conflict, relative to the pre-merge ' +
          'branch tip) for defects: logic errors, regressions, broken invariants, ' +
          'security issues, and incorrect handling of edge cases introduced by the ' +
          'resolution. Ignore files and changes outside this range.',
      );
    }
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

  if (verification) {
    // #1126 (activated #1161) — resolution is EVIDENCE-BASED, not omission-based.
    // The engine matches a re-emitted finding to the prior one by a deterministic
    // id derived from `(file, title)`, and marks it resolved ONLY when the agent
    // emits it again with `status: "resolved"` AND its file is in the delta. A
    // finding the agent simply drops is carried forward as still-open
    // (anti-vanish) — so silence never closes a finding.
    lines.push('## Confirming an addressed finding');
    lines.push('');
    lines.push(
      'For every still-open finding listed above that the delta fully addresses, ' +
        're-emit it in your findings file with the EXACT SAME `file` and `title` as ' +
        'above and `status: "resolved"`. Matching on `file` + `title` is how the ' +
        'engine ties your confirmation to the original finding, so do not paraphrase ' +
        'either. A finding you simply omit is treated as STILL OPEN, not resolved — ' +
        'when in doubt, re-emit it with `status: "open"`.',
    );
    lines.push('');
    // The verification pass must not raise fresh advisory noise; only genuine new
    // blocking regressions are admissible. The engine drops sub-blocking new
    // findings anyway (`filterNewFindings`), so tell the agent up front.
    lines.push('## New findings on a verification pass');
    lines.push('');
    lines.push(
      'Only raise ' +
        `a NEW finding when it is a genuine regression at severity \`${blockingSeverity}\` ` +
        'or higher introduced by the delta. Give it `status: "open"`. Do NOT raise ' +
        'new sub-blocking (advisory) findings on this pass.',
    );
    lines.push('');
  } else if (!diffWindow) {
    // FR-004 → US3 (#1164) — flag an implausibly empty/trivial diff ONLY on the
    // round-1 whole-PR review. A resolution-scoped (`diffWindow`) review over a
    // small-but-valid conflict resolution must not be flagged as trivial.
    lines.push('## Empty or trivial diff');
    lines.push('');
    lines.push(
      'If the diff is empty, or is implausibly small or trivial relative to what ' +
        `the issue asks for, record that as a finding at severity \`${blockingSeverity}\` ` +
        'or higher (an empty diff means the implementation did not happen and the ' +
        'change must not pass review).',
    );
    lines.push('');
  }

  if (!verification && profile === 'verification') {
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
  lines.push(
    '- `status`: `"open"` for a new/unresolved finding, or `"resolved"` when ' +
      'you are confirming (on a verification pass) that a previously-open ' +
      'finding is now addressed.',
  );
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
