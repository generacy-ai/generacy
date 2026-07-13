# Implementation Plan: Surface classifier reason in failure evidence

**Feature**: Add a `reason` field to `CommandExitEvidence` populated from the classifier `error.message`, wire it through `buildErrorEvidence` via an explicit `classifier?: string` parameter, and render it in both the stage-comment evidence block and the bottom-of-thread failure alert. When the failure comes from a post-exit classifier (product-diff guard, no-progress guard, spawn-error catch, product-diff-error catch), the exit descriptor names it (`failed post-exit: <classifier> (process exit N)`); the message that explains the failure appears above the output tail, so operators no longer see a lying `exit 0. (no output on either stream)` alert.
**Branch**: `915-found-during-cockpit-v1`
**Date**: 2026-07-11
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md)
**Status**: Complete

## Summary

Follow-up to #847 (evidence-block introduction), #865 (failure-alert composer), and #890 (merged output tail). The observed defect (`snappoll#3`, tetrad-development#92 finding #55): the `no-product-code-changes` guard from specs/820 correctly failed the implement phase (only `specs/003-*/**` changed), but the posted failure alert rendered:

> ❌ implement failed — `implement` exit 0. (no output on either stream)

Two aggravations:

- **`exit 0` in a failure alert is a lying label**: the process exited 0 and was failed *post-exit* by a classifier; the alert should name which check failed it, not present a success code as the failure descriptor.
- **Every synthetic-PhaseResult path (product-diff guard, no-progress guard, catch-block sites) shares this**: the one line that explains the failure (`result.error.message`) is the one line `buildErrorEvidence` (phase-loop.ts:989–1011) currently drops. It uses `error.message` only to sniff timeout/abort wording; with `error.output` empty on synthetic paths, the alert renders the "(no output on either stream)" literal.

**Cost in the live run**: operator + auto session read "exit 0, no output" as a transient anomaly → requeue → identical failure → second escalation gate → operator time burned, actual signal ("implement wrote only spec artifacts") never surfaced.

**Fix (two coordinated additions)**:

1. **Extend the evidence shape**: `CommandExitEvidence` gains optional `reason?: string`. Populated from `result.error?.message` when the caller passes an explicit `classifier` argument. When absent, rendering is byte-identical to today.
2. **Extend the discriminator**: `buildErrorEvidence` gains an optional `classifier?: string` parameter (per clarifications Q1→B). Presence is the sole synthetic-vs-process discriminator; `error.output` stays free-form on every path (no code churn at the no-progress site to satisfy an inference rule). When `classifier` is present, `reason` is populated **and** `exitDescriptor` becomes `failed post-exit: <classifier> (process exit <N>)` instead of `exit <N>` — the descriptor no longer lies.
3. **Sanitize the reason**: ZWSP-escape backticks in `reason` before rendering (Q4→B), matching `outputTail`'s existing treatment in `stage-comment-manager.ts`. Multi-line reasons render with `**Reason**:` on its own line followed by a fenced ```text``` block, capped at 1 KiB with a trailing `…` marker (Q2→B). Single-line reasons render inline as `**Reason**: <reason>`.
4. **Site-specific classifier names** (Q3→B): `'no-product-code-changes'` at the product-diff guard site (~:630), `'no-progress'` at the no-progress guard site (~:429), `'spawn-error'` at the unexpected-spawn catch (~:373), `'product-diff-error'` at the product-diff-detection catch (~:600). No shared `'catch-block'` literal — a classifier name says what failed, not which control-flow construct caught it.
5. **All six FR-006 callsites pass the argument explicitly** (Q5→B): the three synthetic sites pass named classifiers; the two shell/CLI process-failure sites (`:294`, `:548`) pass `classifier: undefined`. Explicit `undefined` keeps every callsite's path-classification grep-auditable rather than implied by omission. Process-path rendering is unchanged.

Scoped entirely to `packages/orchestrator/src/worker/`. No new dependencies. No schema-persisted state. No relay-payload change. No cockpit-classifier change. Additive to `CommandExitEvidence` — `reason` is optional, so pre-fix serialized evidence blobs (historical stage-comment reads via `cockpit status`) still parse.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js ≥22 (per orchestrator package).
**Primary Dependencies**: `pino` (Logger), `vitest` for tests. Zero new runtime deps.
**Storage**: N/A — evidence is rendered into a GitHub comment via existing `StageCommentManager.updateStageComment` + `StageCommentManager.postFailureAlert`. No persistence layer touched. `reason` lives inside the already-persisted `errorEvidence` blob; the optional field is a forward-compatible addition.
**Testing**: `vitest`. Affected suites:
- `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts` — new fixtures per FR-008: product-diff guard, no-progress guard, spawn-error catch, product-diff-error catch. Each asserts:
  - `evidence.reason` contains the classifier's `error.message`.
  - `evidence.exitDescriptor` is `failed post-exit: <name> (process exit <N>)`.
  - `evidence.outputTail` is unchanged (either the counter text for no-progress or the "(no output on either stream)" literal for the others).
  - Never renders "(no output on either stream)" as the only evidence surface.
