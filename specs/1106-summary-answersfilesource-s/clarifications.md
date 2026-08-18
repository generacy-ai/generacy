# Clarifications: Cockpit doorbell — case-insensitive gateKey/epicRef repo-scope filter (#1106)

## Batch 1 — 2026-08-18T22:25:23Z

### Q1: Fix strategy — case-insensitive compare vs. removing the repo-scope filter
**Context**: Spec Assumption 2 and FR-003 admit two fixes and defer the choice to `/plan`, but the choice changes observable behavior (US2) and scope: the minimal fix keeps foreign-repo answers dropped, while removing the filter over-delivers them (neutralized downstream by `gateId` matching) and *incidentally* fixes the documented cross-repo `epicRef` limitation on `AnswersFileSourceOptions`. Removing the filter also means every foreign-epic answer line wakes the bound `/cockpit:auto` session (a no-op wake, but a wake) on clusters sharing one `answers.ndjson` across epics.
**Question**: Which fix should this issue ship?
**Options**:
- A: Minimal — make the owner/repo comparison case-insensitive (`.toLowerCase()` both sides) at `answers-file-source.ts:645-653`. Foreign-repo answers keep today's dropped-and-logged disposition. Cross-repo `epicRef` limitation stays documented, out of scope.
- B: Remove the repo-scope filter entirely — all schema-valid answers are emitted; downstream `gateId` matching neutralizes non-matching ones. Fixes the documented cross-repo limitation incidentally; accepts no-op wake-ups from foreign-epic answers on shared clusters.
- C: A now, plus file a follow-up issue for B (filter removal / cross-repo support) so the limitation is tracked but not bundled into this bugfix.

**Answer**: *Pending*

### Q2: Scope — single comparison site or doorbell-path casing audit
**Context**: Spec Assumption 4 pins the fix location to the one comparison in `answers-file-source.ts`, and the spec asserts "no case normalization exists anywhere in the doorbell or cockpit CLI path". If any other owner/repo string comparison in the doorbell/cockpit consumer path is case-sensitive (e.g. in gate-event routing or ref matching), the same class of silent drop could persist after this fix. Auditing widens the PR; not auditing risks a sibling bug surviving.
**Question**: Should the implementation fix only the known comparison site, or also audit the doorbell/cockpit consumer path for other case-sensitive owner/repo comparisons and fix any found in the same PR?
**Options**:
- A: Fix only the known site in `answers-file-source.ts`; treat any other site discovered later as a new issue.
- B: Audit the doorbell/cockpit consumer path during `/plan`; fix any additional casing-sensitive owner/repo comparisons found, in this same PR, with matching regression tests.

**Answer**: *Pending*
