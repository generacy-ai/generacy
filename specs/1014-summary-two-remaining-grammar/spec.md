# Feature Specification: ## Summary

Two remaining grammar-brittleness issues in the epic/scope body resolver (`packages/cockpit/src/resolver/`) cause silently-degraded or lossy scope resolution when a body isn't authored in the exact expected format

**Branch**: `1014-summary-two-remaining-grammar` | **Date**: 2026-07-21 | **Status**: Draft

## Summary

Two remaining grammar-brittleness issues in the epic/scope body resolver (`packages/cockpit/src/resolver/`) cause silently-degraded or lossy scope resolution when a body isn't authored in the exact expected format. Follow-up to #1006, which shipped *detection* of the H4 failure mode but not the fix.

1. **Phase-shaped `####` headings still resolve all refs to `__adhoc__`.** #1006 added `PHASE_SHAPED_H4_RE` (`parse-epic-body.ts:12`) but only sets a `sawPhaseShapedH4` flag feeding a warning (`parse-epic-body.ts:80–88`, warning conditions at ~167–177). Any `####+` heading still unconditionally closes the current phase, so an epic authored with `#### Phase 2` headers ends up with empty phases, no `phase-complete` events, and a `/cockpit:auto` run that idles forever — the warning fires only in a narrow all-phases-empty case.
2. **Bare `#N` task-list refs are rejected.** `ref-shapes.ts` accepts only `owner/repo#N`, `[owner/repo#N](…)`, `[#N](github URL)`, or a full GitHub URL. A task list written the way everyone naturally writes one (`- [ ] #223`) produces warnings and an empty/partial scope. This is the most common authoring mistake and it makes hand-written or LLM-written scope bodies fragile.

## Proposed change

**H4 promotion** (`parse-epic-body.ts`):
- A `####` heading matching `PHASE_SHAPED_H4_RE` (e.g. `#### P2 — …`, `#### Phase 2: …`) **opens a phase**, exactly as `###` does today (clarifications Q1).
- **Non-phase-shaped `####+` headings are transparent** — they never close the current phase, so refs after `#### Notes` inside `### Phase 1` still attribute to Phase 1 (clarifications Q1=A). The `## Ad-hoc` H2 rule and other H2/H3 closing semantics are unchanged.
- **Mixed H3 + phase-shaped H4 in one body**: flat siblings — every phase-shaped heading opens a new top-level phase regardless of level. A `#### Phase 2` inside a `### Phase 1` closes Phase 1 and opens Phase 2 as a sibling (clarifications Q4=A). Emit a resolver warning when both levels appear in the same body so authors notice the mixed style.
- Keep the #1006 warning path for whatever still lands in `__adhoc__` unexpectedly.

**Bare `#N` resolution** (`ref-shapes.ts` / `parse-epic-body.ts` / `resolve.ts`):
- `parseEpicBody` gains an optional `defaultRepo: string` in canonical `"owner/repo"` form (clarifications Q3=A). Validated on entry — malformed strings are rejected/warned rather than silently producing bogus refs. `resolveEpic` passes the scope issue's own `owner/repo`.
- **Acceptance surface**: bare `#N` is accepted **only inside checkbox task-list items** (`- [ ] #223` / `- [x] #223`) (clarifications Q5=A). Plain bullets, ordered items, and prose mentions remain unchanged — no widening of the parser's ref-scanning surface in this PR.
- A bare `#223` task item then resolves to `<defaultRepo>#223`.
- Without a `defaultRepo` (direct library callers), behavior is unchanged (bare refs warn, as today).
- Cross-repo refs must remain explicit — bare numbers only ever bind to the scope issue's repo.

## Compatibility notes

- Downstream consumers (`matchPhaseHeading`, aggregate/phase-complete detection, `cockpit_status` grouping, scope writer) operate on the parsed `phases[]/refs[]` structure and need no changes; `scope/writer.ts` already writes qualified refs on `scope add`, so round-tripping is unaffected.
- `detectShape` in `scope/writer.ts` is updated to mirror the parser: **any phase-shaped heading (H3 or phase-shaped H4) classifies the body as `phased`** (clarifications Q2=A). `scope add` places ad-hoc refs correctly in H4-authored bodies. The writer does NOT auto-normalize `####` phase headings to `###` on write — author-provided formatting is preserved.
- Update resolver fixtures (including `epic-1006-snappoll.md`) to pin the new behavior.