- `packages/orchestrator/src/worker/__tests__/stage-comment-manager.test.ts` — new fixtures for single-line reason (inline `**Reason**: <text>`) and multi-line reason (fenced block, 1 KiB cap, `…` marker). Backtick-in-reason ZWSP escape assertion.
- Regression coverage for the two process-failure callsites (`:294`, `:548`): assert `evidence.reason` is `undefined` and `evidence.exitDescriptor` still reads `exit <N>` — the process paths' rendered shape is byte-identical to pre-fix output.
**Target Platform**: Node worker inside cluster orchestrator container.
**Project Type**: Monorepo package (`packages/orchestrator`) modification. No cross-package impact.
**Performance Goals**: Zero measurable impact. `reason` is a single string field on a struct built once per phase failure; the 1 KiB cap + ZWSP substitution are O(reason length) with typical messages ≤ 200 chars.
**Constraints**:
- Zero new dependencies.
- `CommandExitEvidence` type shape gains one optional field (`reason?: string`). No renames. No breaking changes to consumers that don't yet read `reason` (pre-fix serialized blobs still validate).
- Reason cap of 1 KiB is a defensive bound against `String(error)` producing multi-KB stack excerpts; typical `error.message` from the four named classifiers is < 300 chars.
- The two `<details>` renderers (`appendEvidenceBlock` at `stage-comment-manager.ts:193`; `renderFailureAlert` at `stage-comment-manager.ts:329`) MUST update in lockstep — a rename in one but not the other leaves one surface carrying the reason and the other omitting it.
- Backtick sanitization must match the existing `outputTail` treatment (ZWSP escape, `stage-comment-manager.ts:200,334`) — one sanitization idiom across both fields.
- Process-path callsites (`:294`, `:548`) pass `classifier: undefined` explicitly, not by omission — visible grep-auditable statement of path classification per Q5→B.
- Additive field only: no removal of existing evidence fields, no rename of `outputTail`/`exitDescriptor`/`command`. The three-field shape from #890 is preserved with `reason` as a fourth optional field.
**Scale/Scope**: 3 source files modified (`phase-loop.ts`, `stage-comment-manager.ts`, `types.ts`). 2 test files updated. ~80 LOC production, ~200 LOC tests. Companion `.changeset/` entry for the additive type change.

## Constitution Check

*GATE: no constitution file at `.specify/memory/constitution.md`. Repository-wide invariants sourced from `CLAUDE.md`, this spec's clarifications, and the three directly-adjacent completed epics (#847, #865, #890):*

| Gate | Result | Note |
|------|--------|------|
| No premature abstractions / no half-finished implementations | PASS | No new files, no new classes, no shared `catch-block` literal (Q3→B rejected the grouping abstraction). The `classifier?` parameter + `reason?` field is the smallest surface that satisfies FR-002 through FR-006. |
| Match spec Q&A intent, not just the letter | PASS | Q1→B (explicit `classifier?` parameter as sole discriminator; `error.output` free-form on every path), Q2→B (single-line inline; multi-line fenced + 1 KiB cap + `…`), Q3→B (site-specific `spawn-error` and `product-diff-error`, no shared `catch-block`), Q4→B (ZWSP-escape backticks in `reason`), Q5→B (all six callsites pass explicitly; `:294` and `:548` pass `undefined`). All five decisions honored. |
| No backwards-compat shims for removed code | PASS | The change is purely additive. No aliasing, no dual-write of `message`+`reason`, no removed-comment stubs. Every reader is updated in the same change; the type is internal to `packages/orchestrator/src/worker/`. |
| Tests hit real behavior, not mocks-of-mocks | PASS | New fixtures in `phase-loop.test.ts` drive the four synthetic-result branches through real `buildErrorEvidence` and assert on the exact `CommandExitEvidence` shape returned. Renderer tests assert on rendered markdown byte-strings, not on mock renders. |
| Structured logging conventions | PASS | No new log lines. Existing `error.message` values already appear in `Pre-validate install failed` / `Unexpected error during phase execution` / `implement phase produced no product-code changes` structured logs; the fix surfaces the same string in the alert, not in a new log. |
| Don't add features beyond what the task requires | PASS | Not touched: cockpit classifier, relay payload, evidence-block placement, `outputTail` derivation (#890), merge-conflict variant (#864), label-op alert variant (#889). Byte layout above the `---` separator is byte-identical. |

