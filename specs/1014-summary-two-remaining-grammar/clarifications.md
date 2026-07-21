# Clarifications

## Batch 1 — 2026-07-21

### Q1: Non-phase-shaped `####+` behavior
**Context**: FR-002 is marked `[NEEDS CLARIFICATION]`. Today, every `####+` heading unconditionally closes the current phase (`parse-epic-body.ts:80–88`). H4 promotion only rescues phase-shaped H4s; the spec explicitly leaves the fate of non-phase-shaped H4s (`#### Notes`, `#### Follow-ups`) to this phase. Impacts fixture pinning, whether a phase can carry sub-sections, and whether refs that appear after a non-phase-shaped H4 inside a `###` phase are attributed to that phase or fall to `__adhoc__`.
**Question**: When a `####+` heading is **not** phase-shaped (fails `PHASE_SHAPED_H4_RE`) and appears inside an open phase, what should the parser do?
**Options**:
- A: Transparent — do not close the current phase. Subsequent task-list refs continue to attribute to the enclosing phase. Enables sub-section headings inside phases.
- B: Preserve today's behavior — close the current phase. Refs after the H4 fall to `__adhoc__` unless a new `###` (or phase-shaped `####`) opens next.
- C: Transparent only when inside an open `###` phase; close when at top level. Preserves top-level "sections" semantics but allows in-phase sub-sections.

**Answer**: *Pending*

### Q2: `detectShape` for H4-only-phased bodies
**Context**: FR-011 is marked `[NEEDS CLARIFICATION]`. `scope/writer.ts`'s `detectShape` currently treats `### ` as the sole phased-shape marker; `scope add` uses this to decide ad-hoc-insertion placement. If H4 promotion ships and an epic body uses only `#### Phase N` headers, `detectShape` will still classify it as unphased and `scope add` will insert refs at the wrong location (or into the wrong section).
**Question**: Should `detectShape` also treat a body whose only phase headings are phase-shaped `####` as `phased`?
**Options**:
- A: Yes — mirror the parser: any phase-shaped heading (H3 or phase-shaped H4) makes the body `phased`. Keeps writer and parser consistent; `scope add` places into H4-authored bodies correctly.
- B: No — `phased` remains `###`-only. H4-authored bodies fall back to the flat/unphased writer path. Simpler, but re-introduces an author-visible inconsistency between parser and writer.
- C: Yes, but also auto-normalize on `scope add` — the writer bumps the body's `####` phase headings to `###` when it edits. Aggressive; changes author-provided formatting on write.

**Answer**: *Pending*

### Q3: `defaultRepo` option shape
**Context**: FR-003 defers the shape of the new `parseEpicBody` option to plan phase, but the shape leaks into every call site of a public export in `@generacy-ai/cockpit` — `resolveEpic`'s pass-through, downstream direct callers, TypeScript types, and any changeset classification of the API surface. Deciding it now avoids a plan-phase gate.
**Question**: What is the shape of the `defaultRepo` field on the `parseEpicBody` options bag?
**Options**:
- A: `string` in canonical `"owner/repo"` form. Matches how `resolveEpic` already carries the ref (see `EPIC_REGEX` in `resolve.ts`) and how `IssueRef.repo` is stored today. Minimal plumbing.
- B: `{ owner: string; repo: string }` object. More explicit, no in-band parsing; but requires callers to split their own `owner/repo` string.
- C: `IssueRef`-shaped (`{ repo, number }`, with `number` ignored). Reuses an existing type but the semantic mismatch (only `repo` is meaningful) is worse than either A or B.

**Answer**: *Pending*

### Q4: H3 + H4 phase interaction in the same body
**Context**: FR-001 says a phase-shaped `####` heading opens a phase "exactly as `###` does today," but the spec does not describe what happens when both levels appear in the same body — e.g. `### Phase 1` followed later by `#### Phase 2`. Today's parser has no such interaction (H4 always closes); after promotion, three interpretations are possible and they produce different `phases[]` outputs. This directly determines fixture expectations and downstream `phase-complete` behavior.
**Question**: When both `###` phase headings and phase-shaped `####` headings appear in the same body, how should they interact?
**Options**:
- A: Flat siblings — every phase-shaped heading (H3 or H4) opens a new top-level phase, regardless of level. A `#### Phase 2` inside a `### Phase 1` closes phase 1 and opens phase 2 as a sibling.
- B: H4 nests inside H3 — a phase-shaped `####` under an open `###` phase becomes a sub-phase (extends parent's ref list). Only phase-shaped H4s outside any H3 open new top-level phases.
- C: Level-strict — treat H3 and phase-shaped H4 as separate phase namespaces. Mixed bodies emit a warning; `phases[]` uses whichever level came first as the "canonical" level and demotes the other.

**Answer**: *Pending*

### Q5: Bare `#N` acceptance scope
**Context**: US2 and FR-004 describe bare `#N` acceptance in "task lists" and show `- [ ] #223`. The current parser (`TASK_LIST_RE` in `parse-epic-body.ts:16`) only accepts refs inside `- [ ]` / `- [x]` checkbox items — plain bullets (`- #223`), ordered items (`1. #223`), and prose mentions are not scanned for refs. It's ambiguous whether `defaultRepo` extends the ref surface as well, or only rescues bare `#N` inside the surface the parser already sees.
**Question**: Where should bare `#N` refs be accepted when `defaultRepo` is provided?
**Options**:
- A: Task-list checkboxes only — no change to the acceptance surface. Bare `#N` becomes valid inside `- [ ] #223` / `- [x] #223`, everywhere else stays as today. Minimal blast radius.
- B: Any bullet — extend the surface to plain bullets (`- #223`, `* #223`) and ordered items (`1. #223`). More permissive; widens the parser's grammar in the same PR.
- C: Anywhere ref-shaped — scan any line for bare `#N`. Highest risk of false positives (e.g. prose "see #223 for context").

**Answer**: *Pending*