## Acceptance criteria

- [ ] An epic body using `#### Phase N`-style headers resolves each phase with its refs (no `__adhoc__` dump), and `/cockpit:auto` emits `phase-complete` for it.
- [ ] `- [ ] #223` in a scope body resolves to `<scope-repo>#223` when resolved via `resolveEpic`; no warning is emitted for it.
- [ ] Bare-ref parsing without a default repo (direct `parseEpicBody(body)` call) is unchanged.
- [ ] Existing qualified-ref and `###`-phased bodies parse identically to today (fixture-pinned).
- [ ] Changeset included.


## User Stories

### US1: LLM-authored epic with `#### Phase N` headers auto-advances

**As a** cockpit operator running `/cockpit:auto` on an epic whose body was generated with H4 phase headers (`#### Phase 2 …` / `#### P2 …`),
**I want** each phase-shaped `####` heading to open a phase and carry its child refs,
**So that** `phase-complete` events fire and the auto run advances through the plan instead of idling on empty phases.

**Acceptance Criteria**:
- [ ] An epic body whose only phase headings are `#### Phase N`-shaped resolves each phase with its refs (no `__adhoc__` dump for those refs).
- [ ] `/cockpit:auto` on such an epic emits `phase-complete` and dispatches the next phase.
- [ ] The #1006 warning path still fires for anything that still lands in `__adhoc__` unexpectedly.

### US2: Hand- or LLM-authored scope with bare `#N` refs resolves

**As a** scope author writing task lists the natural way (`- [ ] #223`),
**I want** bare `#N` refs to bind to the scope issue's own repo,
**So that** my scope resolves cleanly without warnings or dropped items.

**Acceptance Criteria**:
- [ ] `- [ ] #223` in a scope body resolved via `resolveEpic` resolves to `<scope-repo>#223`.
- [ ] No warning is emitted for the bare `#N` ref when `defaultRepo` is supplied.
- [ ] Cross-repo refs (`other-owner/other-repo#N`) are unchanged and still require explicit qualification.

### US3: Existing bodies and direct library callers parse identically

**As a** maintainer of existing epics with qualified refs and `###`-only phase headers,
**I want** parsing to remain byte-identical for the shapes that already work,
**So that** no in-flight cockpit workflow regresses and no direct `parseEpicBody(body)` caller silently changes behavior.

