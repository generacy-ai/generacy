# Research: #810 residue sweep

Decision log for the five clarifications. Each entry names the decision, the rationale, alternatives considered, and the source of authority.

## D1 — Changeset reconciliation (from Q1)

**Decision**: Keep `.changeset/805-cockpit-delete-orchestrator-journal.md` as the single authoritative removal changeset at **MINOR** bump. Append one line covering the `STALE` status column and the omitted stuck fields. Delete `792-*.md` and `793-*.md`. No second changeset.

**Rationale**:
- Pre-1.0 semver convention here ships breaking changes as MINOR. Precedent: the #801/#802 scoping break went 0.1.x → 0.2.0 as MINOR.
- The package is currently `0.2.0` (verified in `packages/cockpit/package.json`). A MAJOR bump would cut `1.0.0` — a commitment nothing else in the plan is prepared for.
- `805-*.md` already enumerates the removals well; splitting the announcement across two files serves no reader.
- FR-001 stands unchanged: `792-*.md` and `793-*.md` both still exist on disk (verified) and must be deleted before the next `changeset version` run, or they will consume version bumps and ship changelog entries for features that don't exist.

**Alternatives considered**:
- **A (rewrite `805-*.md` at MAJOR)**: rejected — declares 1.0.0 by side effect.
- **B (delete `805-*.md`, add fresh MAJOR)**: rejected — same problem, plus loses the existing enumeration prose.
- **C (keep `805-*.md`, add a second MAJOR)**: rejected — two changesets for one removal is churn, and the MAJOR bump problem persists.

**Source**: clarifications.md Q1, spec.md FR-001.

## D2 — README audit scope (from Q2)

**Decision**: Re-audit `packages/cockpit/README.md` (not treat FR-003 as vacuously satisfied). Exactly one orchestrator reference remains (line 5, trailing "without depending on the orchestrator runtime" clause). Remove it if stale; keep it only if it legitimately describes the generacy orchestrator context. No other README edits.

**Rationale**:
- Spec FR-003 was written against a pre-#809 README (had "Talk to a running orchestrator" section, two-mode client bullet, `ORCHESTRATOR_URL`/`ORCHESTRATOR_API_TOKEN` env table). PR #809 (commit `c909706`) already rewrote the README end-to-end and stripped those sections.
- A grep for `orchestrator` returns exactly one hit — line 5. Line 5 is the only decision the reviewer needs to make.
- Default is remove: the primitives don't "depend on" anything runtime-side by construction, so the clause is a leftover framing device, not a load-bearing claim.

**Alternatives considered**:
- **A (treat FR-003 as done, no grep)**: rejected — misses the one straggler.
- **C (broader docs sweep + follow-up)**: rejected — no evidence of other stragglers; opening a follow-up issue for a hypothetical is process churn.

**Source**: clarifications.md Q2, spec.md FR-003.

## D3 — Legacy-config fixture placement + assertion depth (from Q3)

**Decision**: Fixture nests the removed keys under the `cockpit:` block. Test asserts three things:
1. `loadCockpitConfig()` resolves without throwing.
2. `parsed.orchestrator === undefined`.
3. `parsed.stuckThresholdMinutes === undefined`.

**Rationale**:
- The loader (`packages/cockpit/src/config/loader.ts:66`) passes only `doc['cockpit']` to `CockpitConfigSchema.parse()`. Legacy keys at top-level (siblings of `cockpit:`) never reach the schema at all — strip vs. strict is a no-op on them. Only nested placement exercises the strip-mode contract we care about.
- Asserting keys are `undefined` (rather than just "no throw") locks in that the fields are actually *dropped* from the parsed output — the observable behavior of Zod strip mode. This is the contract R4 depends on.
- Under `.strict()`, `parse()` would throw before assertion (1), so the test fails loudly on a schema author's slip.

**Alternatives considered**:
- **B (only "no throw" + `warnings.length === 0`)**: rejected — passes even if the schema author swaps to `.passthrough()`, which would silently leak legacy keys back into the parsed object. We want the strip behavior specifically.
- **C (two fixtures — nested + top-level)**: rejected — top-level fixture asserts nothing about the schema (the loader never sends those keys to Zod). Redundant coverage.
- **D (top-level only)**: rejected — same issue as C.

**Source**: clarifications.md Q3, spec.md FR-006, loader.ts:64-66.

## D4 — Handling of FR-007/FR-008/FR-009 (from Q4)

