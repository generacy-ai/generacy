# Implementation Plan: Cockpit CLI status/watch argument-contract drift (positional refs + bare-number inference)

**Feature**: Convert `cockpit status` and `cockpit watch` from `--epic <ownerRepoIssue>` flag to positional `<epic-ref>`, extend the shared `resolveIssueContext` helper to be the single ref-resolution entry point for `status`, `watch`, `queue`, and `context`, and let a bare issue number resolve its `owner/repo` from the cwd's git origin.
**Branch**: `822-found-during-cockpit-v1`
**Status**: Complete
**Date**: 2026-07-07
**Spec**: [spec.md](./spec.md)
**Input**: Feature specification at `/specs/822-found-during-cockpit-v1/spec.md`

## Summary

Three-part CLI-side drift is fixed by three coordinated edits in `packages/generacy/src/cli/commands/cockpit/`:

1. **`status.ts`** — replace `.requiredOption('--epic <ownerRepoIssue>', …)` with `.argument('<epic-ref>', …)`, replace the `--epic`-null guard with a call to `resolveIssueContext({ issue: epicRef, gh })`, then pass the expanded `owner/repo#N` (`resolved.ref.nwo + '#' + resolved.ref.number`) to the existing sync `resolveEpic()`.
2. **`watch.ts`** — same shape as `status.ts`. Both the initial `resolveEpic()` and the in-loop poll re-`resolveEpic()` receive the expanded ref (resolved once at command start, cached, then re-used — no re-inference per poll).
3. **`queue.ts`** — internal only: route the incoming positional `<epic-ref>` argument through `resolveIssueContext` before calling `resolveEpic`. `queue`'s argument surface (positional `<epic-ref> <phase>`) is byte-identical. Its existing `--repo` flag (enqueue target, not ref-resolution override) is untouched.

`packages/cockpit/src/resolver/resolve.ts` — the shared library's private `parseEpicRef` — is **not touched**. Q1→A: resolution is lifted up into the verb layer so `@generacy-ai/cockpit` stays pure (no git subprocess in the shared library). The verb layer's `resolveIssueContext` helper — already used by `cockpit context` — is the single source of truth. Q3→B: error surface reuses the existing `parse issue: <reason>` shape from `resolveIssueContext`, wrapped as `Error: cockpit <verb>: parse issue: …` with exit code 2. Its enumerated forms list is extended to include the bare number.

Zero plugin changes. `claude-plugin-cockpit`'s `status.md` / `watch.md` already pass `$ARGUMENTS` positionally — the fix is CLI-side so they start working as-is.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js >=22 (matches `packages/generacy` `engines.node`). Compiles to ESM under `dist/`.
**Primary Dependencies**: `commander` (for `.argument()` vs `.requiredOption()` swap), existing `@generacy-ai/cockpit` (`resolveEpic`, `GhCliWrapper`, `LoudResolverError`). No new runtime deps.
**Storage**: None. `resolveIssueContext` shells out to `git remote get-url origin` synchronously on first bare-number call and returns the inferred `owner/repo` — no persistence, no cache.
**Testing**: `vitest` in `packages/generacy/src/cli/commands/cockpit/__tests__/`. Existing `status.test.ts`, `watch.test.ts`, `queue.test.ts`, `resolver.test.ts` files are the extension points. `resolver.test.ts` already covers `parseIssueRef` and `resolveIssueContext` — extend for the bare-number-plus-origin path.
**Target Platform**: Any environment where the `generacy` CLI runs — dev laptop, cluster orchestrator container, CI runner. The bare-number inference requires a git origin resolvable from the process cwd; without one, the loud `parse issue: …` error names all three accepted forms.
**Project Type**: Single-package edit. Three files modified in `packages/generacy/src/cli/commands/cockpit/`; one file (`resolver.ts`) unchanged in its exported surface (already provides everything needed).
**Performance Goals**:
- No perf-relevant paths. Each verb makes one extra async call to `resolveIssueContext` before `resolveEpic`; the only new subprocess is `git remote get-url origin`, which fires once per verb invocation and only when the ref is a bare number.
- `watch`'s poll loop re-uses the initially-expanded `owner/repo#N` string — the bare-number inference does **not** repeat every poll interval.
**Constraints**:
- **One mechanism.** `--epic` is deleted, not deprecated. Pre-1.0, no compat shim (spec Out-of-Scope).
- **`@generacy-ai/cockpit` stays pure.** No git subprocess added to the shared library. Q1→A.
- **Session cwd is the single source of truth** for bare-number `owner/repo` inference. No `--repo` override flag on `status`/`watch` (Q5→A). `owner/repo#N` in the ref itself is the explicit-repo mechanism.
- **Uniform error shape.** All four verbs (`status`, `watch`, `queue`, `context`) emit `Error: cockpit <verb>: parse issue: <reason>` on ref-parse failure. Exit 2. Q3→B.
- **`queue` argument surface is byte-identical.** Only the internal parser call changes (Q4→A / FR-009).
**Scale/Scope**: 3 files edited, 1 file left alone (used more), ~30 net LOC change including tests.

