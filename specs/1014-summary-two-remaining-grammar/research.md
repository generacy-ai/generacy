# Research

## Decisions

### D-1: Reuse `PHASE_SHAPED_H4_RE` from #1006 as-is

**Decision**: Use `PHASE_SHAPED_H4_RE` (`parse-epic-body.ts:12`) unchanged as the sole detector for "phase-shaped `####`". Do not widen it in this PR.

**Rationale**:
- Detector is contractual (#1006 clarifications Q1=C). Widening the vocabulary (e.g. `#### Step N`, `#### Milestone N`) is called out as Out-of-Scope in spec §Out of Scope.
- Existing fixture (`epic-1006-snappoll.md`) is expressed against this detector; reuse minimizes fixture surgery.

**Alternatives considered**:
- Extract `PHASE_SHAPED_H4_RE` to `heading-match.ts` and share with `detectShape`. Rejected: `detectShape` lives in a different package (`packages/generacy/…/scope/writer.ts`) with its own local heading regexes (see `writer.ts:16-21`). A cross-package import would create a fresh dependency edge. Instead, `writer.ts` copies the regex literal alongside its comment "Byte-exact against parseEpicBody's PHASE_SHAPED_H4_RE" (same pattern as `HEADING_L3_RE` today). Duplication scoped to one regex is acceptable; the invariant is documented at both sites.

**References**:
- `packages/cockpit/src/resolver/parse-epic-body.ts:12`
- `.changeset/1006-h4-phase-header-detector.md`

---

### D-2: `defaultRepo` shape — `string` in `"owner/repo"` form

**Decision**: The `defaultRepo` option on `parseEpicBody` is a `string` in canonical `"owner/repo"` form (clarifications Q3=A).

**Rationale**:
- Matches how `IssueRef.repo` is stored (`resolver/types.ts:6-9`).
- Matches how `resolveEpic` already carries the ref: `parseEpicRef` in `resolve.ts:12-20` produces `repo: ${owner}/${repo}` as a single string; passing it through unchanged requires zero splitting/re-joining.
- Callers building an `IssueRef` for other purposes can trivially derive the string (`ref.repo`) without exposing an unused `number` field (Option C flaw).

**Alternatives considered**:
- Option B (`{owner, repo}` object): more explicit but requires every caller to split `owner/repo` first. `resolveEpic` would need to `.split('/')` on data it already has as a string. Zero benefit; extra allocation.
- Option C (`IssueRef`-shaped): semantic mismatch — `number` field is meaningless in this context. Signals "issue reference" when we mean "repository handle."

**Validation**: `DEFAULT_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/` (mirrors the `OWNER_REPO` char class in `ref-shapes.ts:3`). Malformed input MUST push a warning (`cockpit: parseEpicBody: invalid defaultRepo '…'`) and behave as if `defaultRepo` was absent — fail-safe, per FR-003.

---

### D-3: Acceptance surface for bare `#N` — checkbox task-list items only

**Decision**: Bare `#N` refs are accepted *only* inside `TASK_LIST_RE`-matching lines (clarifications Q5=A). No widening of the parser's ref-scanning surface in this PR.

**Rationale**:
- Checkbox is the completion-tracking affordance the scope writer already emits (`writer.ts:27-29`, `formatRefLine`).
- Non-checkbox bullets (`- #223`, `1. #223`), prose mentions (`see #223 for context`), and plain lines all remain unchanged — no false positives.
- If demand appears later, widening to non-checkbox bullets is a separate change (Out-of-Scope §Out of Scope).

**Implementation**:
- The existing `parseRef` in `ref-shapes.ts` is called on `refToken` (`parse-epic-body.ts:121`). Two paths:
  1. **Extend `parseRef`** with an optional `defaultRepo` argument. `parseRef(refToken, defaultRepo?)` matches bare `#N` when `defaultRepo` is set. Simpler.
  2. **Wrap at the call site** in `parse-epic-body.ts`: try `parseRef(refToken)` first; if it returns `null` AND `defaultRepo` is set AND `BARE_HASH_N_RE` matches, synthesize `{ repo: defaultRepo, number }`.

  **Choice**: Option 2 (wrap at the call site). Keeps `parseRef` a pure token-shape recogniser with no context awareness; keeps the "default repo" fallback in the one file that also knows about `TASK_LIST_RE`. `ref-shapes.ts` stays reusable by any caller that doesn't have a default-repo notion.

**References**:
- `packages/cockpit/src/resolver/parse-epic-body.ts:16` (TASK_LIST_RE)
- `packages/cockpit/src/resolver/parse-epic-body.ts:28` (BARE_HASH_N_RE — already exists as rejection classifier; reused as acceptance shape)

---

### D-4: Non-phase-shaped `####+` headings are transparent everywhere

**Decision**: A `####+` heading that fails `PHASE_SHAPED_H4_RE` does *not* close the current phase — regardless of whether any phase is currently open (clarifications Q1=A).

**Rationale**:
- Single-rule formulation. Option C (transparent only inside an open `###` phase) is behaviorally identical whenever no phase is open — closing "the current phase" when there is no current phase is a no-op.
- Enables sub-section headings inside phases: `### Phase 1` → `#### Notes` → `- [ ] owner/repo#5` continues to attribute `#5` to Phase 1.
- The `## Ad-hoc` H2 rule (`AD_HOC_HEADING_RE` at `parse-epic-body.ts:15`, handler at `:91-95`) and other H2/H3 semantics stay unchanged.

**Implementation**: The current code branch at `parse-epic-body.ts:80-88`:
```typescript
if (HEADING_L4_PLUS_RE.test(line)) {
  const text = line.replace(/^####+\s+/, '').trim();
  if (PHASE_SHAPED_H4_RE.test(text)) {
    sawPhaseShapedH4 = true;
  }
  current = null;
  currentSeen = new Set();
  continue;
}
```

Becomes:
```typescript
if (HEADING_L4_PLUS_RE.test(line)) {
  const text = line.replace(/^####+\s+/, '').trim();
  if (PHASE_SHAPED_H4_RE.test(text)) {
    // Phase-shaped H4 opens a new phase (FR-001).
    sawPhaseShapedH4 = true;
    const heading = text;
    const token = firstToken(heading);
    current = { heading, token, refs: [] };
    currentSeen = new Set();
    phases.push(current);
    if (sawH3Phase) sawMixedHeadingLevels = true;
  }
  // Non-phase-shaped H4+ is transparent — do NOT close current phase (FR-002).
  continue;
}
```

The H3 branch tracks `sawH3Phase = true`. When *both* levels appear in one body, push a warning after the loop (FR-012).

---

### D-5: Mixed H3 + phase-shaped H4 → flat siblings + warning

**Decision**: Every phase-shaped heading opens a top-level phase regardless of level (clarifications Q4=A). `ParsedPhase[]` stays flat. Emit a resolver warning when both levels appear in the same body.

**Rationale**:
- `ParsedPhase[]` is a flat list at `resolver/types.ts:20`. Nothing downstream (phase tokens, queue-by-phase, phase-complete detection) has a nesting concept — Option B (H4 nests inside H3) would silently change the unit of phase-completion.
- Warning is diagnostic — authors typically don't intend mixed levels and should notice.

**Warning marker substring**: `mixed phase heading levels` (grep-audited stable marker, matches the #826/#1006 convention of embedding one stable substring per warning class).

**Wording**: `cockpit: body mixes '###' and '####' phase headings; every phase-shaped heading opens a top-level phase (mixed phase heading levels)`.

---

### D-6: `detectShape` mirrors parser recognition

**Decision**: `detectShape` in `writer.ts` classifies a body as `phased` if *any* line matches `HEADING_L3_RE` OR a `####+` line whose text matches `PHASE_SHAPED_H4_RE` (clarifications Q2=A).

**Rationale**:
- Ensures `scope add` on an H4-authored body places ad-hoc refs correctly (creates or finds `## Ad-hoc` at the tail rather than falling to the flat writer path which just appends `- [ ] …` at EOF).
- Author-visible consistency: parser and writer agree on "what is a phased body?"
- No auto-normalization of `####` → `###` on write (Option C rejected in Q2=A). Author-provided formatting is preserved.

**Implementation**: `writer.ts:31-37` gains a second branch:
```typescript
const HEADING_L4_PLUS_RE = /^####+\s+/;
const PHASE_SHAPED_H4_RE = /^\s*(?:P\d+\b|.*\bphase\b)/i; // MUST match parser byte-for-byte

export function detectShape(body: string): BodyShape {
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    if (HEADING_L3_RE.test(line)) return 'phased';
    if (HEADING_L4_PLUS_RE.test(line)) {
      const text = line.replace(/^####+\s+/, '').trim();
      if (PHASE_SHAPED_H4_RE.test(text)) return 'phased';
    }
  }
  return 'flat';
}
```

Existing test `L4 headings do not make body phased` (`writer.test.ts:24-26`) uses `#### notes` — still classifies as `flat` because `notes` fails `PHASE_SHAPED_H4_RE`. Preserved unchanged.

**Duplication cost**: One regex literal duplicated across two packages (cockpit → generacy). Documented at both sites with a "MUST match parser byte-for-byte" invariant comment. This mirrors the existing `HEADING_L3_RE` duplication (`writer.ts:17` already has `// Byte-exact against parseEpicBody's HEADING_L3_RE (invariant I-1).`). Cross-package import rejected (see D-1 Alternatives).

---

### D-7: Changeset classification

**Decision**: `minor` for `@generacy-ai/cockpit`, `patch` for `@generacy-ai/generacy`.

**Rationale (per `CLAUDE.md § Changesets`)**:
- `@generacy-ai/cockpit`: `parseEpicBody` gains an optional options argument. New capability (previously impossible). Additive to public API surface (already exported at `index.ts:26`). New TypeScript type `ParseEpicBodyOptions` exported. → `minor`.
- `@generacy-ai/generacy`: `detectShape` change is internal (not re-exported from any public package entry — `writer.ts` is a CLI-internal file). But `packages/generacy/src/` non-test change triggers the CI gate. Bug-fix nature → `patch`.

---

### D-8: Fixture strategy

**Decision**: Re-pin `epic-1006-snappoll.md` snapshot (H4 phases now populated). Add one new fixture `epic-1014-bare-refs.md` for the bare-`#N` acceptance path.

**Rationale**:
- SC-004 requires byte-identical parse output for non-re-pinned fixtures. Only `epic-1006-snappoll.md` (which was designed around the failure mode this PR fixes) needs a new snapshot.
- The `epic-826-*` fixtures use H3 and qualified refs — parse identically pre/post.
- New fixture pins FR-004 (positive) and FR-005 (negative — same body without `defaultRepo` still warns).

**Fixture content (`epic-1014-bare-refs.md`)** — bare `#N` inside checkboxes plus one plain-bullet control (`- #99`, which MUST NOT be captured):
```markdown
Scope for a hand-written epic — bare #N task list.

### Phase 1
- [ ] #223 — bare, checkbox, no default title
- [ ] #224 — bare, checkbox, with title
- [x] #225 — bare, completed checkbox
- [ ] other/other-repo#226 — cross-repo qualified stays qualified
- #99 — plain bullet, NOT scanned

### Phase 2
- [ ] #227
```

Assertions (positive-under-defaultRepo):
- `parsed.phases[0].refs` == `[{repo: 'scope/scope-repo', number: 223}, {repo: 'scope/scope-repo', number: 224}, {repo: 'scope/scope-repo', number: 225}, {repo: 'other/other-repo', number: 226}]`
- `parsed.phases[1].refs` == `[{repo: 'scope/scope-repo', number: 227}]`
- `parsed.warnings` == `[]` (no bare-ref warning under `defaultRepo`)

Assertions (negative-without-defaultRepo):
- Same body parsed with no options → warnings contain 4 bare-ref classifier entries (#826 marker substring `bare '#N'`), refs collapse accordingly.

---

### D-9: Options-bag placement in `resolveEpic`

**Decision**: `resolveEpic` calls `parseEpicBody(body, { defaultRepo: epic.repo })` at `resolve.ts:51`.

**Rationale**:
- `epic` is already parsed at `resolve.ts:40` from `options.epicRef`.
- `epic.repo` is the canonical `"owner/repo"` string that `defaultRepo` expects.
- Single call site — no plumbing changes upstream of `resolveEpic`.

**Test**: extend `resolve.test.ts` — inject a body with `- [ ] #223` under a mocked `gh.getIssue`; assert `parsed.allRefs[0].repo === epic.repo` and `parsed.warnings.length === 0`.

---

## Implementation patterns

- **Additive options-bag**: TypeScript signature `parseEpicBody(body: string, options?: ParseEpicBodyOptions): ParsedEpicBody`. `ParseEpicBodyOptions` is exported from `resolver/types.ts` and re-exported from the package entry.
- **Warning marker substrings** (stable, grep-audited — per #826 convention):
  - `mixed phase heading levels` (FR-012)
  - `invalid defaultRepo` (FR-003)
  - Existing `bare '#N'` / `phase headers must be '###'` unchanged.
- **Fixture-pinned regression**: `packages/cockpit/src/resolver/__tests__/parse-epic-body.test.ts` snapshot suite is the primary regression net for SC-004.

## Key sources

- Spec: `specs/1014-summary-two-remaining-grammar/spec.md`
- Clarifications: `specs/1014-summary-two-remaining-grammar/clarifications.md`
- Predecessor changeset: `.changeset/1006-h4-phase-header-detector.md`
- Parser: `packages/cockpit/src/resolver/parse-epic-body.ts`
- Ref shapes: `packages/cockpit/src/resolver/ref-shapes.ts`
- Top-level resolver: `packages/cockpit/src/resolver/resolve.ts`
- Writer: `packages/generacy/src/cli/commands/cockpit/scope/writer.ts`
- Existing fixture: `packages/cockpit/src/resolver/__tests__/fixtures/epic-1006-snappoll.md`
- Changesets contract: `CLAUDE.md § Changesets`
