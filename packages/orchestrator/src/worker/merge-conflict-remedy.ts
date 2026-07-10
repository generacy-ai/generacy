/**
 * Ship 1 template constant for the self-describing merge-conflicts pause
 * remedy (#898 FR-011 / FR-012 / FR-014).
 *
 * When #864's pre-phase base-merge detects a conflict and pauses the workflow,
 * the stage comment on the issue must render the three-step manual remedy
 * verbatim, listing the conflicted paths and warning that advancing without
 * resolving will re-pause.
 *
 * The template uses `<branch>`, `<base>`, and `<owner>/<repo>#<issue>`
 * placeholders. `phase-loop.ts` substitutes these at build time before passing
 * the payload to `stageCommentManager.updateStageComment`, keeping the
 * renderer content-agnostic.
 *
 * Ship 1 remains permanently load-bearing after Ship 2's handler lands: when
 * the handler's one autonomous attempt fails with
 * `blocked:stuck-merge-conflicts`, the operator escalation path is exactly
 * this remedy text.
 */

/**
 * Literal-string-typed template for the manual-remedy payload. The literal
 * string types make the constant test-provable (see
 * `__tests__/merge-conflict-remedy.test.ts`).
 */
export interface MergeConflictRemedy {
  /**
   * Verbatim three-step remedy per FR-011. Ordered.
   * The stage-comment renderer prints each as a numbered list item.
   */
  steps: [
    'Check out `<branch>`, merge `origin/<base>`, resolve conflicts, commit, push.',
    'Run `generacy cockpit advance <issue-ref> --gate merge-conflicts`.',
    'Phase re-runs; pre-merge now succeeds; phase proceeds.',
  ];
  /**
   * Callout warning per FR-011 last line.
   * The renderer prints this as a bold callout under the numbered list.
   */
  warning: 'Advancing without resolving first will re-pause with the same conflict.';
}

export const MERGE_CONFLICT_REMEDY: MergeConflictRemedy = {
  steps: [
    'Check out `<branch>`, merge `origin/<base>`, resolve conflicts, commit, push.',
    'Run `generacy cockpit advance <issue-ref> --gate merge-conflicts`.',
    'Phase re-runs; pre-merge now succeeds; phase proceeds.',
  ],
  warning: 'Advancing without resolving first will re-pause with the same conflict.',
};
