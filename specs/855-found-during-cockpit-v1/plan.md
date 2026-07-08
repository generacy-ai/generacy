# Implementation Plan: `gh pr checks` field-list fix + `--json` drift guard

**Feature**: Correct `getPullRequestCheckRuns`'s `gh pr checks --json` field list (`name,state,bucket,link`), drop the dead `conclusion` passthrough on `CheckRunSummary`, emit a wrapper-level `warn` on failure with structured fields, and add a colocated vitest drift suite that runs every wrapper `--json` field list through the real pinned `gh` binary in CI.
**Branch**: `855-found-during-cockpit-v1`
**Date**: 2026-07-08
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md)
**Status**: Complete

## Summary

Root cause: `getPullRequestCheckRuns` at `packages/cockpit/src/gh/wrapper.ts:597–610` calls `gh pr checks --json name,state,conclusion,detailsUrl`. Two of those field names have never existed on `gh pr checks`. `gh`'s client-side `--json` validator rejects the whole call before any network hop, so the wrapper has hard-failed on every gh version, every invocation, since rev 2. `merge` re-raises this as `gh pr checks failed (exit 1): Unknown JSON field: "conclusion"` (finding #20 of the cockpit v1 smoke test). `status` / `watch` / `context` swallow the same exception in bare `catch { … }` blocks and silently render the checks column as `- / none` — the week-old blank-column observation. Unit tests hid this because they use mock CommandRunner fixtures that answer with the shape the code *expects*, not the shape `gh` actually returns (same tests-encode-the-bug pattern as #800/#826/#836/#853, but this time the drifted interface is `gh`'s).

Fix (four coordinated changes, all inside `packages/cockpit`, plus one downstream type cleanup in `packages/generacy`):