Post-Phase-1 re-check: no violations introduced.

## Project Structure

### Documentation (this feature)

```text
specs/915-found-during-cockpit-v1/
├── spec.md                       # (present, unchanged by /plan)
├── clarifications.md             # (present, unchanged by /plan)
├── plan.md                       # THIS FILE
├── research.md                   # Phase 0 output — decisions + rejected alternatives (discriminator choice, reason-cap idiom, classifier naming)
├── data-model.md                 # Phase 1 output — CommandExitEvidence.reason addition, buildErrorEvidence signature, classifier vocabulary
├── quickstart.md                 # Phase 1 output — repro the exit-0 synthetic failure, verify the alert now carries the reason line
├── contracts/
│   └── failure-reason-block.md   # Rendering contract: reason placement, single-line vs. multi-line, cap + ZWSP, exit-descriptor rewording
└── checklists/                   # (empty)
```

### Source Code (repository root)

```text
packages/orchestrator/src/worker/
├── types.ts                      # MODIFIED — CommandExitEvidence gains `reason?: string`. JSDoc describes source (`error.message` when caller passes classifier) and format contract (may be single-line or multi-line, capped at 1 KiB after render).
├── phase-loop.ts                 # MODIFIED — buildErrorEvidence signature: `(command, result, resolvedTimeoutMs?, classifier?)`. When `classifier` set: exitDescriptor = `failed post-exit: <classifier> (process exit <N>)`, reason = `result.error?.message` (capped/ZWSP-escaped at render, not here — the raw string flows through). All 6 callsites pass classifier explicitly: `:294` → undefined, `:373` → 'spawn-error', `:429` → 'no-progress', `:548` → undefined, `:600` → 'product-diff-error', `:630` → 'no-product-code-changes'.
├── stage-comment-manager.ts      # MODIFIED — appendEvidenceBlock and renderFailureAlert both check for `evidence.reason`. Single-line: emit `**Reason**: <safeReason>` line between the `**Exit**` line and the `<details>` block. Multi-line: emit `**Reason**:` on its own line followed by fenced ```text``` block (1 KiB cap, `…` marker on truncate). ZWSP-escape backticks in `reason` matching the existing outputTail treatment.
└── __tests__/
    ├── phase-loop.test.ts        # MODIFIED — new fixtures for four synthetic classifier sites (product-diff, no-progress, spawn-error, product-diff-error): each asserts evidence.reason contains classifier message + exitDescriptor names the classifier. Regression fixtures for :294/:548 confirm reason is undefined.
    └── stage-comment-manager.test.ts # MODIFIED — new fixtures: single-line reason renders inline; multi-line reason renders fenced above the outputTail block; 1 KiB cap + `…` marker; backtick in reason gets ZWSP.
```

**Structure Decision**: Single-package modification inside `packages/orchestrator/src/worker/`. The change touches exactly the three-object triangle #847 introduced (`phase-loop.ts` → `stage-comment-manager.ts` → `types.ts`), matching the pattern established by #890. No new files: the classifier is a plain string parameter, not a new module or enum type; the 1 KiB cap + fence idiom is inlined into `appendEvidenceBlock`/`renderFailureAlert` because it composes with existing ZWSP-escape logic that's already inline there. Adding a `reason-format.ts` helper for one call each in two renderers would be premature abstraction.

## Design Overview

### Type extension (Phase 1)

`packages/orchestrator/src/worker/types.ts`:

```ts
// Before (#890 shape)
errorEvidence?:
  | {
      command: string;
      exitDescriptor: string;
      outputTail: string;
    }
  | { mergeConflict: { ... } };

// After (#915 shape — reason added)
errorEvidence?:
  | {
      command: string;
      exitDescriptor: string;
      outputTail: string;
      /**
       * Optional classifier reason — the human-readable message that explains
       * why a synthetic post-exit failure was raised (product-diff guard,
       * no-progress guard, spawn-error catch, product-diff-error catch).
       * Sourced from `result.error.message` when the buildErrorEvidence caller
       * passed an explicit `classifier` argument.
       *
       * Absent on process-failure paths (shell/CLI real non-zero exit) —
       * the outputTail already carries the diagnostic surface.
       *
       * Rendering: single-line reasons appear inline as `**Reason**: <r>`;
       * multi-line reasons appear as `**Reason**:` on its own line followed
       * by a fenced ```text``` block, capped at 1 KiB with a trailing `…`
       * marker. Backticks are ZWSP-escaped before render, matching outputTail.
       */
      reason?: string;
    }
  | { mergeConflict: { ... } };
```

