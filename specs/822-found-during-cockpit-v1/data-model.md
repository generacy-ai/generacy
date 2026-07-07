# Data Model: Cockpit CLI status/watch argument-contract drift

**Feature**: `822-found-during-cockpit-v1` | **Date**: 2026-07-07

This bug fix touches CLI-verb signatures and internal call graphs; it introduces no new persisted types or wire schemas. The section below documents the interface deltas.

## Types touched

### `StatusCliOptions` — `packages/generacy/src/cli/commands/cockpit/status.ts:17`

**Before**:
```ts
interface StatusCliOptions {
  epic?: string;
  json?: boolean;
}
```

**After**:
```ts
interface StatusCliOptions {
  json?: boolean;
}
```

The positional `<epic-ref>` argument is passed as the first parameter of the `runStatus` function; `--epic` is deleted (no compat shim — FR-003, pre-1.0). The `--json` flag is unchanged.

### `runStatus` signature — `status.ts:34`

**Before**:
```ts
export async function runStatus(
  options: StatusCliOptions,
  deps: StatusDeps = {},
): Promise<number>
```

**After**:
```ts
export async function runStatus(
  epicRef: string | undefined,
  options: StatusCliOptions,
  deps: StatusDeps = {},
): Promise<number>
```

Callers are the Commander action handler in `statusCommand()` and the existing tests (`status.test.ts`, `status.color.test.ts`, `status.render.test.ts`, `failing-check-json.test.ts` — audit for any callers).

### `WatchOptions` — `packages/generacy/src/cli/commands/cockpit/watch.ts:13`

**Before**:
```ts
interface WatchOptions {
  epic?: string;
  interval?: string;
  safetyCap?: string;
}
```

**After**:
```ts
interface WatchOptions {
  interval?: string;
  safetyCap?: string;
}
```

### `runWatch` signature — `watch.ts:71`

**Before**:
```ts
export async function runWatch(
  options: WatchOptions,
  deps: WatchDeps = {},
): Promise<number>
```

**After**:
```ts
export async function runWatch(
  epicRef: string | undefined,
  options: WatchOptions,
  deps: WatchDeps = {},
): Promise<number>
```

### `runQueue` signature — `queue.ts:184`

**Unchanged** — already takes `epicRef: string | undefined` as first positional. Only the internal call chain changes (see call-graph delta below).

### `IssueRef`, `ResolveIssueContextInput`, `ResolvedIssueContext` — `resolver.ts:21-48`

**Unchanged.** The helper already exports every type needed. No new fields.

### `parseIssueRef` error message — `resolver.ts:106-108`

**Before** (garbage-input branch):
```
unrecognized issue ref "<input>". Use <owner>/<repo>#<n> or https://github.com/<owner>/<repo>/issues/<n>.
```

**After**:
```
unrecognized issue ref "<input>". Use <n>, <owner>/<repo>#<n>, or https://github.com/<owner>/<repo>/issues/<n>.
```

FR-007: enumerated forms list now includes the bare number.

### `parseIssueRef` bare-number rejection message — `resolver.ts:99-104`

**Unchanged in shape** (still emitted by `parseIssueRef` when a bare number is passed to it directly), but no longer user-visible — `resolveIssueContext` swallows it and falls through to git-origin inference (`resolver.ts:150-153`). The message is only observable in the narrow tests that call `parseIssueRef` directly.

## Call graph delta

### `status.ts` — before

```text
statusCommand().action(options)
  └─> runStatus(options, deps)
        ├─> [check options.epic non-null]
        └─> resolveEpic({ epicRef: options.epic, gh, logger })
              └─> parseEpicRef(...)   [private, sync, in @generacy-ai/cockpit]
```

### `status.ts` — after

```text
statusCommand().action(epicRef, options)
  └─> runStatus(epicRef, options, deps)
        ├─> [check epicRef non-null]
        ├─> resolveIssueContext({ issue: epicRef, gh })   [NEW call; may spawn `git remote get-url origin` on bare-number]
        │     └─> parseIssueRef(input)   [pure; throws on bare number → helper falls through]
        │     └─> inferRepoFromGitOrigin(runner, cwd)   [only on bare-number path]
        └─> resolveEpic({ epicRef: `${resolved.ref.nwo}#${resolved.ref.number}`, gh, logger })
              └─> parseEpicRef(...)   [unchanged]
