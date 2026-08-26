---
'@generacy-ai/orchestrator': patch
---

Bugfix profiles: verification review charter, targeted validate with
diff-classification guards, and an opt-in fail-then-pass regression proof.

The `verification` review profile now interrogates four bugfix questions (root
cause vs symptom, regression test present, scope creep, regression risk). For
`speckit-bugfix` runs the validate phase classifies the diff and rewrites the
built-in default validate command to the pnpm `...[origin/<base>]` filter form
(with docs-only, test-only, single-package, and full-fallback safety guards),
logging the decision; custom validate commands run verbatim. An opt-in
`failThenPass` check proves changed test files fail on the base ref and pass on
the branch, using an isolated git worktree. Internal worker behavior only — no
new public API and no workflow-engine label vocabulary.