1. **Field-list swap** — `getPullRequestCheckRuns`'s `--json` arg becomes `'name,state,bucket,link'`. `parseCheckRuns` maps `raw.bucket` into the existing `normalizeCheckState` rollup (`pass`/`fail`/`pending`/`skipping`/`cancel` → `SUCCESS`/`FAILURE`/`PENDING`/`SKIPPED`/`CANCELLED`). `raw.link` maps to `CheckRunSummary.url` (Q5→A: outward field name stays `url`).
2. **`CheckRunSummary.conclusion` deletion** — Q1→B: the passthrough field disappears from the interface, the Zod raw schema, and `parseCheckRuns`. Downstream `review-context-json.ts` drops its `conclusion?` optional field emission. No consumer has ever seen a populated `conclusion` because the field name was rejected client-side; deleting it is source-compatible for every real consumer.
3. **Wrapper-level warn log on failure** — Q2→A: `getPullRequestCheckRuns` emits `logger.warn({ repo, prNumber, ghStderr }, 'gh pr checks failed')` before rethrowing. `GhCliWrapper` gains an optional `logger` constructor arg (minimal `{ warn(obj, msg): void }` shape, `console.warn`-fallback when absent). Consumer catch-blocks in `merge` / `status` / `watch` / `context` are untouched — `merge` still hard-fails on rethrow, silent-swallowers still degrade to `none`.
4. **Colocated vitest drift suite** — Q3→A + Q4→A: new file `packages/cockpit/src/gh/__tests__/json-field-drift.test.ts`. Statically extracts every `'--json',\n\s+'<literal>'` follow-up in `wrapper.ts` via literal grep, fails the suite hard if any follow-up is not a string literal (SC-005), and — under `describe.runIf(hasGhBinary)` — spawns the pinned `gh` binary once per extracted field list against a dummy ref (any non-existent PR number is fine; gh's client-side `--json` validation fires before the network call). Any `Unknown JSON field` in stderr fails the test with the offending field name and the exact wrapper line. This closes the entire "gh interface drift invisible to mocked tests" class for every current wrapper method (FR-008) and every future one (SC-004).

Everything else (`merge`'s decision tree, `status` row assembly, `watch`'s snapshot/transition machinery, `context`'s review bundle) is untouched. The blast radius stops at the wrapper boundary.

Companion downstream cleanup (single-package, `packages/generacy`): `ReviewContextPayload.checks[]` drops its `conclusion?: string` field (data-model.md details). This is a pure type-narrowing — nothing sets or reads the field today.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js ≥22 (per `packages/cockpit/package.json` and root `package.json`).
**Primary Dependencies**: `zod` (raw-schema updates), `pino` (consumer-side loggers, forwarded through to the injected wrapper logger where callers have one); `vitest` for tests. The drift suite spawns the `gh` binary via `node:child_process.spawnSync` — no new deps.
**Storage**: N/A — CLI-side wrapper fix. No persisted state, no relay payloads.
**Testing**: `vitest`. Two test files touched/created:
- `packages/cockpit/src/__tests__/gh-wrapper.test.ts` (MODIFIED — parse fixtures switch from `conclusion`/`detailsUrl` to `bucket`/`link`; new warn-log assertion; `conclusion` no longer asserted on returned summaries).
- `packages/cockpit/src/gh/__tests__/json-field-drift.test.ts` (NEW — drift suite; `describe.runIf(hasGhBinary)`).

Downstream:
- `packages/generacy/src/cli/commands/cockpit/__tests__/merge.test.ts`, `context.*.test.ts`, `watch.check-rollup.test.ts`, `helpers/fake-gh.ts` — fixtures drop `conclusion` from `CheckRunSummary` shapes (no assertion changes).

**Target Platform**: Node CLI (`generacy cockpit merge|status|watch|context`) executed on operator workstations and inside cluster orchestrator processes. gh binary version: pinned by CI workflows to `gh` 2.96.x+ (verified field set: `bucket, completedAt, description, event, link, name, startedAt, state, workflow`).

**Project Type**: Monorepo package fix. Primary: `packages/cockpit` (the wrapper). Downstream: one shared type file in `packages/generacy` (`review-context-json.ts`) and its unit test fixtures. No orchestrator changes.

**Performance Goals**: N/A. The drift suite adds ~1 `spawnSync` per `--json` field list in `wrapper.ts` (13 today) per CI run; each invocation is network-free (client-side validation only) and returns in well under 500 ms.

**Constraints**:
- **Outward `CheckRunSummary` shape**: `{ name, state, url? }` (Q5→A keeps `url`; Q1→B drops `conclusion`). No `bucket` on the outward interface — it lives only inside `parseCheckRuns` as an input to `normalizeCheckState`.
- **Injected logger is optional and structured-only**. The wrapper accepts `logger?: { warn(obj, msg): void }`. When absent, warn falls through to `console.warn`. No hard dependency on pino at the wrapper layer.
- **`merge`'s hard-fail preserved**. The wrapper rethrows after warn; `merge` catches nothing new — its existing bubbling behavior is untouched. FR-005 explicitly requires this (rethrow-not-swallow).
- **Silent consumers keep their bare catches**. `status.ts:125`, `watch/poll-loop.ts:99`, `context.ts:287` still degrade to `none` / `[]`. The visible symptom is unchanged; the wrapper log line becomes the operator's signal. (This is deliberate — refactoring consumer degrade behavior is spec Out-of-Scope.)
- **Static extraction is grep, not AST** (Q4→A). Non-literal `--json` follow-ups fail the drift suite. That failure mode is a feature: it forbids dynamic field lists forever, so drift always stays statically checkable.
- **`describe.runIf(hasGhBinary)`** gate is required (Q3→A). Vitest ≥1.6 (pinned in `packages/cockpit`) supports this API. `hasGhBinary` = `spawnSync('gh', ['--version']).status === 0` in the test file, evaluated once at module load.
- **No `ts-morph` / no AST dependency**. Grep + literal enforcement is deliberate (Q4→A).
- **No consumer field-name changes**. `url` stays `url` on `CheckRunSummary` (Q5→A); `context.ts` / `required-checks.ts` / `review-context-json.ts` still read `.url` unchanged.

**Scale/Scope**: 1 wrapper file modified (`packages/cockpit/src/gh/wrapper.ts`), 1 shared type file modified (`packages/generacy/.../shared/review-context-json.ts`), 1 test file modified (`packages/cockpit/src/__tests__/gh-wrapper.test.ts`), 1 test file created (`packages/cockpit/src/gh/__tests__/json-field-drift.test.ts`), ~5 downstream fixture files touched to drop `conclusion` (all under `packages/generacy/src/cli/commands/cockpit/__tests__/`). ~30 LOC production change, ~120 LOC test change (drift suite is the bulk).

## Constitution Check

*GATE: no constitution file at `.specify/memory/constitution.md`. Repository-wide invariants from `CLAUDE.md`, prior cockpit fixes (#800/#826/#836/#845/#853), and this spec's clarifications:*

| Gate | Result | Note |
|------|--------|------|
| No new backwards-compat shims for removed code | PASS | `conclusion` is deleted outright from `CheckRunSummary` and `ReviewContextPayload.checks[]`. No `conclusion?: string` retained "for old consumers" — there are no old consumers (dead-on-arrival). |
| Change matches the spec's Q&A intent, not just the letter | PASS | Q1→B (drop passthrough, no `bucket` on outward interface), Q2→A (wrapper-level warn, rethrow), Q3→A (colocated vitest with `runIf`), Q4→A (grep + literal enforcement), Q5→A (`url` stays `url`) are all honored — not the narrower or wider alternatives. |
| Tests hit real behavior, not mocks-of-mocks | PASS | The drift suite runs the *real* pinned `gh` binary; that's the whole point (SC-005). Existing wrapper unit tests still use `fakeRunner` fixtures for shape assertions — but the drift suite is the counterexample that catches interface drift the mocks would miss. |
| Counterexample fixture for the tests-encode-the-bug pattern (#800/#826/#836/#853) | PASS | The drift suite IS the counterexample fixture for this class of bug: it fails on any `--json` field name the pinned `gh` rejects, including a hypothetical revert to `conclusion,detailsUrl` (SC-004). One test file covers every wrapper method at once. |
| Structured logging conventions | PASS | New `logger.warn({ repo, prNumber, ghStderr }, 'gh pr checks failed')` follows the existing pino key/value pattern. The wrapper's minimal `{ warn(obj, msg) }` interface is trivially compatible with pino, console, or a test spy. |
| Zero new runtime dependencies | PASS | Uses existing `zod`, existing test rig, `node:child_process` for the drift suite. No `ts-morph`, no additional packages. |
| Fail-loud, don't silently degrade | PASS at the wrapper boundary | Wrapper warns before rethrow. Consumer-side degrade behavior is preserved (Out-of-Scope per spec) — but the wrapper log line is now the operator's leading indicator, making the previously invisible failure surface within seconds. |

Post-Phase-1 re-check: no violations introduced.

## Project Structure

### Documentation (this feature)

```text
specs/855-found-during-cockpit-v1/
├── spec.md              # (present, unchanged by /plan)
├── clarifications.md    # (present, unchanged by /plan)
├── plan.md              # THIS FILE
├── research.md          # Phase 0 output — decisions + rationale
├── data-model.md        # Phase 1 output — type extensions & deletions
├── quickstart.md        # Phase 1 output — verification steps
├── contracts/
│   ├── check-run-summary.md          # Interface delta (drop `conclusion`, keep `url`)
│   ├── get-pull-request-check-runs.md # Wrapper method contract (post-fix behavior + warn semantics)
│   └── json-field-drift-suite.md     # Drift suite behavioral contract (extraction, gh invocation, failure modes)
└── checklists/          # (empty)
```

### Source Code (repository root)

```text
packages/cockpit/src/gh/
├── wrapper.ts                                     # MODIFIED — see delta below
└── __tests__/
    └── json-field-drift.test.ts                   # NEW — Phase 2 T-drift
                                                   # (colocated with wrapper.ts; new __tests__ dir under gh/)

packages/cockpit/src/__tests__/
└── gh-wrapper.test.ts                             # MODIFIED — parse fixtures use bucket/link; warn-log spec

packages/generacy/src/cli/commands/cockpit/shared/
└── review-context-json.ts                         # MODIFIED — drop `conclusion?: string` from ReviewContextPayload.checks[]

packages/generacy/src/cli/commands/cockpit/__tests__/
└── (fixtures)                                     # MODIFIED — drop `conclusion` from CheckRunSummary shapes in:
                                                   #  - helpers/fake-gh.ts
                                                   #  - merge.test.ts
                                                   #  - context.*.test.ts (implementation-review, clarification, artifact-paths, exit-codes)
                                                   #  - watch.check-rollup.test.ts (already uses only `state` — verify no change needed)
```

### `wrapper.ts` delta (source)

```diff
 export interface CheckRunSummary {
   name: string;
   state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED';
-  conclusion?: string;
   url?: string;
 }

 const CheckRunRawSchema = z
   .object({
     name: z.string(),
     state: z.string().optional(),
     bucket: z.string().optional(),
     status: z.string().optional(),
-    conclusion: z.string().nullable().optional(),
-    detailsUrl: z.string().optional(),
     link: z.string().optional(),
   })
   .passthrough();

 function parseCheckRuns(stdout: string): CheckRunSummary[] {
   // …
   return arr.data.map<CheckRunSummary>((raw) => ({
     name: raw.name,
     state: normalizeCheckState(raw),
-    conclusion: raw.conclusion ?? undefined,
-    url: raw.detailsUrl ?? raw.link ?? undefined,
+    url: raw.link ?? undefined,
   }));
 }

+export interface GhWrapperLogger {
+  warn(obj: Record<string, unknown>, msg: string): void;
+}
+
+const defaultGhWrapperLogger: GhWrapperLogger = {
+  warn(obj, msg) {
+    // eslint-disable-next-line no-console
+    console.warn(msg, obj);
+  },
+};

 export class GhCliWrapper implements GhWrapper {
   private readonly runner: CommandRunner;
+  private readonly logger: GhWrapperLogger;

-  constructor(runner: CommandRunner = nodeChildProcessRunner) {
+  constructor(
+    runner: CommandRunner = nodeChildProcessRunner,
+    logger: GhWrapperLogger = defaultGhWrapperLogger,
+  ) {
     this.runner = runner;
+    this.logger = logger;
   }

   async getPullRequestCheckRuns(repo: string, prNumber: number): Promise<CheckRunSummary[]> {
     const args = [
       'pr',
       'checks',
       String(prNumber),
       '--repo',
       repo,
       '--json',
-      'name,state,conclusion,detailsUrl',
+      'name,state,bucket,link',
     ];
     const result = await this.runner('gh', args);
-    failIfNonZero(result, 'pr checks');
+    if (result.exitCode !== 0) {
+      this.logger.warn(
+        { repo, prNumber, ghStderr: result.stderr.trim() },
+        'gh pr checks failed',
+      );
+      throw new Error(`gh pr checks failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
+    }
     return parseCheckRuns(result.stdout);
   }
```

`normalizeCheckState` already handles `bucket`'s vocabulary (`PASS`, `FAIL`, `SKIPPING` are in the switch). No change to that helper — `bucket` values (`pass`, `fail`, `pending`, `skipping`, `cancel`) upper-case cleanly into existing cases. `cancel` maps to `CANCELLED` (missing today — need one-line addition in `normalizeCheckState` switch).

Minor addition to `normalizeCheckState` (unlisted in the diff above but required):

```diff
     case 'CANCELLED':
     case 'CANCELED':
+    case 'CANCEL':
       return 'CANCELLED';
```

### `review-context-json.ts` delta (downstream)

```diff
   checks: Array<{
     name: string;
     state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED';
-    conclusion?: string;
     url?: string;
   }>;

   // …
   checks: checks.map((c) => ({
     name: c.name,
     state: c.state,
-    ...(c.conclusion != null ? { conclusion: c.conclusion } : {}),
     ...(c.url != null ? { url: c.url } : {}),
   })),
```

External (out-of-repo, tracked for closure but NOT changed by this PR):

```text
tetrad-development/docs/label-protocol.md                   # unrelated; reference-only
cockpit plugin repo (out-of-repo)                            # never read conclusion — unaffected
```

**Structure Decision**: Single-package fix in `packages/cockpit/src/gh/wrapper.ts` (the wrapper). One shared-type cleanup in `packages/generacy/.../review-context-json.ts` (drop `conclusion?` from the payload's checks shape) and mechanical fixture updates in `packages/generacy/.../__tests__/`. No orchestrator, no cluster-relay, no control-plane changes. Drift suite lives colocated with the wrapper in a new `packages/cockpit/src/gh/__tests__/` directory (Q3→A).

## Design Overview

### Behavioral change — `getPullRequestCheckRuns`

**Before** (`wrapper.ts:597–610`):

```
1. runner('gh', ['pr', 'checks', N, '--repo', R, '--json', 'name,state,conclusion,detailsUrl'])
   → gh rejects client-side: `Unknown JSON field: "conclusion"` on stderr, exit 1
2. failIfNonZero throws.
3. Callers either bubble (merge → user-visible hard fail) or silently catch (status/watch/context → `- / none`).
```

**After**:

```
1. runner('gh', ['pr', 'checks', N, '--repo', R, '--json', 'name,state,bucket,link'])
   → gh accepts, returns JSON array of {name, state, bucket, link, …} per check run.
2. parseCheckRuns validates the Zod raw schema, maps:
     name        → CheckRunSummary.name
     bucket|state → normalizeCheckState → CheckRunSummary.state
     link        → CheckRunSummary.url
3. Consumers get populated data.
4. On failure (network, auth, malformed JSON), wrapper logs
     logger.warn({ repo, prNumber, ghStderr }, 'gh pr checks failed')
   and rethrows the same error type as before. merge still hard-fails; status/watch/context still degrade — but the operator now has a warn log per failure.
```

### `CheckRunSummary` interface (post-fix)

```ts
export interface CheckRunSummary {
  name: string;
  state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED';
  url?: string;
}
```

No `conclusion`. No `bucket`. `bucket` is a wrapper-internal input to `normalizeCheckState`; the outward semantics are `state` (Q1→B). See `contracts/check-run-summary.md`.

### Injected logger

```ts
export interface GhWrapperLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

// Constructor:
new GhCliWrapper(runner, logger?)  // logger defaults to console.warn shim
```

Call-site rewiring:
- `resolver.ts:166,170` — instantiates `new GhCliWrapper(runner)`. Left unchanged (defaults to console shim). Follow-up (out-of-scope for this PR): thread the resolver's caller logger through when available.
- `queue.ts:224,225` — same, unchanged.
- `merge.ts` / `status.ts` / `watch/poll-loop.ts` / `context.ts` — do not instantiate the wrapper; they receive it from the resolver / queue helpers. When the resolver later threads a logger, all downstream benefits are automatic.
- Tests: `packages/cockpit/src/__tests__/gh-wrapper.test.ts` new test case injects a `vi.fn()`-backed logger and asserts one `warn` call with `{ repo, prNumber, ghStderr }` on the non-zero-exit path.

### Drift suite — extraction contract

Extraction algorithm (colocated in `json-field-drift.test.ts`):

```
1. Read packages/cockpit/src/gh/wrapper.ts as UTF-8 source text.
2. Regex-match every occurrence of:
       /'--json',\s*\n\s*'([^']+)'/g
   The first capture group is the field list.