**Acceptance Criteria**:
- [ ] All existing resolver fixtures parse identically pre/post-change except the fixture(s) explicitly re-pinned to the new behavior.
- [ ] `parseEpicBody(body)` (no options) behavior is unchanged: bare `#N` refs continue to warn / drop as today.
- [ ] `scope/writer.ts` round-trip (`scope add`) is unaffected — writer already emits qualified refs.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `parse-epic-body.ts` MUST treat a `####` heading whose trimmed text matches `PHASE_SHAPED_H4_RE` (introduced in #1006) as **opening** a phase, exactly as `###` does today. | P1 | Reuses the existing detector; no widening of "phase-shaped" grammar in this PR. |
| FR-002 | A non-phase-shaped `####+` heading (fails `PHASE_SHAPED_H4_RE`) MUST be **transparent** — it MUST NOT close the current phase. Refs after `#### Notes` inside `### Phase 1` continue to attribute to Phase 1. `## Ad-hoc` H2 rule and other H2/H3 closing semantics are unchanged. | P1 | Resolved by clarifications Q1=A. Single-rule formulation (transparent everywhere) preferred over the "transparent-only-inside-open-phase" variant, since closing with nothing open is a no-op. |
| FR-003 | `parseEpicBody` MUST accept an optional options bag with a `defaultRepo: string` field in canonical `"owner/repo"` form. The parser MUST validate the shape on entry — malformed strings MUST be rejected or produce a warning rather than silently produce bogus refs. | P1 | Resolved by clarifications Q3=A. `string` shape matches how `IssueRef.repo` is stored and how `resolveEpic` already carries the ref. Additive, backwards-compatible signature change. |
| FR-004 | When `defaultRepo` is provided, a bare `#N` ref inside a checkbox task-list item (`- [ ] #N` or `- [x] #N`) MUST resolve to `<defaultRepo>#N` (i.e. produce the same parsed ref as if the author had written `<owner>/<repo>#N`). | P1 | Applies to bare `#N` only — other ref shapes unaffected. Acceptance surface constrained by FR-013. |
| FR-005 | When `defaultRepo` is NOT provided, bare `#N` ref handling MUST be unchanged from today (warn and drop / omit). | P1 | Preserves direct library-caller behavior. |
| FR-006 | `resolveEpic` MUST pass the scope issue's own `owner/repo` as `defaultRepo` when it invokes `parseEpicBody`. | P1 | Only path where a `defaultRepo` is naturally available. |
| FR-007 | Cross-repo refs MUST remain explicit: bare `#N` MUST bind only to `defaultRepo` and MUST NOT infer any other repo from context (labels, siblings, prior refs, etc.). | P1 | Hard constraint on ref scope. |
| FR-008 | The #1006 warning path (`sawPhaseShapedH4` flag + all-adhoc-zero-populated-phases loud signal) MUST remain functional for bodies that still land in `__adhoc__` unexpectedly (e.g. a phase-shaped H4 sitting outside any structure the new rule can rescue). | P1 | Defense-in-depth is additive; warning is not superseded. |
| FR-009 | Resolver fixtures MUST be updated to pin the new behavior. Minimum: `epic-1006-snappoll.md` (H4 phases now populated) and a new/extended fixture asserting bare-`#N` resolution under `defaultRepo`. | P1 | Fixture-pinned is the primary regression net. |
| FR-010 | A changeset file MUST be added for `@generacy-ai/cockpit` (bump level per plan-phase classification of the `parseEpicBody` options-bag as internal-surface vs. public API). | P1 | CI gate — see `CLAUDE.md` changesets section. |
| FR-011 | `detectShape` in `scope/writer.ts` MUST classify a body as `phased` if it contains **any** phase-shaped heading — H3 (`### Phase N`) or phase-shaped H4 (matching `PHASE_SHAPED_H4_RE`). Writer classification MUST mirror parser recognition. The writer MUST NOT auto-normalize `####` phase headings to `###` on `scope add` (author formatting preserved). | P2 | Resolved by clarifications Q2=A. Ensures `scope add` places ad-hoc refs correctly in H4-authored bodies. |
| FR-012 | When a body contains BOTH `###` phase headings AND phase-shaped `####` headings, every phase-shaped heading MUST open a new top-level phase regardless of level (flat siblings). A `#### Phase 2` inside a `### Phase 1` MUST close Phase 1 and open Phase 2 as a sibling in `phases[]`. The parser MUST emit a resolver warning when both levels appear in the same body so authors notice the mixed style. | P1 | Resolved by clarifications Q4=A. `ParsedPhase[]` is a flat list; downstream phase-complete detection has no nesting concept. |
| FR-013 | The bare-`#N` acceptance surface introduced by `defaultRepo` MUST be limited to checkbox task-list items (`- [ ] #N` / `- [x] #N`, i.e. the shapes matched by `TASK_LIST_RE`). Plain bullets (`- #N`, `* #N`), ordered items (`1. #N`), and prose mentions MUST NOT be scanned for bare refs. | P1 | Resolved by clarifications Q5=A. Checkbox is the completion-tracking affordance the writer already emits; keeps blast radius minimal. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Fraction of `#### Phase N`-authored epic child refs that resolve to their intended phase (not `__adhoc__`). | 100% | Fixture-driven test on `epic-1006-snappoll.md`: parsed `phases[]` carries the child refs; `adhocRefs.length === 0` for the H4 phases. |
| SC-002 | Bare `#N` refs in a scope body resolved via `resolveEpic` produce `<scope-repo>#N`. | 100% | Unit test: `resolveEpic({owner:'x', repo:'y'}, body_with_bare_refs)` → every bare ref carries `owner:'x'`, `repo:'y'`, correct `number`; `warnings` contains no bare-ref entry. |
| SC-003 | `/cockpit:auto` on an epic previously affected by the H4 failure mode emits `phase-complete` and advances. | Advances (was: idles indefinitely) | Live rerun / integration harness on an H4-authored epic; assert at least one `phase-complete` event and a subsequent phase dispatch. |
| SC-004 | Byte-identical parse output for pre-existing fixtures NOT re-pinned by this PR. | 0 diffs | `pnpm test` on `packages/cockpit` fixture snapshot suite; only re-pinned fixtures show diffs. |
| SC-005 | Direct `parseEpicBody(body)` (no options) behavior unchanged for bare-`#N` handling. | 0 diffs | Unit test: same input body pre/post-change → same `phases[]`, `adhocRefs[]`, `warnings[]` shape. |
| SC-006 | Changeset file present. | 1 new `.changeset/*.md` for `@generacy-ai/cockpit`. | CI changeset-bot gate green. |

## Assumptions

- **`PHASE_SHAPED_H4_RE` from #1006 is the correct detector** for "phase-shaped `####`". Its published shape (per #1006 clarifications Q1=C) is `/^\s*P\d+\b/i` OR word-boundaried `/\bphase\b/i`. This PR reuses it as-is; widening the detector is a separate change.
- **`resolveEpic` has the scope issue's `owner/repo` at the call site** where it invokes `parseEpicBody` — enabling the `defaultRepo` pass-through without plumbing changes upstream of `resolveEpic`.
- **Downstream consumers require no changes.** `matchPhaseHeading`, `cockpit_status` grouping, aggregate / `phase-complete` detection, and `scope/writer.ts` all operate on the parsed `phases[]/refs[]` structure, which is not itself changing shape — only which refs land where.
- **`scope/writer.ts` already emits qualified refs** on `scope add`, so round-tripping a parsed-then-written body is unaffected by the bare-`#N` acceptance (bare refs are input-only).
- **`defaultRepo` is scoped to bare `#N` only.** No other ref shape (`owner/repo#N`, `[owner/repo#N](…)`, `[#N](github-url)`, full URL) is affected by its presence or absence.
- **`defaultRepo` is a canonical `"owner/repo"` string** (clarifications Q3=A) — not an object, not an `IssueRef`. Validated on entry.
- **Bare `#N` acceptance is checkbox-only** (clarifications Q5=A) — reuses the existing `TASK_LIST_RE` surface without widening the parser's ref-scanning grammar.
- **Non-phase-shaped `####+` headings are transparent** (clarifications Q1=A) — sub-section headings inside a phase are supported.
- **`detectShape` mirrors the parser** (clarifications Q2=A) — writer and parser share the same "what counts as phased?" answer; no author-visible inconsistency.
- **H3 + phase-shaped H4 in one body → flat siblings + warning** (clarifications Q4=A) — no nesting semantics anywhere in the pipeline.
- **Legacy behavior for direct library callers is a compat requirement, not just a nicety.** External consumers of `@generacy-ai/cockpit`'s `parseEpicBody` may exist and MUST see identical behavior when they don't pass `defaultRepo`.

## Out of Scope

- **Widening `PHASE_SHAPED_H4_RE`** to catch additional heading shapes (e.g. `#### Step N`, `#### Milestone N`). Any new phase-header vocabulary is a separate clarify/spec pass.
- **Cross-repo bare-`#N` inference.** Explicitly forbidden by FR-007 — bare numbers only bind to `defaultRepo`. No heuristics on labels, siblings, prior refs, or org membership.
- **Migrating existing epic bodies** to `###`-only phase headers, or updating the epic-authoring action / prompt. Authoring-side normalization was the #1006 primary fix and remains unchanged; this PR is the resolver-side defense-in-depth.
- **Fixing already-stuck live epics** whose `phase-complete` events never fired due to the H4 failure mode. A one-time ops action (re-run resolver after upgrade, or manually retag) is separate from this fix.
- **Extending the `defaultRepo` mechanism** to non-`resolveEpic` call sites (e.g. `cockpit_status` if it ever invokes `parseEpicBody` directly, or MCP tool return shape). If a new call site materially benefits, it's a separate change.
- **Richer degradation-return-type on `parseEpicBody`** (e.g. `defaultedRefs: RefInfo[]`, `degradation.kind` fields). Out of scope in #1006 and continues to be out of scope here — additive `warnings[]` remains the sole degradation channel.

---

*Generated by speckit*
