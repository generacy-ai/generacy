# Clarifications: PR-feedback handler mislabels a successful CLI self-commit cycle as no-diff

**Issue**: [generacy-ai/generacy#1073](https://github.com/generacy-ai/generacy/issues/1073)
**Branch**: `1073-problem-when-pr-feedback`

## Batch 1 — 2026-07-29

Source: `spec.md` §Open Clarifications (CL-1 through CL-4). Each question below maps to a spec-declared `[NEEDS CLARIFICATION]` marker or `Open Clarifications` entry.

### Q1: US4 label vocabulary
**Context**: For the "head advanced but reply/resolve failed" case (US4 / CL-1 / FR-013). The existing happy-path already has a `resolveSuccesses === 0` branch at `pr-feedback-handler.ts:625-633` that applies `blocked:stuck-feedback-loop` with a distinct warn line (`'commit pushed but resolve batch had zero successes'`). The question is whether that log-level distinction is sufficient, or whether operators need machine-distinguishable label vocabulary. This affects `SC-006` (zero workflow-engine changes) and the changeset bump level.

**Question**: For the "head advanced but reply/resolve failed" case, should this fix reuse the existing `resolveSuccesses === 0` branch (log-only distinction) or introduce new label vocabulary to make the case machine-distinguishable?

**Options**:
- A: Reuse existing branch (log-only). US4 passes via the existing path. No new label. Zero workflow-engine change (SC-006 preserved). Distinction lives in logs, not labels.
- B: Add new label (e.g. `blocked:resolve-failed`). New label vocabulary in workflow-engine (minor bump). Machine-distinguishable in cockpit UI + label queries. Adds surface area, but "head advanced" is a strictly-better-than-stuck situation and mislabeling it as "stuck" repeats the exact complaint (wrong cause named) that motivated #1073.
- C: Keep the existing branch AND change its log line. Reuse the branch but update the message to reference the CLI-self-commit source when applicable (e.g. `'CLI self-committed but thread resolve failed'`). No new label. Small log-line polish to aid triage.

**Answer**: *Pending*

---

### Q2: CLI commit policy scope
**Context**: The issue explicitly raises "worth auditing whether the CLI *should* be committing on its own here at all" (CL-2 / FR-012). If in scope, the fix would touch the fixer prompt and possibly the CLI's default commit behavior. If out of scope, the spec is a pure producer-side detection fix and the CLI/handler dual-commit invariant persists.

**Question**: Is auditing / changing the CLI-side commit policy in scope for #1073?

**Options**:
- A: Out of scope — file as follow-up. This spec stays a producer-side detection fix. CLI commit policy is a separate, larger decision (touches fixer prompt, may need workflow-engine changes). Ship #1073 as pure detection.
- B: In scope — bundle policy decision with detection fix. Larger diff, longer review cycle, more coupling; but eliminates the ambiguity permanently instead of leaving both handler and CLI able to commit.

**Answer**: *Pending*

---

### Q3: Log-line shape for self-commit success
**Context**: For the CLI-self-commit success log line shape (CL-3 / FR-007 / US3). The existing happy-path line is `'Successfully pushed changes to PR branch'` at `pr-feedback-handler.ts:503-506`. It fires only when `hasChanges && success` — so today it always names the handler as the committer. US3's acceptance criterion is that a reviewer distinguishes the CLI-self-commit case from the handler-commit case from logs alone.

**Question**: Which log structure best distinguishes a CLI-self-commit cycle from a handler-commit cycle?

**Options**:
- A: Distinct log line + extra `source` field. New message like `'CLI self-committed changes — proceeding to reply/resolve'` with `source: 'cli'` in payload. Handler-commit path gets `source: 'handler'` added to existing `'Successfully pushed...'` line. Grep-friendly + structured taxonomy.
- B: Same message + `source` field only. Preserve existing message; just add `source: 'cli' | 'handler'`. Minimal churn; existing log alerts / dashboards keep matching. But grepping for the CLI-specific case requires field-level filtering.
- C: Distinct log line only (no source field). New message text only, no structured field. Simpler payload but no machine-readable taxonomy — the `disposition:` field on the warn branches would be the only structured taxonomy.

**Answer**: *Pending*

---

### Q4: `disposition:` field value for CLI-self-commit
**Context**: For the `disposition:` field on the CLI-self-commit branch (CL-4 / SC-003 / FR-008). Existing values in the codebase: `'no-diff'`, `'push-failed'` (`pr-feedback-handler.ts:583`), `'timeout-no-progress'`, `'fixer-timeout'`, `'fixer-timeout-repeat'` (`:539, :554`). All are lowercase-hyphenated and cause-oriented. SC-003 grep target depends on this value being distinct and stable.

**Question**: Which string value should the CLI-self-commit branch use for its `disposition:` field?

**Options**:
- A: `'cli-self-committed'`. Named in the spec's SC-003. Cause-oriented (matches existing sibling values), unambiguous — clearly identifies the CLI as the commit source. Grep-friendly across the codebase.
- B: `'head-advanced'`. Symptom-oriented (matches the *detection mechanism*, not the *cause*). Slightly more general — would still apply if some future non-CLI mechanism advanced HEAD. Less descriptive of what actually happened.
- C: `'cli-committed'`. Shorter form of A. Drops the "self" qualifier. Slight ambiguity: could be misread as "the handler used the CLI to commit" rather than "the CLI committed on its own".