## Constitution Check

No `.specify/memory/constitution.md` present in this repo. No gates to evaluate. Constitution check **PASS** (vacuously).

## Project Structure

### Documentation (this feature)

```text
specs/822-found-during-cockpit-v1/
├── spec.md                                          # already authored
├── clarifications.md                                # already authored (Batch 1, Q1–Q5)
├── plan.md                                          # THIS FILE
├── research.md                                      # decision rationale
├── data-model.md                                    # interface deltas + call graph
├── quickstart.md                                    # local repro / validation
└── contracts/
    └── cli-surface.md                               # documented CLI surface for status/watch/queue post-fix
```

`tasks.md` is produced by `/speckit:tasks`, not this command.

### Source Code (generacy CLI package — repository monorepo)

```text
packages/generacy/src/cli/commands/cockpit/
├── status.ts                                        # MODIFIED — replace .requiredOption('--epic') with .argument('<epic-ref>'); call resolveIssueContext before resolveEpic; drop the --epic-null guard
├── watch.ts                                         # MODIFIED — same shape as status.ts; resolve once at start, cache the expanded ref for the poll loop
├── queue.ts                                         # MODIFIED — route the existing positional <epic-ref> argument through resolveIssueContext before resolveEpic; argument surface byte-identical
├── resolver.ts                                      # UNCHANGED in exported surface — resolveIssueContext already handles all three ref forms; parseIssueRef error message already enumerates the accepted forms (extend the message string to include the bare number)
└── __tests__/
    ├── status.test.ts                               # MODIFIED — flag-based fixtures (`{ epic: '...' }`) become positional (`'...'` as first arg); add coverage for bare-number-with-origin, INVALID_EPIC_REF exit shape
    ├── watch.test.ts                                # MODIFIED — same shape as status.test.ts
    ├── queue.test.ts                                # MODIFIED — add regression test that `queue 1 <phase>` in a cwd with a git origin succeeds
    └── resolver.test.ts                             # MODIFIED — extend the parseIssueRef error message check to include the bare-number form; add an integration test for resolveIssueContext + injected runner that inspects the expanded owner/repo#N

# UNTOUCHED
packages/cockpit/src/resolver/resolve.ts             # Q1→A: shared library stays pure. Its private parseEpicRef and its resolveEpic export continue as-is.
```

**Structure Decision**: Single-package, three-file edit. The fix is deliberately narrow — CLI verbs delegate ref-resolution to the helper `context` already uses, then hand the expanded string to `resolveEpic()`. No new files. No moves. No dependency additions.

**Why the CLI layer and not the shared library**: option B in Q1 would push git-subprocess and filesystem awareness into `@generacy-ai/cockpit`. The shared library today has no filesystem or git-subprocess dependency, and this fix does not need it to gain one — every caller in the monorepo goes through the CLI verb layer anyway. Keep the boundary clean.

**Why not duplicate the inference in each verb**: option C. The S-chain (#803, #806, #807) just spent three issues deleting duplicated ref-parsing logic. Reintroducing a copy per verb would be a regression.

**Why `queue` also gets internal wiring even though its argument surface is unchanged**: US2 requires "single grammar across all three". A smoke tester who runs `status 1` will type `queue 1 <phase>` next; having the third verb reject a bare number would be this same bug refiled. Q4→A. The observable surface (positional `<epic-ref> <phase>`) stays byte-identical, so no plugin or CI script breaks.

**Why the plugin (`claude-plugin-cockpit`) is out of scope**: `status.md` and `watch.md` already pass `$ARGUMENTS` positionally to `generacy cockpit status` / `watch`. The whole reason every invocation fails today is that the CLI drifted away from the plugin's contract. Fixing the CLI back to positional means no plugin change (SC-005).

## Complexity Tracking

> No constitution violations. Table omitted.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _none_   | _n/a_      | _n/a_                                |
