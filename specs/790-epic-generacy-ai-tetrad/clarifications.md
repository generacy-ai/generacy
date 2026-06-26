# Clarifications

## Batch 1 — 2026-06-26

### Q1: Epic body parse grammar
**Context**: FR-005 + Assumptions describe the children-by-phase block as `### P<n> — <name>` headings with `- [ ] owner/repo#n — title` bullets, but real-world epic bodies vary (heading levels, separator chars, missing checkboxes, surrounding prose). The parser's tolerated grammar drives both `init` correctness and the SC-002 fixture diff.
**Question**: What is the exact accepted grammar for the children-by-phase section?
**Options**:
- A: Strict — heading must be `###`, phase id must match `P\d+`, issue lines must be `- [ ] owner/repo#n — <title>`. Anything else is a parse error.
- B: Lenient on heading level (`##`/`###`/`####` all accepted) and checkbox optional (`- owner/repo#n` works); phase id pattern is `P\d+` followed by any separator (`—`/`-`/`:`/whitespace) then a name; prose between items is silently skipped.
- C: Same as B, but also accept bare `owner/repo#n` without a title and treat each phase block's bullet list as the issue list (any non-bullet content ends the phase).

**Answer**: *Pending*

### Q2: Phase identity for `sync`
**Context**: Phases have no stable ID — only `name` (and optional `tier`). When `sync` re-reads the epic body it must match each parsed phase back to an entry in the on-disk manifest to diff its `issues[]`. The matching rule determines what happens when a phase is renamed in the body.
**Question**: How should `sync` match a phase parsed from the body to a phase in the manifest?
**Options**:
- A: Exact case-sensitive `name` match. A rename in the body is treated as remove+add.
- B: Match by the `P<n>` index parsed from the heading (e.g. `P3`), independent of the display name; the manifest's `name` is then updated in place if the body's name changed.
- C: Normalized `name` match (lowercased, whitespace-collapsed); rename within normalization is treated as same phase.

**Answer**: *Pending*

### Q3: `sync` behavior when phases (not issues) change
**Context**: FR-008 / US2's acceptance criteria only describe issue-level diffs. The spec doesn't say what happens when the epic body adds a new phase heading the manifest doesn't have, or drops one the manifest still lists. This is the difference between `sync` being a true mirror vs. an issue-only reconciler.
**Question**: When the epic body and on-disk manifest disagree at the phase level (new phase in body, or manifest phase no longer in body), what should `sync` do?
**Options**:
- A: Mirror — add new phases (with `tier` left unset, `issues[]` populated, `autonomy` untouched) and remove vanished phases entirely. Counted in the `+N -M` summary.
- B: Issue-only — leave the manifest's `phases[]` shape alone; only diff `issues[]` inside phases that exist in both. Print a warning for unmatched phases and exit 0.
- C: Strict — exit non-zero with a structured error directing the user to re-run `init` (or `init --force`) when phase shape diverges.

**Answer**: *Pending*

### Q4: `epic.plan` format and missing-Plan behavior
**Context**: FR-007 says `epic.plan` is recorded from a "Plan: ..." line in the epic body and "normalized to a repo-relative path". The reference in #790's body is `Plan: docs/epic-cockpit-plan.md in tetrad-development (P3 / G3.1)`. The schema (`epic.plan: z.string().min(1)`) requires a non-empty string, so missing-Plan must either error or be substituted.
**Question**: What exactly gets persisted as `epic.plan`, and what happens if no Plan line exists?
**Options**:
- A: Just the bare path — `docs/epic-cockpit-plan.md`. The `in <repo>` and trailing `(...)` are stripped. Missing Plan line → non-zero exit with structured error.
- B: Cross-repo qualified ref — `generacy-ai/tetrad-development:docs/epic-cockpit-plan.md` when the body says `in tetrad-development` (owner inferred from the epic ref). Missing Plan line → error.
- C: Same as A (bare path, stripped), but missing Plan line is non-fatal and `epic.plan` defaults to an empty-but-valid placeholder (e.g. the epic ref itself, like `generacy-ai/tetrad-development#85`).

**Answer**: *Pending*

### Q5: Slug collision and `--force` / `--slug` semantics
**Context**: FR-006 says slug conflicts "surface as an error unless `--force` or `--slug` is provided" but does not pin down what each flag does independently or together. Misreading this changes whether `init --force` clobbers an unrelated epic's manifest.
**Question**: What is the precise behavior of `--force` and `--slug` on `init`?
**Options**:
- A: `--force` overwrites the existing file at the derived `<slug>.yaml`. `--slug <s>` uses `<s>` instead of the derived slug; if `<s>.yaml` already exists, it still errors unless `--force` is also passed. Passing both → `--slug` picks the filename, `--force` allows overwrite.
- B: `--force` auto-appends a numeric suffix (`-2`, `-3`, …) until a free filename is found; never overwrites. `--slug <s>` overrides derivation; conflicts on the chosen slug still error.
- C: `--force` overwrites whatever the derived slug points at. `--slug <s>` is for renaming the canonical slug only — using `--slug` on a name that already exists is itself an error (forces the user to `--force`).

**Answer**: *Pending*
