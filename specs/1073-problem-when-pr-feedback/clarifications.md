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

**Answer**: **B — add `blocked:resolve-failed`**

A and C both leave `blocked:stuck-feedback-loop` on a cycle that is not stuck. The code work landed; only the thread bookkeeping failed. That is this issue's own complaint — the label naming the wrong cause — reapplied to a narrower case.

The test to use is what the operator *does* next. `blocked:stuck-feedback-loop` says "the fixer isn't making progress, find out why" — wrong, and it sends them reading fixer transcripts. A resolve-failure says "the code is fine, the GitHub side didn't take" — which points at thread state and API responses. Different remediation earns a different label.

C's log-line polish is worth doing regardless, but it does not substitute for the label. Labels gate re-dispatch and surface in cockpit; reading the distinguishing log line requires shelling into a worker container and knowing which one. Last night's `blocked:stuck-feedback-loop` incident on #1069 is the proof: the truth was in the worker log the whole time and was invisible until someone went looking with the right hypothesis.

The vocabulary cost is real — this is the fourth `blocked:*` after #1070 added three. If that is the concern, the answer is to make `blocked:*` a properly structured family with a documented taxonomy, not to keep overloading `stuck-feedback-loop` as the catch-all. Overloading is what produced both #1070 and this issue.

Accepting the SC-006 breach and the resulting `workflow-engine` minor bump: `label-definitions.ts` already gained three labels this week, so the machinery and the precedent exist.

---

### Q2: CLI commit policy scope
**Context**: The issue explicitly raises "worth auditing whether the CLI *should* be committing on its own here at all" (CL-2 / FR-012). If in scope, the fix would touch the fixer prompt and possibly the CLI's default commit behavior. If out of scope, the spec is a pure producer-side detection fix and the CLI/handler dual-commit invariant persists.

**Question**: Is auditing / changing the CLI-side commit policy in scope for #1073?

**Options**:
- A: Out of scope — file as follow-up. This spec stays a producer-side detection fix. CLI commit policy is a separate, larger decision (touches fixer prompt, may need workflow-engine changes). Ship #1073 as pure detection.
- B: In scope — bundle policy decision with detection fix. Larger diff, longer review cycle, more coupling; but eliminates the ambiguity permanently instead of leaving both handler and CLI able to commit.

**Answer**: **A — CLI commit policy out of scope**

The detection fix is correct regardless of how the policy question resolves. If the CLI stops committing, head-advance detection costs nothing and never fires. If it keeps committing, detection is essential. There is no version of the policy answer that makes this spec wrong, which is what makes A safe rather than merely convenient.

B also makes the diff substantially larger, and an oversized change is what trips the 20-minute fixer budget — the bug immediately next door in #1070. Ship the detection, file the policy audit as its own issue where it can get the design discussion it deserves.

---

### Q3: Log-line shape for self-commit success
**Context**: For the CLI-self-commit success log line shape (CL-3 / FR-007 / US3). The existing happy-path line is `'Successfully pushed changes to PR branch'` at `pr-feedback-handler.ts:503-506`. It fires only when `hasChanges && success` — so today it always names the handler as the committer. US3's acceptance criterion is that a reviewer distinguishes the CLI-self-commit case from the handler-commit case from logs alone.

**Question**: Which log structure best distinguishes a CLI-self-commit cycle from a handler-commit cycle?

**Options**:
- A: Distinct log line + extra `source` field. New message like `'CLI self-committed changes — proceeding to reply/resolve'` with `source: 'cli'` in payload. Handler-commit path gets `source: 'handler'` added to existing `'Successfully pushed...'` line. Grep-friendly + structured taxonomy.
- B: Same message + `source` field only. Preserve existing message; just add `source: 'cli' | 'handler'`. Minimal churn; existing log alerts / dashboards keep matching. But grepping for the CLI-specific case requires field-level filtering.
- C: Distinct log line only (no source field). New message text only, no structured field. Simpler payload but no machine-readable taxonomy — the `disposition:` field on the warn branches would be the only structured taxonomy.

**Answer**: **A — distinct message plus `source` on both paths**

B's argument is that preserving the existing message keeps log alerts and dashboards matching. That is already moot: #1070 split `'Successfully pushed changes to PR branch'` into two guarded branches, so that text moved this week regardless. There is no stable baseline left to preserve.

The important half of A is adding `source: 'handler'` to the *existing* line, not just `source: 'cli'` to the new one. A taxonomy that only tags one side of a binary is not a taxonomy — you can filter for CLI commits but cannot filter for handler commits, and "absence of the field" is not a queryable state once older log lines exist without it.

C gives no machine-readable field at all, leaving `disposition:` as the only structured handle, which is exactly the gap Q4 is trying to close.

---

### Q4: `disposition:` field value for CLI-self-commit
**Context**: For the `disposition:` field on the CLI-self-commit branch (CL-4 / SC-003 / FR-008). Existing values in the codebase: `'no-diff'`, `'push-failed'` (`pr-feedback-handler.ts:583`), `'timeout-no-progress'`, `'fixer-timeout'`, `'fixer-timeout-repeat'` (`:539, :554`). All are lowercase-hyphenated and cause-oriented. SC-003 grep target depends on this value being distinct and stable.

**Question**: Which string value should the CLI-self-commit branch use for its `disposition:` field?

**Options**:
- A: `'cli-self-committed'`. Named in the spec's SC-003. Cause-oriented (matches existing sibling values), unambiguous — clearly identifies the CLI as the commit source. Grep-friendly across the codebase.
- B: `'head-advanced'`. Symptom-oriented (matches the *detection mechanism*, not the *cause*). Slightly more general — would still apply if some future non-CLI mechanism advanced HEAD. Less descriptive of what actually happened.
- C: `'cli-committed'`. Shorter form of A. Drops the "self" qualifier. Slight ambiguity: could be misread as "the handler used the CLI to commit" rather than "the CLI committed on its own".

**Answer**: **A — `'cli-self-committed'`**

Matches the sibling convention — `no-diff`, `push-failed`, `timeout-no-progress`, `fixer-timeout` are all cause-oriented — and SC-003 already pins this exact string, so B would churn the spec for a case that is rare today.

**Load-bearing caveat for the implementation (recorded here because it is a real gap, not hypothetical).** The code *detects* "the branch head advanced". It *infers* "the CLI committed". Those are not the same proposition, and they come apart whenever something else advances the head mid-cycle — most plausibly a human pushing to the PR branch while a fixer round is running. In that case this disposition value states something false.

That inference gap is precisely what cost two wrong diagnoses on #1069: an absence of commits was read as "the fixer did nothing" when it had committed thirteen seconds earlier, and a clean-looking result was read as a token-scope failure when the push had succeeded. Both times the mechanism was observed correctly and the cause was assumed.

**Requirement for the implementation**: make the claim auditable rather than asserted — carry `preFixSha` and `postFixSha` (or their short forms) in the same log payload, so a reader can check the commit themselves instead of trusting the label. If the human-push case ever actually bites, the follow-up is either switching this value to `head-advanced` or adding a cheap authorship check on the new commit — but neither is worth building speculatively today.

