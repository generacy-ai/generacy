# Implementation Plan: Cockpit classifier — `blocked:*` error tier (#943)

**Feature**: Promote `blocked:stuck-merge-conflicts` and `blocked:stuck-validate-fix` from an unrecognised state to an `error`-tier `sourceLabel`, and outrank the generic `agent:error` / `failed:*` signals so downstream consumers route to the specific escalation gate rather than the generic unrecognized-state gate.
**Branch**: `943-summary-blocked-stuck-merge`
**Status**: Complete

## Summary

`packages/orchestrator/src/worker/merge-conflict-handler.ts` and `validate-fix-handler.ts` apply `blocked:stuck-*` labels when their auto-remedy gives up. The cockpit classifier currently routes every `blocked:*` label to the `waiting` tier via the generic prefix branch in `classifyByPattern`. As a result, `blocked:stuck-merge-conflicts` shows up downstream as an unrecognized state and interrupts the operator with the generic "never guess" gate instead of the merge-conflicts escalation gate that already exists for `waiting-for:merge-conflicts`. Snappoll auto run #13 produced three such escalations in one run.

This change:

1. **Replaces the generic `blocked:*` branch in `label-map.ts` with an enumerated `ERROR_BLOCKED_LABELS` set** containing `blocked:stuck-merge-conflicts` and `blocked:stuck-validate-fix` (CD-1). Labels in the set classify as `error`; every other `blocked:*` (including `blocked:stuck-feedback-loop` and any future addition) keeps the current `waiting` disposition. #883's precedence and unit tests remain untouched.
2. **Adds an `ERROR_PIPELINE_ORDER` list to `precedence.ts`** (CD-2 + CD-3) placing the two enumerated `blocked:*` labels ahead of `agent:error` and `failed:*` for the intra-`error` tie-break. Extends `compareSourceLabels` to consult the list when `tier === 'error'`, mirroring the existing `waiting` and `stage-complete` branches.
3. **Adds classifier unit tests** covering the single-label case, the co-occurrence with `waiting-for:merge-conflicts`, and the cross-family tie-breaks against `agent:error` / `failed:*`. Preserves every #883 blocked-loop assertion.

FR-005 (downstream consumers route on `blocked:*`) needs zero cockpit-side plumbing: `watch` / `await_events` already emit the `sourceLabel` on transitions. When the label set flips from `error / <other>` to `error / blocked:stuck-merge-conflicts`, the event stream carries the change through by construction. Routing the resulting event to the merge-conflicts escalation gate is the agency-side companion tracked in a separate issue (spec §Suggested fix bullet 2).

## Technical Context

- **Language**: TypeScript (strict), ESM, Node ≥22
- **Packages touched**: `@generacy-ai/cockpit` only
- **Runtime dependencies**: none (pure in-process classifier change)
- **Test framework**: Vitest (`packages/cockpit/vitest.config.ts`)
- **No new packages, no new label definitions** — the three `blocked:*` labels already exist in `WORKFLOW_LABELS` (`packages/workflow-engine/src/actions/github/label-definitions.ts:100-115`) courtesy of #883, #892, and #898. Nothing in `@generacy-ai/workflow-engine` or the orchestrator needs to change for this fix.
- **Interaction with #883**: unchanged. `blocked:stuck-feedback-loop` keeps its `waiting`-tier pin at the top of `WAITING_PIPELINE_ORDER`; the #883 classifier tests continue to pass without modification because the enumerated allow-list is checked before the prefix rule.
- **Interaction with #892 / #898 handlers**: unchanged. Neither `validate-fix-handler.ts` nor `merge-conflict-handler.ts` needs edits — they already apply the labels; only the classifier's interpretation changes.

## Constitution check

No `.specify/memory/constitution.md` exists in this repo. Implicit project conventions:

- **Zod-only schema validation** — n/a (no external inputs; pure in-memory string set).
- **No secrets in logs** — n/a (no logging paths added; classifier is pure).
- **Fail-loud on internal boundary errors** — n/a (classifier returns a `ClassifyResult` for every input; no throw paths added).
- **No new dependencies** — confirmed.

## Project Structure