3. If a "'--json'," follow-up in the file does NOT match the pattern
   (i.e., the token after '--json' on the next non-blank line is not a
   single-quoted string literal), the extractor emits a synthetic test
   that fails with a message naming the offending line (SC-005).
4. For every extracted field list, a test case runs:
       spawnSync('gh', ['pr', 'checks', '999999999', '--repo', 'octocat/hello-world',
                        '--json', <fieldList>], { encoding: 'utf-8', timeout: 5000 })
   Assertion: /unknown json field/i.test(result.stderr) === false.
   Exit code, other stderr content, and stdout are ignored — we only care
   about the client-side --json validator's error prefix.
```

Notes:
- The dummy `--repo` (`octocat/hello-world`) exists; the `999999999` PR doesn't. gh's client-side `--json` validation fires before the network hop, so the test is auth-free and network-free (spec Assumption #2, verified on gh 2.96.0).
- The regex intentionally requires the `--json` string literal and its follow-up literal to be on the next non-blank line (matches every current call site in `wrapper.ts`). If a future call site formats differently (e.g., single-line), the extractor will miss it — and the "no `'--json',` follow-up is non-literal" enforcement fails with a clear error, forcing the author to reformat or adjust the extractor regex. This is deliberate (Q4→A: keep field lists in the statically-checkable form forever).
- All 13 current call sites match today (verified by grep in Phase 0):
  - `search issues` — `number,title,state,labels,url,body,author,createdAt`
  - `issue view` (getIssue) — `number,title,state,labels,url,body,author,createdAt`
  - `pr checks` — `name,state,bucket,link` (POST-FIX)
  - `issue view` (resolveIssueToPR) — `closedByPullRequestsReferences,timelineItems`
  - `pr view` — `number,state,mergedAt,closedAt,url,isDraft,labels`
  - `pr list` (resolveIssueToPRRef search) — `number,url,state,isDraft,headRefName`
  - `issue view` (resolveIssueToPRRef fallback) — `closedByPullRequestsReferences`
  - `pr view` (detail) — `number,title,url,baseRefName,headRefName,body,author,state,isDraft,labels`
  - `pr view` (mergeCommit) — `mergeCommit`
  - `issue view` (fetchIssueLabels) — `labels`
  - `issue view` (fetchIssueState) — `state,stateReason,closedAt,labels,assignees,title` (post-#853)
  - `issue view` (fetchIssueComments) — `comments`
  - `pr list` (findOpenPrForBranch) — `url,number`
- Each field list gets one test case, with a descriptive name like `'--json' argument at wrapper.ts:605 — "name,state,bucket,link"`.

### Test fixture updates (`packages/cockpit/src/__tests__/gh-wrapper.test.ts`)

- **Current** `getPullRequestCheckRuns` positive test (lines 196–210) uses fixture `{ name, state, conclusion, detailsUrl }`. Update to `{ name, state: 'pass', bucket: 'pass', link: 'https://x' }`. Assertion drops `conclusion`, keeps `url === 'https://x'` (mapped from `link`).
- **New** test case (Q2→A):
  ```ts
  it('emits warn log and rethrows on non-zero exit', async () => {
    const logger = { warn: vi.fn() };
    const runner: CommandRunner = async () => ({
      stdout: '',
      stderr: 'Unknown JSON field: "foo"',
      exitCode: 1,
    });
    const wrapper = new GhCliWrapper(runner, logger);
    await expect(wrapper.getPullRequestCheckRuns('o/r', 99)).rejects.toThrow(/gh pr checks failed/);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { repo: 'o/r', prNumber: 99, ghStderr: 'Unknown JSON field: "foo"' },
      'gh pr checks failed',
    );
  });
  ```

### Downstream fixture cleanup

Files under `packages/generacy/src/cli/commands/cockpit/__tests__/` that reference `conclusion` in `CheckRunSummary` shapes (verified via grep) — all removals are of the `conclusion?: string` field emission or assertion:

- `helpers/fake-gh.ts` — `CheckRunSummary` return shapes drop `conclusion`.
- `merge.test.ts` — `getPullRequestCheckRuns: [...]` fixtures drop `conclusion` (grep verifies none set today, but audit in the same pass).
- `context.implementation-review.test.ts` / `context.clarification.test.ts` / `context.artifact-paths.test.ts` / `context.exit-codes.test.ts` — same audit; no field to remove in most cases (fixtures already omit `conclusion`).
- `watch.check-rollup.test.ts` — uses only `state`; no change.

`review-context-json.ts` payload consumers: none set `conclusion` today (verified). The `additionalProperties` behavior of the emitted JSON is source-compatible for cockpit-plugin consumers (they never received a `conclusion` field because gh never returned one).

### Non-changes (deliberate)

- **`fetchIssueState`, `search issues`, other wrapper methods** — audited by the drift suite; if any current field list has a name gh rejects, this PR fixes it in the same pass (FR-008). Preliminary manual check: all 12 other field lists appear valid per gh 2.96.0's schema. Any surprise from the drift suite in Phase 3 is fixed as part of this PR.
- **Consumer degrade behavior** — `status.ts:125` / `watch/poll-loop.ts:99` / `context.ts:287` catches stay. Refactoring these is Out-of-Scope per spec.
- **`bucket` on outward `CheckRunSummary`** — deliberately absent (Q1→B). `state` carries the same information.
- **Field-name rename `url` → `link`** — declined (Q5→A). `url` is our domain vocabulary; matches existing consumer code; renaming three consumers for zero information gain would be churn.
- **`ts-morph` / AST extraction** — declined (Q4→A). Grep + literal enforcement forbids dynamic field lists, which is the correct forward-compat stance.
- **Resolver / queue logger threading** — out-of-scope for this PR. The wrapper accepts `logger?`; default is a `console.warn` shim. Threading a pino logger from `resolver.ts` and `queue.ts` is a mechanical follow-up that doesn't affect FR-005 semantics.

## Complexity Tracking

*Constitution Check passed; no violations.*

Two mildly non-trivial choices, both cleared by the clarifications:

1. **Drift suite lives in `packages/cockpit/src/gh/__tests__/` (a new dir), not alongside `packages/cockpit/src/__tests__/`.** Clarifications Q3→A says "colocated with the wrapper it guards"; the existing tests dir is one level up. The new `__tests__/` under `gh/` is the closer neighbor and mirrors common package conventions. If vitest's config would miss it, a one-line glob update to `vitest.config.ts` suffices (verified: `packages/cockpit/vitest.config.ts` uses `**/*.test.ts` — matches automatically).
2. **`normalizeCheckState` gains one case (`'CANCEL'`)** because gh's `bucket` uses `cancel` where the current switch handled only `CANCELLED`/`CANCELED`. Trivial one-liner; verified against gh 2.96.0's bucket vocabulary (`pass`/`fail`/`pending`/`skipping`/`cancel`).

## Risk / Rollback

- **Risk**: a `--json` field list in a wrapper method other than `getPullRequestCheckRuns` also has a name gh rejects, and the drift suite fires red on the FIRST CI run of this PR. Mitigation: FR-008 mandates fixing every such site in the same pass; the suite output names the offending field and line. This is the intended forward-compat mechanism, not a failure mode.
- **Risk**: the pinned `gh` version in a specific CI job predates one of the fields (`bucket` since gh v2.14, Nov 2022; `link` since v2.10, Sep 2022 — both well below the 2.40 cluster-base pin). Mitigation: verified against cluster-base's pin. If a stale local dev env fails, `gh --version` diagnosis + upgrade guidance in `quickstart.md`.
- **Risk**: a downstream consumer of `CheckRunSummary` reads `.conclusion` (a field that has never carried data). Mitigation: grep confirms no read sites exist (`.conclusion` appears only in `review-context-json.ts`'s emission, which this PR also cleans up). If a follow-up in another repo emerges, it's a one-line fix in that repo (remove the read).
- **Risk**: `describe.runIf` is not supported by the vitest version pinned in `packages/cockpit`. Mitigation: verified pinned version is ≥1.6 (supports `.runIf`). If not, fall back to `describe.skipIf(!hasGhBinary)` — semantically identical.
- **Risk**: `console.warn` from the default logger shim adds noise to a caller that hasn't threaded a real logger yet. Mitigation: this is the intended failure-visibility surface (the whole point of Q2→A). Callers who want silence must inject a `{ warn: () => {} }` no-op logger — explicit, discoverable, greppable.
- **Rollback**: revert `wrapper.ts` (5 hunks), `review-context-json.ts` (1 hunk), `gh-wrapper.test.ts` (2 hunks), and delete `json-field-drift.test.ts`. The fixture cleanup in `packages/generacy/.../__tests__/` is source-compatible either way (`conclusion` is optional in both directions). No data migration, no relay-payload change, no coordinated cross-repo work.