```

### `watch.ts` — same shape

Additional detail: `runWatch` resolves once at command start; the poll loop re-uses the **expanded** `owner/repo#N` string when it re-`resolveEpic`s each interval. **The bare-number inference does not repeat per poll.**

### `queue.ts` — before

```text
queueCommand().action(epicRef, phaseArg, opts)
  └─> runQueue(epicRef, phaseArg, opts, deps)
        └─> resolveEpic({ epicRef, gh })
```

### `queue.ts` — after

```text
queueCommand().action(epicRef, phaseArg, opts)
  └─> runQueue(epicRef, phaseArg, opts, deps)
        ├─> resolveIssueContext({ issue: epicRef, gh })   [NEW call]
        └─> resolveEpic({ epicRef: `${resolved.ref.nwo}#${resolved.ref.number}`, gh })
```

`matchPhaseHeading`, `pickTargetRepo`, and the rest of the queue pipeline are unaffected.

## Validation / Invariants

- **Empty input** (`epicRef == null || epicRef.trim() === ''`): each verb emits `Error: cockpit <verb>: parse issue: issue argument is required` and returns exit 2. (Preserves current behavior for the empty-string case, unified through `resolveIssueContext`.)
- **Unrecognized garbage** (`parseIssueRef` throws non-bare-number): emit `Error: cockpit <verb>: parse issue: unrecognized issue ref "<input>". Use <n>, <owner>/<repo>#<n>, or https://github.com/<owner>/<repo>/issues/<n>.` Exit 2.
- **Bare number, cwd has no resolvable git origin**: emit `Error: cockpit <verb>: parse issue: could not infer owner/repo: 'git remote get-url origin' failed …`. Exit 2. (FR-008: same error mechanism as FR-007.)
- **Bare number, cwd has resolvable origin**: silently expands to `<owner>/<repo>#<n>` and proceeds. Test coverage: `resolver.test.ts` + one integration test per verb.
- **`owner/repo#N` and full-URL forms**: unchanged behavior (FR-005, FR-006).

## Backward-compat / migration

- **`--epic` flag on `status`/`watch`**: **deleted**. Any existing script that passes `--epic owner/repo#N` will fail at Commander parse with a "unknown option" error. Pre-1.0, this is acceptable (spec §Out-of-Scope, FR-003). Grep for callers:
  ```bash
  rg -F "--epic" packages/generacy packages/cockpit
  ```
  Expected: only test fixtures and the two removed lines. Remove all.
- **Plugin markdown**: unchanged. `claude-plugin-cockpit`'s `status.md` and `watch.md` already pass `$ARGUMENTS` positionally (SC-005).
- **`queue`'s argument surface**: byte-identical (FR-009).

## Test surface

Extension points, all under `packages/generacy/src/cli/commands/cockpit/__tests__/`:

- `resolver.test.ts` — extend `parseIssueRef` error-message expectation to include the bare number; add `resolveIssueContext` cases for the injected-runner bare-number-with-origin path (helpers already model this).
- `status.test.ts` — migrate existing fixtures from `{ epic: 'owner/repo#42' }` to positional `'owner/repo#42'` first arg. Add: (a) bare-number resolves via injected runner; (b) invalid ref emits `cockpit status: parse issue: …` + exit 2.
- `watch.test.ts` — same fixture migration + coverage for (a) and (b) as above. Regression-guard: the bare-number inference does not fire per poll (assert `runner('git', …)` call count).
- `queue.test.ts` — one new test: `runQueue(1, 'implement', …)` with an injected runner that resolves origin → `owner/repo` succeeds and produces `owner/repo#1` as the epic ref.

No new test files. All existing test infrastructure (helpers, `FakeGh`, fixtures) is re-used.
