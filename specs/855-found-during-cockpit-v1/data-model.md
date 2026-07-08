# Data Model: `gh pr checks` field-list fix + drift guard (#855)

This change introduces **no new persisted state**, **no new relay payloads**, and **no new interfaces** other than the wrapper's optional injected logger. It:

1. Deletes one field (`conclusion`) from `CheckRunSummary` and from the downstream `ReviewContextPayload.checks[]` shape.
2. Cleans the `CheckRunRawSchema` Zod schema to reflect gh's actual `pr checks --json` field vocabulary.
3. Adds one optional constructor arg to `GhCliWrapper` (a minimal `GhWrapperLogger` interface).
4. Adds one case to the internal `normalizeCheckState` switch (`'CANCEL' → 'CANCELLED'`).

Every change is source-compatible with existing consumers (nothing reads `.conclusion` today).

## Modified types

### `CheckRunSummary` (`packages/cockpit/src/gh/wrapper.ts`)

**Before**:

```ts
export interface CheckRunSummary {
  name: string;
  state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED';
  conclusion?: string;    // ← DELETED
  url?: string;
}
```

**After**:

```ts
export interface CheckRunSummary {
  name: string;
  state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED';
  url?: string;
}
```

Invariants:

- `state` is the normalized rollup (Q1→B). Wrapper-internal input to the normalization is `raw.state` (preferred) or `raw.bucket` (fallback) or `raw.status` (defensive). No `bucket` on the outward interface.
- `url` is mapped from gh's `raw.link` (Q5→A). Wrapper handles the field-name translation; consumers stay on `.url`.

### `CheckRunRawSchema` (`packages/cockpit/src/gh/wrapper.ts`)

**Before**:

```ts
const CheckRunRawSchema = z
  .object({
    name: z.string(),
    state: z.string().optional(),
    bucket: z.string().optional(),
    status: z.string().optional(),
    conclusion: z.string().nullable().optional(),   // ← DELETED
    detailsUrl: z.string().optional(),              // ← DELETED
    link: z.string().optional(),
  })
  .passthrough();
```

**After**:

```ts
const CheckRunRawSchema = z
  .object({
    name: z.string(),
    state: z.string().optional(),
    bucket: z.string().optional(),
    status: z.string().optional(),
    link: z.string().optional(),
  })
  .passthrough();
```

Notes:
- `.passthrough()` retained: gh may add unrelated fields (e.g., `startedAt`, `workflow`) in a future version; passthrough keeps the schema forward-compatible.
- Removing `conclusion` and `detailsUrl` from the explicit field declarations is a signal that they are NOT expected in gh's response for `pr checks --json`. If a future gh version resurrects them (unlikely), `.passthrough()` still tolerates them silently.

### `parseCheckRuns` mapping (`packages/cockpit/src/gh/wrapper.ts`)

**Before**:

```ts
return arr.data.map<CheckRunSummary>((raw) => ({
  name: raw.name,
  state: normalizeCheckState(raw),
  conclusion: raw.conclusion ?? undefined,          // ← DELETED
  url: raw.detailsUrl ?? raw.link ?? undefined,     // ← SIMPLIFIED
}));
```

**After**:

```ts
return arr.data.map<CheckRunSummary>((raw) => ({
  name: raw.name,
  state: normalizeCheckState(raw),
  url: raw.link ?? undefined,
}));
```

### `getPullRequestCheckRuns` field-list arg (`packages/cockpit/src/gh/wrapper.ts:597–610`)

**Before**:

```ts
const args = [
  'pr',
  'checks',
  String(prNumber),
  '--repo',
  repo,
  '--json',
  'name,state,conclusion,detailsUrl',   // ← THE BUG
];
```

**After**:

```ts
const args = [
  'pr',
  'checks',
  String(prNumber),
  '--repo',
  repo,
  '--json',
  'name,state,bucket,link',   // ← THE FIX (FR-001)
];
```

### `getPullRequestCheckRuns` error handling (new warn log)

**Before**:

```ts
const result = await this.runner('gh', args);
failIfNonZero(result, 'pr checks');
return parseCheckRuns(result.stdout);
```

**After**:

```ts
const result = await this.runner('gh', args);
if (result.exitCode !== 0) {
  this.logger.warn(
    { repo, prNumber, ghStderr: result.stderr.trim() },
    'gh pr checks failed',
  );
  throw new Error(`gh pr checks failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
}
return parseCheckRuns(result.stdout);
```

Invariants (FR-005):

- **I-1 (warn-once-per-failure)**: exactly one `logger.warn` per non-zero exit. Not on parse failure (schema mismatch), not on the happy path.
- **I-2 (structured fields, no free-form)**: fields are `{ repo, prNumber, ghStderr }`. No message templating; the message string is a constant literal `'gh pr checks failed'`.
- **I-3 (rethrow, don't swallow)**: after warn, throw the same error type as `failIfNonZero` did before. `merge`'s hard-fail behavior is byte-stable.
- **I-4 (no consumer catch change)**: silent-swallow sites in `status.ts` / `watch/poll-loop.ts` / `context.ts` are untouched (Out-of-Scope per spec).

### `GhCliWrapper` constructor (`packages/cockpit/src/gh/wrapper.ts:501–506`)

**Before**:

```ts
export class GhCliWrapper implements GhWrapper {
  private readonly runner: CommandRunner;

