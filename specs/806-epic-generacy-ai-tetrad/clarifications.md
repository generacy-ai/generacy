# Clarifications

## Batch 1 — 2026-07-06

### Q1: Checked item semantics
**Context**: The spec accepts both `- [ ]` and `- [x]` task-list markers under `### <phase>` headings (FR-001). GitHub conventionally uses `- [x]` to mean "already done". This determines whether closed/completed children are watched, shown in status, or enqueued.
**Question**: Should the resolver include `- [x]` (checked) refs in the resolved set for `watch`, `status`, and `queue`, or filter them out as already-done?
**Options**:
- A: Include both `- [ ]` and `- [x]` refs everywhere; downstream commands decide (uniform parsing).
- B: Include `- [ ]` only; `- [x]` refs are dropped by the resolver (checkbox is the "done" signal).
- C: Include both for `watch`/`status`; filter `- [x]` from `queue` (only unstarted work is enqueued).

**Answer**: *Pending*

### Q2: Duplicate refs across phases
**Context**: An `owner/repo#N` ref can appear under more than one `### <phase>` heading in a real epic body (e.g., a shared task listed under two phases). This affects the resolved set for `watch`/`status` (single issue) and `queue` (does it enqueue twice?).
**Question**: When the same `owner/repo#N` appears under multiple `### <phase>` headings, what is the correct behavior?
**Options**:
- A: De-duplicate globally — `watch`/`status` see one entry; `queue <phase>` still enqueues it if listed under the requested phase.
- B: Preserve per-heading membership — `queue <phase>` enqueues each occurrence separately if listed multiple times under the same heading.
- C: Reject the epic body as malformed (loud error) if any ref appears under more than one phase.

**Answer**: *Pending*

### Q3: Accepted ref shapes
**Context**: FR-001 specifies `owner/repo#N` task-list refs. Real epic bodies often use markdown links (`[owner/repo#N](https://github.com/owner/repo/issues/N)`), plain URLs, or same-repo shorthand (`#N`). Strict parsing risks missing valid refs; permissive parsing risks false positives.
**Question**: Which ref shapes must the parser accept for a task-list item to count as a resolved child?
**Options**:
- A: Bare `owner/repo#N` only (strict; matches spec wording literally).
- B: Bare `owner/repo#N` **and** markdown-linked variants that resolve to the same `owner/repo#N` (accept `[owner/repo#N](...)`, `[#N](https://github.com/owner/repo/issues/N)`, `https://github.com/owner/repo/issues/N`).
- C: All of B, plus same-repo `#N` shorthand (interpreted relative to the epic's own repo).

**Answer**: *Pending*

### Q4: Watch interval below-floor override
**Context**: FR-007 says the default watch interval is 30000 ms with a floor of 15000 ms and states that overrides below the floor are "clamped or rejected" — an unresolved either/or that affects both UX and testability.
**Question**: When a user passes a watch interval below the 15000 ms floor, what is the correct behavior?
**Options**:
- A: Silently clamp to 15000 ms and continue.
- B: Warn to stderr, clamp to 15000 ms, and continue.
- C: Reject with a non-zero exit and an error message stating the floor.

**Answer**: *Pending*

### Q5: Phase heading match rules
**Context**: `queue <epic-ref> <phase>` reads membership from the matching `### <phase>` heading (FR-005). Real headings often include extra text (e.g., `### S2 — v1-simplification` or `### S2: cleanup`). The match rule determines whether users must type the full heading text or a stable short name.
**Question**: How should the `<phase>` argument match a `### <phase>` heading in the body?
**Options**:
- A: Exact case-sensitive match of the entire heading text after `### ` (trimmed).
- B: Case-insensitive match of the entire heading text after `### ` (trimmed).
- C: Case-insensitive match of the first whitespace/punctuation-delimited token after `### ` (e.g., `S2` matches `### S2 — v1-simplification`); ambiguous matches (>1 heading matches the token) error loudly.

**Answer**: *Pending*