Changes span one package. All modifications sit alongside existing patterns; no new modules are introduced.

```
packages/cockpit/src/
├── state/
│   ├── label-map.ts             [MODIFY] Replace generic `blocked:*` → 'waiting' branch with enumerated ERROR_BLOCKED_LABELS lookup; leave the generic prefix as the fallback for unlisted blocked:* names.
│   └── precedence.ts            [MODIFY] Add ERROR_PIPELINE_ORDER; extend compareSourceLabels to handle tier === 'error'.
├── __tests__/
│   └── classifier.test.ts       [MODIFY] Add `#943: blocked:* error-tier labels` describe block. Preserve every existing test (including the `#883` block and the `canary: error beats stage-complete` case).

specs/943-summary-blocked-stuck-merge/
├── spec.md                      [read-only]
├── clarifications.md            [read-only]
├── plan.md                      [THIS FILE]
├── research.md                  [ADD]
├── data-model.md                [ADD]
├── quickstart.md                [ADD]
└── contracts/
    └── classifier-error-tier.md [ADD] Classifier contract for the enumerated error-tier blocked labels + intra-error tie-break table.
```

**Files NOT changing:**

- `packages/workflow-engine/src/actions/github/label-definitions.ts` — all three `blocked:*` labels already registered.
- `packages/orchestrator/src/worker/merge-conflict-handler.ts` / `validate-fix-handler.ts` — labels are already applied correctly; only interpretation changes.
- `packages/cockpit/src/state/classifier.ts` — the tier compare loop is agnostic to which tier the tie-break covers. Once `compareSourceLabels` knows about `error`, the classifier picks up the new behaviour with no local edit.
- `packages/cockpit/src/types.ts` — `CockpitState` union already contains `error`.
- `packages/generacy/src/cli/commands/cockpit/{watch,status,await-events}.ts` — delegate to `@generacy-ai/cockpit`; the new `sourceLabel` emerges from the classifier by construction.

## Classifier changes

### `packages/cockpit/src/state/label-map.ts`

Replace the current `waiting` branch of `classifyByPattern`:

```ts
// BEFORE
if (
  label.startsWith('waiting-for:') ||
  label.startsWith('needs:') ||
  label.startsWith('blocked:')
) return 'waiting';
```

with an enumerated allow-list checked before the generic prefix fallback:

```ts
// #943: enumerated blocked:* → error tier. Any blocked:* name not in this set
// (including blocked:stuck-feedback-loop from #883 and any future addition)
// still falls through to the waiting prefix branch below — safe default.
const ERROR_BLOCKED_LABELS: ReadonlySet<string> = new Set([
  'blocked:stuck-merge-conflicts',
  'blocked:stuck-validate-fix',
]);

if (ERROR_BLOCKED_LABELS.has(label)) return 'error';

if (
  label.startsWith('waiting-for:') ||
  label.startsWith('needs:') ||
  label.startsWith('blocked:')
) return 'waiting';
```

The set is module-scoped (mirroring the existing `TERMINAL_COMPLETED_LABELS` pattern at line 7). The `LABEL_TO_STATE` build at module load then picks up the new disposition for the two labels automatically, and `mapLabelToState` returns `'error'` for both.

### `packages/cockpit/src/state/precedence.ts`

Add a new pipeline list and extend `compareSourceLabels`:

```ts
// #943: intra-error tie-break — the two enumerated blocked:* labels outrank
// agent:error and failed:* so cockpit surfaces the specific escalation gate
// rather than the generic error handler. Full label set remains available on
// the classified state for consumers that want the generic signal.
export const ERROR_PIPELINE_ORDER: string[] = [
  'blocked:stuck-merge-conflicts',
  'blocked:stuck-validate-fix',
];
```

Extend `compareSourceLabels` with an `error` branch that mirrors the existing `waiting` / `stage-complete` branches:

```ts
if (tier === 'error') {
  const ai = ERROR_PIPELINE_ORDER.indexOf(a);
  const bi = ERROR_PIPELINE_ORDER.indexOf(b);
  if (ai !== -1 || bi !== -1) {
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  }
  // Neither listed: fall through to workflow-index comparison (existing behaviour).
}
```

Ordering rationale: `ERROR_PIPELINE_ORDER[0]` (merge-conflicts) is the label that triggered this fix and has the most-specific existing escalation gate (D.11). `ERROR_PIPELINE_ORDER[1]` (validate-fix) is the same handler-gave-up shape and gets the next slot. Two `blocked:*` labels co-occurring on one issue has never been observed, but the ordering is deterministic when it happens.

### `packages/cockpit/src/__tests__/classifier.test.ts`

Add a new `describe` block, keep every existing test. Tests follow the same shape as the `#883` and `#926` blocks already present:

```ts
describe('#943: blocked:* labels in the error tier', () => {
  it('blocked:stuck-merge-conflicts alone classifies as error', () => { ... });
  it('blocked:stuck-validate-fix alone classifies as error', () => { ... });
  it('blocked:stuck-feedback-loop stays in waiting (preserves #883)', () => { ... });
  it('unknown blocked:* prefix (e.g. blocked:future) stays in waiting (safe default)', () => { ... });

  it('blocked:stuck-merge-conflicts wins the sourceLabel slot over agent:error', () => { ... });
  it('blocked:stuck-merge-conflicts wins the sourceLabel slot over failed:validate', () => { ... });
  it('blocked:stuck-validate-fix wins the sourceLabel slot over agent:error', () => { ... });
  it('blocked:stuck-merge-conflicts wins over blocked:stuck-validate-fix by ERROR_PIPELINE_ORDER', () => { ... });

  it('cross-tier: error still beats waiting even though waiting-for:merge-conflicts coexists', () => {
    expect(
      classify(['waiting-for:merge-conflicts', 'blocked:stuck-merge-conflicts']),
    ).toEqual({ state: 'error', sourceLabel: 'blocked:stuck-merge-conflicts' });
  });

  it('agent:error alone still classifies as error (regression guard)', () => { ... });
  it('failed:plan alone still classifies as error (regression guard)', () => { ... });
});
```

The `#883: blocked:* labels classify as waiting` block stays exactly as-is (per CD-1's "#883 unit tests remain untouched"). The `canary: error beats stage-complete` case is unchanged; the new `error`-tier logic only kicks in when the `error` tier already has multiple candidates.

## Success criteria mapping

| Spec SC | How verified |
|---------|--------------|
| SC-001 (`blocked:stuck-merge-conflicts` classifies as `error`) | New classifier unit test + `mapLabelToState` unit test. |
| SC-002 (`sourceLabel` outranks `agent:error` and `failed:*` on co-occurrence) | Three cross-family tie-break unit tests (agent:error, failed:validate, cross-tier). |
| SC-003 (no unrecognized-state escalation for `blocked:stuck-merge-conflicts` on the next auto run) | Post-merge dogfood verification: re-run the snappoll auto run, watch for zero unrecognized-state escalations attributable to `blocked:stuck-merge-conflicts`. Recorded in the tasks file, not the classifier tests. |
| SC-004 (`blocked:stuck-validate-fix` classifies as `error`, same precedence) | Parallel unit tests to SC-001 / SC-002. |
| SC-005 (`blocked:stuck-feedback-loop` still classifies as `waiting`) | The `#883` block passes unchanged, plus a new explicit `#943` test asserting the fallback. |

## Rollout notes

- **No config or migration required.** Classifier is pure and rebuilds its lookup table at module load; a rolling deploy picks up the new disposition on the next process start.
- **Backwards compatibility**: consumers reading `sourceLabel` see the `blocked:stuck-*` name instead of `agent:error` or `failed:*` when both co-occur. Consumers reading the full label set (via `getIssue`) are unaffected. The cockpit CLI (`status`, `watch`, `await-events`) already renders `sourceLabel` verbatim.
- **Agency-side companion**: the D.11 escalation-gate route on the agent side is out of scope for this repo. This change ensures the correct signal reaches the transport layer; the routing consumer subscribes to it independently.
- **Test isolation**: the new tests live in the existing `classifier.test.ts` alongside `#883` and `#926` and do not touch shared fixtures. No cross-package test surface is affected.

## Suggested next step

`/speckit:tasks` to generate the task list from this plan.