  constructor(runner: CommandRunner = nodeChildProcessRunner) {
    this.runner = runner;
  }
```

**After**:

```ts
export interface GhWrapperLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

const defaultGhWrapperLogger: GhWrapperLogger = {
  warn(obj, msg) {
    // eslint-disable-next-line no-console
    console.warn(msg, obj);
  },
};

export class GhCliWrapper implements GhWrapper {
  private readonly runner: CommandRunner;
  private readonly logger: GhWrapperLogger;

  constructor(
    runner: CommandRunner = nodeChildProcessRunner,
    logger: GhWrapperLogger = defaultGhWrapperLogger,
  ) {
    this.runner = runner;
    this.logger = logger;
  }
```

Invariants:

- **I-5 (backwards-compatible signature)**: `new GhCliWrapper(runner)` and `new GhCliWrapper()` continue to compile and behave as before (with a `console.warn` shim as the default logger). No caller update required for compilation.
- **I-6 (minimal logger surface)**: `GhWrapperLogger` exposes only `warn(obj, msg)`. Not `.info`, not `.debug`, not `.error`. This keeps the interface trivially compatible with pino, console, and test spies without dragging in the whole pino API.
- **I-7 (default shim is stderr, not silent)**: `console.warn` fires when no logger is injected. This makes gh failures visible everywhere out of the box; explicit silence requires an explicit `{ warn: () => {} }` injection.

### `normalizeCheckState` switch extension (`packages/cockpit/src/gh/wrapper.ts:303–327`)

**Before**:

```ts
case 'CANCELLED':
case 'CANCELED':
  return 'CANCELLED';
```

**After**:

```ts
case 'CANCELLED':
case 'CANCELED':
case 'CANCEL':                // ← NEW; matches gh's `bucket` vocabulary
  return 'CANCELLED';
```

Rationale: gh's `bucket` values are `pass`, `fail`, `pending`, `skipping`, `cancel`. Upper-cased, four already match; `CANCEL` was the missing one. Zero-cost defensive add; the primary path uses `raw.state` (which uses `CANCELLED`), so this fires only in the edge case where `state` is absent but `bucket` is present.

## Downstream types (`packages/generacy`)

### `ReviewContextPayload.checks[]` (`packages/generacy/src/cli/commands/cockpit/shared/review-context-json.ts`)

**Before**:

```ts
checks: Array<{
  name: string;
  state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED';
  conclusion?: string;    // ← DELETED
  url?: string;
}>;
```

**After**:

```ts
checks: Array<{
  name: string;
  state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED';
  url?: string;
}>;
```

And in `buildReviewContextPayload`:

**Before**:

```ts
checks: checks.map((c) => ({
  name: c.name,
  state: c.state,
  ...(c.conclusion != null ? { conclusion: c.conclusion } : {}),   // ← DELETED
  ...(c.url != null ? { url: c.url } : {}),
})),
```

**After**:

```ts
checks: checks.map((c) => ({
  name: c.name,
  state: c.state,
  ...(c.url != null ? { url: c.url } : {}),
})),
```

Consumer impact: none. `conclusion` has never been populated (dead-on-arrival). Downstream cockpit-plugin consumers (out-of-repo) that emit review-context JSON never received a `conclusion` field, so removing it from the emit shape is source-compatible.

## Types referenced (unchanged)

- `GhWrapper` interface (`wrapper.ts:101–132`) — `getPullRequestCheckRuns` signature is unchanged. Only the return-value shape narrows (drop `conclusion`).
- `CommandRunner` (`wrapper.ts:command-runner.ts`) — unchanged.
- `PullRequestDetail`, `PullRequestSummary`, `IssueStateResult`, etc. — unchanged.
- `FailingCheck` (`shared/required-checks.ts`) — unchanged. `.url` still read.

## New types

### `GhWrapperLogger` (new export from `packages/cockpit/src/gh/wrapper.ts`)

```ts
export interface GhWrapperLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}
```

- Exported so consumers can inject their own logger (e.g., a pino instance).
- Structurally compatible with `pino.Logger` (which has `warn(obj: object, msg: string): void`).
- Structurally compatible with `console` (with the arg order slightly different; the default shim handles the reversal).

## Test-only types (drift suite)

### `JsonFieldListSite` (internal to `packages/cockpit/src/gh/__tests__/json-field-drift.test.ts`)

```ts
interface JsonFieldListSite {
  fieldList: string;     // e.g., 'name,state,bucket,link'
  line: number;          // 1-indexed line number in wrapper.ts
  ghSubcommand: string;  // e.g., 'pr checks' (best-effort inferred; used only for test naming)
}
```

- Not exported. Used only for test-case naming and error messages.
- Populated by the regex extractor; every match yields one entry.
- The suite iterates the array, spawning one `gh` process per entry.

## Label-source invariant (unchanged by this PR)

The #853 fix's invariant ("workflow labels live on the issue") is orthogonal to #855. No change here.

## Payload emission (unchanged)

`FailingCheckPayload` from #853 is unchanged. `runMerge`'s red branches are unchanged. This PR touches only the `getPullRequestCheckRuns` call inside step 7 of `runMerge`'s decision tree (checks classification). When the wrapper starts returning populated `CheckRunSummary[]`, `classifyChecks` sees `state` values as before — the code path is identical, but the data is now real.
