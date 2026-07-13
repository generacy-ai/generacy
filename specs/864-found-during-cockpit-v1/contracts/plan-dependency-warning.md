# Contract: `cockpit queue implement` — Plan Dependency Warning

FR-009 / US3. Warning-only in v1 per Q4-scope; hard-block deferred.

## Extractor

**Module**: `packages/generacy/src/cli/commands/cockpit/plan-dependency-extractor.ts`.

```ts
export function extractPlanDependencies(
  planMarkdown: string,
  defaultOwner: string,
  defaultRepo: string,
): DependencyRef[];
```

**Heuristic** (v1):

Scan the markdown line-by-line for `TRIGGER_VERBS = ['must be merged', 'must merge first', 'depends on', 'depends-on', 'requires', 'extends', 'blocked by', 'prerequisite']`.

For every line containing a trigger, extract all mentions matching:
- `#\d+` → resolves to `{ defaultOwner, defaultRepo, N }`.
- `[\w-]+/[\w-]+#\d+` → cross-repo mention.

Extract from the trigger line PLUS the line immediately following it (some plans wrap "#2 must be merged first" across a line break).

De-duplicate by `owner/repo/number`. Preserve first-occurrence order.

**Non-matches** (intentional false negatives — v1 scope):
- References inside fenced code blocks (` ``` `). Skipped.
- References inside inline code (`` `#2` ``). Skipped.
- Multi-line paragraph-level dependency descriptions without a trigger verb on the same or preceding line.

## Queue integration

`packages/generacy/src/cli/commands/cockpit/queue.ts` after `classifyRow` decides `eligibility.kind === 'eligible'` and `phase.heading` matches `/implement/i`:

```ts
1. Fetch plan.md via cockpitGh.runCmd(['gh', 'api', `repos/${ref.repo}/contents/specs/<slug>/plan.md`, '--jq', '.content'])
   — decode base64, tolerate 404 (no plan.md yet → skip check).
2. Extract deps with defaultOwner/defaultRepo = ref.owner/ref.repo.
3. For each dep, cockpitGh.fetchIssueState → determine state:
   - state === 'MERGED' or issue is closed with a merged PR → OK, no warning.
   - state === 'CLOSED' but no merged PR → 'closed-unmerged' warning.
   - state === 'OPEN' → 'unresolved' warning.
   - not found → 'unresolved' warning (assume caller typo'd the ref, still worth flagging).
4. Attach to QueueRow.dependencyWarnings.
```

## Rendering

Extend `renderPreview` (`queue.ts:116`):

```
  owner/repo#3  Title of issue (process:speckit-feature, assignee: someone)
    [WARN: depends-on owner/repo#2 not yet merged]
    [WARN: depends-on other-owner/other-repo#42 not yet merged]
```

Warnings indent two spaces deeper than the row line and precede the next row.

## Confirmation flow

Warnings do NOT block confirmation in v1. The operator sees them in the preview and can proceed or cancel. Standard `--yes` still works and does not require warning acknowledgment (FR-009: "warning is a warning, not a hard block").

## Exit code

`--yes` and confirm-yes with warnings → exit 0. Warnings alone do not change the exit code.

## Testability

- `plan-dependency-extractor.test.ts` — table-driven positive + negative cases against small markdown fixtures, no I/O.
- `queue.test.ts` fixture extended with a mocked `cockpitGh.runCmd` returning canned plan.md + issue states.
