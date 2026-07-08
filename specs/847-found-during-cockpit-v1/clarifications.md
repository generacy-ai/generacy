# Clarifications — #847

## Batch 1 — 2026-07-08

### Q1: Auto-degrade skip semantics (FR-001)
**Context**: The current default `preValidateCommand` is `pnpm install && pnpm -r --filter './packages/*' build` (`config.ts:59`). On single-package repos, the second half fails. FR-001 says the `-r --filter` half MUST only run when `packages/` exists — but it doesn't say what happens to the `pnpm install` half. That matters because `validateCommand` (e.g., `npm test && npm run build`) typically needs `node_modules`. Skipping install to be safe would then break validate on a fresh checkout for a different reason.

**Question**: When `packages/` is absent, what should the degraded `preValidateCommand` actually run?
**Options**:
- A: Run `pnpm install` only (drop just the `-r --filter … build` half). Single-package repos still get their dependencies installed; validate can run its tests/build against a populated `node_modules`.
- B: Skip the entire `preValidateCommand` (empty command → no install). Rely on `validateCommand` or the repo's own scripts to install if needed.
- C: Detect the repo's package manager (npm/yarn/pnpm/bun) from lockfile and run that manager's install. (Broader; probably out of scope per "Out of Scope" bullet #6.)
- D: Other (please specify).

**Answer**: *Pending*

---

### Q2: Evidence surface — same comment or sibling comment (FR-003, FR-006)
**Context**: FR-003 requires posting the failing command, exit code, and stderr tail to the GitHub issue. FR-006 says "whether the evidence lives in the stage comment or a dedicated error comment is an implementation choice, but the classification pipeline MUST NOT regress." The Assumptions section says the cockpit reads *stage comments* to classify `failed:*`. Both options are real trade-offs: appending to the stage comment keeps the classifier trivially happy but makes the comment grow unbounded across phase re-runs; a sibling comment keeps the stage comment clean but requires the cockpit classifier (or its future readers) to know where to look. This decision drives where `renderStageComment` changes vs. where a new writer lives.

**Question**: Where should the failure evidence block live?
**Options**:
- A: Append the evidence block inside the existing stage comment (edited by `StageCommentManager.updateStageComment`). One comment per issue, cleared/rewritten on retry. Cockpit classifier unchanged.
- B: Post a separate sibling comment tagged with an HTML marker (e.g. `<!-- generacy-stage:failure -->`) on every `status: 'error'` transition. Stage comment stays lean; a marker-tagged trail of failures accumulates over retries.
- C: Append inside the stage comment for the current failure, but move the previous failure's block to a rolling sibling comment on the next retry (hybrid — one "current" + one "history").
- D: Other (please specify).

**Answer**: *Pending*

---

### Q3: "packages/ directory exists" detection precision (FR-001)
**Context**: FR-001 keys the auto-degrade on whether a `packages/` directory exists at the workspace root. But `pnpm -r --filter './packages/*' build` also fails on a repo where `packages/` exists but is *empty* (or contains only non-workspace subdirs) — pnpm exits non-zero on zero matches. A naive `fs.existsSync('packages')` check would leave that failure mode intact. This matters for repos in transition (e.g. someone deleted their last package but kept the folder) or scaffolds that pre-create an empty `packages/`.

**Question**: What condition should trigger the monorepo build half?
**Options**:
- A: Directory presence only — `fs.existsSync('packages')`. Simplest; may still hit the "empty packages/" edge case.
- B: Directory contains at least one subdirectory with a `package.json` — a real workspace exists. Robust against the empty-folder case.
- C: Respect `pnpm-workspace.yaml` — run the monorepo half only if the file exists and includes `packages/*` (or an equivalent glob). Semantically correct but couples to a specific pnpm config file that not every monorepo uses.
- D: Other (please specify).

**Answer**: *Pending*

---

### Q4: Stderr-tail bounding interaction and truncation marker (FR-004)
**Context**: FR-004 says the tail is "at most ~30 lines AND a hard character cap (proposed: 4 KiB), whichever comes first." This is under-specified in two ways: (1) the order matters — "take last 30 lines, then cap the result to 4 KiB from the *start* of that slice" vs "cap raw output to last 4 KiB, then keep at most 30 lines from that" produce different tails when lines are long; (2) the truncation marker's exact wording and placement (top vs bottom of the block) affects both readability and any downstream parsers.

**Question**: How should the two bounds compose, and where does the truncation marker go?
**Options**:
- A: Take the last 30 lines of stderr, then if that string exceeds 4 KiB, truncate from the *beginning* (keep the newest bytes) and prepend `… truncated …\n`. Preserves the freshest failure output at the bottom.
- B: Take the last 4 KiB of stderr, then split into lines and keep the last 30. Marker line `… truncated (N bytes / M lines)` prepended.
- C: Take min(last 30 lines, last 4 KiB), whichever is *smaller*, prepended with `… truncated …` if any truncation occurred.
- D: Other (please specify).

**Answer**: *Pending*

---

### Q5: Timeout and abort evidence scope (FR-005)
**Context**: FR-005 says timeout and abort failures MUST surface their distinct top-level message (`Phase "…" timed out after Nms` / `Phase "…" was aborted`). But the FR-003 evidence block (command + exit code + stderr tail) is also expected on failures. For a timeout, "exit code" is not meaningful in the usual sense (the process was killed by us), and stderr may or may not be populated depending on how far the child got. It's ambiguous whether timeouts/aborts get the full evidence block, a stripped-down version, or just the top-line message.

**Question**: For timeout/abort failures, what evidence appears on the issue?
**Options**:
- A: Full block — top-line distinct message + failing command + a synthesized "exit code" (e.g. `killed (SIGTERM)` for timeouts, `aborted` for aborts) + stderr tail if any (may be empty).
- B: Top-line distinct message + failing command only. Skip exit code and stderr — they aren't semantically meaningful for a timeout/abort.
- C: Top-line distinct message only for aborts (operator-triggered, no diagnostic value); full block for timeouts (which represent a real hang worth debugging).
- D: Other (please specify).

**Answer**: *Pending*