### `buildErrorEvidence` signature change (Phase 1)

`packages/orchestrator/src/worker/phase-loop.ts:989`:

```ts
// Before
private buildErrorEvidence(
  command: string,
  result: PhaseResult,
  resolvedTimeoutMs?: number,
): CommandExitEvidence

// After
private buildErrorEvidence(
  command: string,
  result: PhaseResult,
  resolvedTimeoutMs?: number,
  classifier?: string,
): CommandExitEvidence {
  const message = result.error?.message ?? '';
  const exitDescriptor = classifier
    ? `failed post-exit: ${classifier} (process exit ${result.exitCode})`
    : message.includes('timed out') && resolvedTimeoutMs !== undefined
    ? `killed (SIGTERM) after ${resolvedTimeoutMs}ms`
    : message.includes('was aborted')
    ? 'aborted'
    : `exit ${result.exitCode}`;

  const rawOutput = result.error?.output ?? '';
  const outputTail = rawOutput.length > 0
    ? boundOutputTail(rawOutput)
    : synthesizeOutputTail(result.output);

  return {
    command,
    exitDescriptor,
    outputTail,
    ...(classifier ? { reason: message } : {}),
  };
}
```

### Callsite updates (Phase 2)

Six `buildErrorEvidence` callsites in `phase-loop.ts`:

| Line | Site | classifier arg |
|------|------|----------------|
| ~:294 | pre-validate install failure (shell process failure) | `undefined` |
| ~:373 | unexpected-spawn catch (post-exit synthetic) | `'spawn-error'` |
| ~:429 | no-progress guard (post-exit synthetic) | `'no-progress'` |
| ~:548 | post-phase process failure (shell/CLI process failure) | `undefined` |
| ~:600 | product-diff-detection catch (post-exit synthetic) | `'product-diff-error'` |
| ~:630 | product-diff guard (post-exit synthetic) | `'no-product-code-changes'` |

### Renderer changes (Phase 3)

`packages/orchestrator/src/worker/stage-comment-manager.ts`:

- `appendEvidenceBlock(lines, evidence)` — after `**Exit**` line and before the blank line preceding `<details>`, emit reason block if `evidence.reason` present. Reuses the ZWSP-escape logic already used for `outputTail`.
- `renderFailureAlert(marker, data)` — same insertion, between the summary line and the `<details>` wrapper. Both renderers share a small local helper for reason formatting (single-line vs. multi-line detection, 1 KiB cap, `…` marker).

See `contracts/failure-reason-block.md` for exact byte layout.

## Rollout / Behavior Change

- Purely additive: pre-fix serialized `errorEvidence` blobs (persisted in historical stage comments) still parse — `reason` is optional and defaults to absent on read.
- No feature flag: the fix is defensively additive at both the type layer and the render layer. Behavior on process-failure paths is byte-identical to pre-fix.
- Regression test coverage per FR-008 ensures the exit-0-lying-descriptor regression cannot re-emerge silently.
- No migration required for cockpit clients or downstream consumers of stage-comment markdown — the new `**Reason**:` line composes naturally with the existing block above the horizontal rule.

## Testing Strategy

Per FR-008 the four synthetic classifier sites each get a targeted fixture. Two additional regression fixtures cover the process-failure paths.

Fixtures asserting on the exact rendered markdown (byte-string match) live in `stage-comment-manager.test.ts`; fixtures asserting on the derived `CommandExitEvidence` shape live in `phase-loop.test.ts`. Both suites already exist; this change extends them.

The `spec.md` "Regression tests" section explicitly names the observable outcomes:
- Product-diff guard failure → alert body contains the excluded-prefixes message + names the guard.
- No-progress guard and catch-block synthetic results → same.
- Process-failure path (real non-zero exit) → unchanged shape + empty/absent reason.

## Phase Ordering

1. **Phase 1 (types + helper)**: extend `CommandExitEvidence` with optional `reason`; extend `buildErrorEvidence` signature; update the six callsites in `phase-loop.ts`.
2. **Phase 2 (renderers)**: `appendEvidenceBlock` + `renderFailureAlert` in `stage-comment-manager.ts` render the reason with the Q2-B layout + Q4-B sanitization.
3. **Phase 3 (tests)**: extend `phase-loop.test.ts` + `stage-comment-manager.test.ts` per FR-008 fixtures.
4. **Phase 4 (changeset)**: add `.changeset/` entry describing the additive field.

Phases 1–2 are dependent; Phase 3 depends on both; Phase 4 is independent and can run in parallel with Phase 3.

## Next step

Run `/speckit:tasks` to generate the task list from this plan.
