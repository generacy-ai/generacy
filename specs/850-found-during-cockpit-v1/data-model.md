# Data Model: `cockpit advance` bare-number acceptance & error copy refresh

**Issue**: [generacy-ai/generacy#850](https://github.com/generacy-ai/generacy/issues/850)
**Branch**: `850-found-during-cockpit-v1`
**Date**: 2026-07-08
**Phase**: 1 — types, contracts, and validation rules

---

## Stable interfaces (unchanged)

### `IssueRef`

```ts
export interface IssueRef {
  /** GitHub owner login (e.g. "generacy-ai") */
  owner: string;
  /** GitHub repo name (e.g. "generacy") */
  repo: string;
  /** GitHub issue/PR number (positive integer) */
  number: number;
  /** "owner/repo" — convenience for gh CLI calls */
  nwo: string;
}
```

Consumers (unchanged):
- `advance.ts` reads `ref.nwo`, `ref.number` for `gh.fetchIssueLabels`, `gh.postIssueComment`, `gh.addLabel`.
- `context.ts` reads `ref.nwo`, `ref.number` for `gh.fetchIssueLabels`, `gh.resolveIssueToPRRef`, and downstream bundle assembly.
- `status.ts`, `watch.ts`, `queue.ts`, `merge.ts` — unchanged (already on `resolveIssueContext`).

Validation rules (in `makeRef`, unchanged):
- `owner` — non-empty, contains no `/` or whitespace.
- `repo` — non-empty, contains no `/` or whitespace.
- `number` — `Number.isInteger(n)` and `n > 0`. Zero and negative numbers are rejected loudly (`issue number must be a positive integer, got "<n>"`).

### `ResolveIssueContextInput`

```ts
export interface ResolveIssueContextInput {
  /** The `<issue>` argument as typed by the caller. */
  issue: string;
  /** Optional programmatic override — never exposed as a CLI flag on `advance` / `context`. */
  repo?: string;
  /** Working directory; defaults to `process.cwd()` for git-origin inference. */
  cwd?: string;
  /** Injected runner (tests only). */
  runner?: CommandRunner;
}
```

Unchanged shape and semantics. Note the `repo?: string` field: it is **only** consulted on the bare-number path — for qualified forms (owner/repo#N, URL) it is inert.

### `ResolvedIssueContext`

```ts
export interface ResolvedIssueContext {
  ref: IssueRef;
  /** Same as `ref.nwo` — retained for legacy call-site compatibility. */
  repo: string;
  gh: GhWrapper;
}
```

Unchanged.

---

## Changed function contracts

### `parseIssueRef(input: string): IssueRef`

**Change**: narrow to a strict qualified-forms-only parser. Bare numbers no longer have a special-cased throw; they fall into the generic `unrecognized issue ref` throw.

**Post-change accepted grammar**:
- `<owner>/<repo>#<n>` (matches `OWNER_REPO_HASH = /^([^/\s]+)\/([^/\s#]+)#(\d+)$/`).
- `https?://github.com/<owner>/<repo>/(issues|pull)/<n>` with optional trailing query string or fragment (matches `ISSUE_URL`).

**Post-change rejected inputs & their thrown messages** (`parse issue: ` prefix retained):
| Input                              | Message                                                                 |
|------------------------------------|--------------------------------------------------------------------------|
| `""` (empty or whitespace-only)    | `issue argument is required`                                             |
| `"123"` (bare number)              | `unrecognized issue ref "123". Use <n>, <owner>/<repo>#<n>, or https://github.com/<owner>/<repo>/issues/<n>.` |
| `"garbage"` / `"not-an-issue"`     | `unrecognized issue ref "…". Use <n>, <owner>/<repo>#<n>, or …`         |
| `"owner/repo#0"`                   | `issue number must be a positive integer, got "0"`                      |
| `"//repo#1"` / `"owner//#1"` etc.  | `invalid owner "…"` / `invalid repo "…"` (from `makeRef`)                |

**`@internal` annotation**: JSDoc-level only. TypeScript's `--stripInternal` is not part of the build, so runtime import is unchanged. The annotation is a signal to code readers and to any future tooling that respects `@internal`.

### `resolveIssueContext(input: ResolveIssueContextInput): Promise<ResolvedIssueContext>`

**Change**: gate bare numbers *first*, before delegating to `parseIssueRef`. Rewrap origin-inference failures with the FR-002 copy.

**New control flow**:

1. `trimmed = input.issue.trim()`.
2. If `/^\d+$/.test(trimmed)`:
   1. `number = Number.parseInt(trimmed, 10)` (guaranteed positive integer by the regex; `makeRef` re-asserts `> 0`).
   2. Resolve `repoNwo`:
      - If `input.repo` is set, use it directly.
      - Else `await inferRepoFromGitOrigin(runner, input.cwd)`.
      - On `inferRepoFromGitOrigin` throw: **rewrap** with the FR-002 message (see `contracts/resolve-issue-context.md` for the exact copy).
   3. Split `repoNwo` into `owner` / `repo`; if malformed, throw `inferred repo "…" is not in <owner>/<repo> form`.
   4. `ref = makeRef(owner, repo, number)`. Return `{ ref, repo: ref.nwo, gh: new GhCliWrapper(runner) }`.
3. Else (not a bare number): `ref = parseIssueRef(input.issue)`. Any throw here is fatal — no fall-through. Return `{ ref, repo: ref.nwo, gh: new GhCliWrapper(runner) }`.

**Removed control flow**:
- The `try { parseIssueRef(input.issue) } catch { if (!/bare issue number/.test((err as Error).message)) throw err }` sentinel at `resolver.ts:147-154`. **Deleted**.
- The redundant `Number.parseInt` + `Number.isInteger` re-check at `resolver.ts:157-160`. **Deleted** — the `/^\d+$/` gate + `makeRef`'s `> 0` assertion cover the same cases.

**Preserved control flow**:
- `inferRepoFromGitOrigin` itself (lines 112-129) — untouched.
- The `input.repo` override — bare-number-only, no CLI flag on `advance` / `context`.
- The `new GhCliWrapper(runner)` construction — unchanged.

---

## Message model (FR-002)

### Bare-number rejection copy

The **only** production message referencing "bare issue number" is now thrown from `resolveIssueContext`'s origin-inference failure branch. Template (single line, `parse issue: ` prefix preserved for caller-wrap consistency):

```
parse issue: bare issue number "N" is not accepted here. Accepted: <owner>/<repo>#N, a full issue URL, or a bare number inside a checkout with a resolvable GitHub origin. (cwd-origin inference failed: <inner-reason>)
```

Where:
- `N` is the actual number typed (e.g. `"2"`).
- `<owner>/<repo>#N` and `<owner>/<repo>` are **literal templates**, not substitutions (mirrors the existing `Use <n>, <owner>/<repo>#<n>, …` style at `resolver.ts:107-108`).
- `<inner-reason>` is the message from `inferRepoFromGitOrigin`'s throw, with its own `parse issue: ` prefix stripped so we don't double-prefix. Currently one of:
  - `could not infer owner/repo: 'git remote get-url origin' failed (exit N): <stderr>`.
  - `could not infer owner/repo from git origin URL: <url>`.

### Message shape validation

Two greppable invariants (verified by SC-002 and SC-003, and by the FR-007 test rewrite):

- The substring `repos are not configured` MUST NOT appear anywhere under `packages/generacy/src/`.
- The substring `cockpit.repos` MUST NOT appear anywhere under `packages/generacy/src/`.

Both are trivially satisfied post-change because the sole production hit (`resolver.ts:101`) and the sole test hit (`__tests__/resolver.test.ts:6`) are edited in this PR.

---

## ESLint rule model (FR-006)

Rule surface added to `.eslintrc.json` as a new `overrides` entry:

| Field            | Value                                                                                           |
|------------------|--------------------------------------------------------------------------------------------------|
| `files`          | `["packages/generacy/src/cli/commands/cockpit/**/*.ts"]`                                        |
| `excludedFiles`  | `["packages/generacy/src/cli/commands/cockpit/resolver.ts", "packages/generacy/src/cli/commands/cockpit/__tests__/**"]` |
| `rules.no-restricted-imports.paths[]` | Existing `child_process` / `node:child_process` entries carried forward + new `./resolver.js` entry restricting `parseIssueRef`. |

The `./resolver.js` entry:

| Sub-field       | Value                                                                                             |
|-----------------|----------------------------------------------------------------------------------------------------|
| `name`          | `"./resolver.js"` (the exact import specifier used inside the cockpit directory)                   |
| `importNames`   | `["parseIssueRef"]`                                                                                |
| `message`       | Names `resolveIssueContext` as the correct import; references #850.                                |

Rejection surface: any TypeScript file under `packages/generacy/src/cli/commands/cockpit/` (except `resolver.ts` and `__tests__/`) that imports `parseIssueRef` from `./resolver.js` triggers an ESLint `error`. `IssueRef`, `resolveIssueContext`, and other exports from `./resolver.js` are unaffected.

Fallback rule shape (documented in `contracts/eslint-rule.md`): `patterns[]` with `group: ["**/resolver.js"]` if `paths[].importNames` is unsupported by the resolved ESLint version.

---

## Test surface (FR-007)

### Deleted / rewritten

`__tests__/resolver.test.ts:6-10` — `refuses a bare number (repos are not configured)`. This assertion is **deleted**. `parseIssueRef('123')` now throws the generic `unrecognized issue ref` message (already covered by the existing `rejects garbage` case at lines 48-50).

`__tests__/resolver.test.ts:110-119` — `fails loudly when bare number is passed and git origin lookup fails`. Assertion **tightened** from `/could not infer owner\/repo/` to also match `/bare issue number "123" is not accepted here/`. The inner git-command reason is preserved inside the parenthesized clause of the FR-002 message.

### Added

`__tests__/resolver.test.ts` — new case: `bare number with unresolvable origin includes the accepted-forms enumeration and drops the removed-config reference`. Asserts the thrown message contains `bare issue number "N" is not accepted here`, lists all three accepted forms, and does NOT contain `repos are not configured` (regression guard for SC-002).

`__tests__/advance.test.ts` (create if absent, else extend) — three cases:
1. Bare-number happy path (runner stub returns `https://github.com/owner/repo.git`, assert `gh.fetchIssueLabels('owner/repo', 2)`).
2. Bare-number failure (runner stub exits 128, assert `CockpitExit(2, …)` with the FR-002 copy).
3. Regression: `owner/repo#2` still routes without a runner call.

`__tests__/context.test.ts` (create if absent, else extend) — identical three-case matrix scoped to `context`.

---

## Relationships & flow

```
                 CLI invocation
                       │
       ┌───────────────┼───────────────┬────────────────┬─────────────┐
       ▼               ▼               ▼                ▼             ▼
   advance         context           status           watch          queue
   (migrated)     (migrated)      (unchanged)      (unchanged)     (unchanged)
       │               │               │                │             │
       └───────────────┴───────┬───────┴────────────────┴─────────────┘
                               ▼
                     resolveIssueContext
                    ┌──────────────────────┐
                    │ if /^\d+$/ then      │
                    │   infer origin       │
                    │   makeRef directly   │
                    │ else                 │
                    │   parseIssueRef      │◄──── @internal (FR-006)
                    │                      │       Restricted import.
                    └──────────────────────┘
                               │
                               ▼
                          IssueRef
                     { owner, repo, number, nwo }
                               │
                               ▼
                        gh.<action>(ref.nwo, ref.number, …)
```

Merge (also on `resolveIssueContext` at `merge.ts:116`) is elided for compactness — its role is identical to `status`/`watch`/`queue`.