**Decision**:
- **FR-007** (`shared.scoping.test.ts` cleanup) — **moot**. File was deleted by #806 (via PR #809) along with the manifest scoping it exercised. Not present in current tree.
- **FR-008** (four CLI test files: `state.test.ts`, `advance.test.ts`, `clarify-context.test.ts`, `queue.test.ts`) — **skip**. All four exist in the current tree but are owned by in-flight #807 (G-S3, "collapse context verbs + unify gh wrapper and resolvers"). #807's rewrite starts from the current tree and shouldn't carry the orchestrator mocks forward; verify at #807's implementation review rather than editing here.
- **FR-009** (`status.render.test.ts` tombstone replacement) — **do it**. The file exists in the current tree and is not in #807's file ownership. See D5.

**Rationale**:
- Editing test files owned by another in-flight PR creates merge conflicts and violates the "Owns" isolation clause in spec §Owns.
- No follow-up issue needed for FR-008: the mock-removal check happens at #807's PR review by construction (the orchestrator mocks reference deleted symbols; TS/typechecking will surface them if they survive #807's rewrite).

**Alternatives considered**:
- **A (drop FR-007/008/009 + follow-up)**: rejected — FR-009 is do-able now and its owner isn't blocking, so drop-and-follow-up is unnecessary latency. FR-007 doesn't need a follow-up because it's moot.
- **B (block on #807)**: rejected — makes this PR's release-metadata cleanup ride behind an unrelated CLI refactor.
- **D (grep-driven cleanup)**: rejected — the spec's file list is precise; grep-driven scope creep would collide with #807's ownership.

**Source**: clarifications.md Q4, spec.md FR-007/FR-008/FR-009, git status (verified file presence).

## D5 — FR-009 tombstone replacement shape (from Q5) — verified moot on inspection

**Decision**: Skip FR-009. The current `status.render.test.ts` already asserts positive on the envelope's load-bearing keys (`parsed.scope`, `parsed.rows`) and contains no `expect(parsed.orchestrator).toBeUndefined()` line. Q5's specified assertion shape is already the shape in the file.

**Rationale**:
- Grep for `parsed.orchestrator` across `packages/generacy/**` returned zero hits; the only project-tree hits are in this spec and two unrelated `247-*` specs.
- The current `renderJsonEnvelope` test at lines 68-77:

  ```ts
  expect(parsed.scope).toEqual({ kind: 'epic', owner: 'o', repo: 'r', issue: 42 });
  expect(parsed.rows).toHaveLength(1);
  ```

  is exactly Q5 option B: "positive assertion of one or two load-bearing keys the render depends on, tolerant of additive envelope changes."

- Editing this test to add another positive assertion is unmotivated churn; Q5 answered for the case where the tombstone was still there. It isn't.

**Alternatives considered**:
- **A (exact key-set equality)**: rejected upstream in Q5 — too brittle for additive envelope evolution.
- **C (snapshot the envelope)**: rejected upstream in Q5 — snapshot maintenance overhead.
- **D (skip in this PR, revisit after #807)**: superseded — the file isn't in #807's ownership, and the assertion is already correct.

**Source**: clarifications.md Q5, inspection of status.render.test.ts (verified no tombstone).

## Implementation patterns (referenced, not new)

- **Existing test helper**: `writeConfig()` in `packages/cockpit/src/__tests__/config-loader.test.ts:7` writes a YAML string into a temp `<workspace>/.generacy/config.yaml`. The FR-006 test reuses this pattern verbatim (no new helper needed).
- **Existing fixture directory**: `packages/cockpit/src/__tests__/fixtures/config-samples/` already contains `full.yaml`, `partial-owner-only.yaml`, `invalid-repos.yaml`. New `legacy-orchestrator-keys.yaml` slots in alongside.
- **Zod strip mode**: default behavior of `z.object({...})` — no `.strict()` or `.passthrough()` in `CockpitConfigSchema`. Confirmed at `packages/cockpit/src/config/schema.ts:3`.

## Sources / references

- Spec: `specs/810-epic-generacy-ai-tetrad/spec.md`
- Clarifications: `specs/810-epic-generacy-ai-tetrad/clarifications.md`
- Source PR #808 (G-S1, merged): the code deletion this PR follows.
- PR #809 (#806 landing, commit `c909706`): rewrote cockpit README, deleted `shared.scoping.test.ts`.
- In-flight PR #807 (G-S3): owns the four CLI test files under FR-008.
- Loader source: `packages/cockpit/src/config/loader.ts`
- Schema source: `packages/cockpit/src/config/schema.ts`
