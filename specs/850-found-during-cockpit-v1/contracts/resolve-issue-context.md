# Contract: `resolveIssueContext` — bare-number gate + FR-002 copy

**File**: `packages/generacy/src/cli/commands/cockpit/resolver.ts`
**Visibility**: public. This is the canonical entry point for all cockpit verbs that take an `<issue>` argument.
**Related**: [contracts/parse-issue-ref.md](./parse-issue-ref.md), [contracts/eslint-rule.md](./eslint-rule.md), [data-model.md](../data-model.md).

## Signature

```ts
export async function resolveIssueContext(
  input: ResolveIssueContextInput,
): Promise<ResolvedIssueContext>;

interface ResolveIssueContextInput {
  issue: string;              // <ref> as typed by the caller
  repo?: string;              // programmatic override (bare-number path only), no CLI flag on advance/context
  cwd?: string;               // defaults to process.cwd() for git-origin inference
  runner?: CommandRunner;     // injected in tests
}

interface ResolvedIssueContext {
  ref: IssueRef;
  repo: string;               // same as ref.nwo — legacy call-site convenience
  gh: GhWrapper;
}
```

Async. Rejects with `Error` on any invalid input or unresolvable cwd origin.

## Control flow

Post-change (Q2 → C):

1. `trimmed = input.issue.trim()`.
2. **Bare-number branch** — if `/^\d+$/.test(trimmed)`:
   - `number = Number.parseInt(trimmed, 10)`.
   - Resolve `repoNwo`:
     - `input.repo` if set.
     - Else `await inferRepoFromGitOrigin(runner, input.cwd)`. On its throw, rewrap into the FR-002 message (see below).
   - Split `repoNwo` into `owner` / `repo`; if malformed, throw `parse issue: inferred repo "…" is not in <owner>/<repo> form`.
   - Return `{ ref: makeRef(owner, repo, number), repo: `${owner}/${repo}`, gh: new GhCliWrapper(runner) }`.
3. **Qualified-form branch** — call `parseIssueRef(input.issue)`. Any throw is fatal (no fall-through). On success, return `{ ref, repo: ref.nwo, gh: new GhCliWrapper(runner) }`.

Removed (Q2 → C): the `try { parseIssueRef } catch { if (!/bare issue number/.test(message)) throw }` sentinel and the redundant `Number.parseInt` + `Number.isInteger` re-check.

## FR-002 error copy

Thrown from the bare-number branch when `inferRepoFromGitOrigin` fails (git remote missing, non-GitHub URL, or non-zero exit).

**Exact template**:

```
parse issue: bare issue number "N" is not accepted here. Accepted: <owner>/<repo>#N, a full issue URL, or a bare number inside a checkout with a resolvable GitHub origin. (cwd-origin inference failed: <inner reason>)
```

Where:
- `N` is the value of `trimmed` (e.g. `"2"`).
- `<owner>/<repo>#N` and `<owner>/<repo>` are literal templates, not substitutions.
- `<inner reason>` is `(err as Error).message`, with the leading `parse issue: ` prefix stripped so we don't double-prefix.

**Invariants**:
- The rendered string contains no `cockpit.repos`.
- The rendered string contains no `repos are not configured`.
- The rendered string is one line — no `\n` in the template (Q4 → A).
- The `parse issue: ` prefix is retained; verb callers (`advance`, `context`, etc.) wrap with `Error: cockpit <verb>: <message>` on top.

## Callers (post-migration)

All cockpit verbs that take an `<issue>` argument route through this function:

| Verb        | Call-site                                                                          |
|-------------|-------------------------------------------------------------------------------------|
| `advance`   | `advance.ts` (migrated in this PR from `parseIssueRef` at line 108)                |
| `context`   | `context.ts` (migrated in this PR from `parseIssueRef` at line 156)                |
| `status`    | `status.ts:54` (unchanged — already on this function since #822)                    |
| `watch`     | `watch.ts:99` (unchanged)                                                           |
| `queue`     | `queue.ts:233` (unchanged)                                                          |
| `merge`     | `merge.ts:116` (unchanged; passes `opts.repo` for the `--repo` CLI flag)             |

Cockpit verbs that do NOT take an `<issue>` argument (e.g. help commands, subcommand groups) are out of scope.

## Behavior parity across callers

For any accepted input `X`, the returned `IssueRef` MUST be identical across all callers. That is:

```
resolveIssueContext({ issue: "owner/repo#2" }).ref
=== resolveIssueContext({ issue: "https://github.com/owner/repo/issues/2" }).ref
=== resolveIssueContext({ issue: "2", cwd: "<checkout of owner/repo>" }).ref
```

(equality by structural shape: `{ owner: "owner", repo: "repo", number: 2, nwo: "owner/repo" }`).

This is the SC-004 invariant (no cockpit verb silently accepts a different grammar).

## Failure modes

| Cause                                                     | Message (after `parse issue: ` prefix)                                                                     |
|-----------------------------------------------------------|-------------------------------------------------------------------------------------------------------------|
| Bare number, git origin missing / non-zero                | `bare issue number "N" is not accepted here. Accepted: … (cwd-origin inference failed: could not infer owner/repo: 'git remote get-url origin' failed (exit N): <stderr>)` |
| Bare number, git origin URL isn't GitHub                  | `bare issue number "N" is not accepted here. Accepted: … (cwd-origin inference failed: could not infer owner/repo from git origin URL: <url>)` |
| Bare number, `input.repo` malformed (`"foo"`, `"a/b/c"`)  | `inferred repo "foo" is not in <owner>/<repo> form`                                                          |
| Bare number, `input.repo` yields an invalid owner or repo | `invalid owner "…"` / `invalid repo "…"` (from `makeRef`)                                                    |
| Qualified form, any grammar failure                       | Delegated to `parseIssueRef` — see its contract for the message table.                                       |

## I/O surface

- Spawns `git remote get-url origin` via `runner` **only** when `input.issue` is a bare number AND `input.repo` is unset. Zero I/O on the qualified-forms path (this is what the `resolver.test.ts:63-75` assertion locks: `expect(runner).not.toHaveBeenCalled()` for `owner/repo#42`).
- Constructs a new `GhCliWrapper(runner)` on every call. Callers with a pre-built `gh` typically prefer `deps.gh ?? resolvedCtx.gh` — see `status.ts:56`, `watch.ts:101`, and the migrated `advance.ts` / `context.ts`.

## Test surface

Located in `packages/generacy/src/cli/commands/cockpit/__tests__/resolver.test.ts`.

Existing `resolveIssueContext` tests that MUST continue to pass:
- `returns { ref, repo, gh } for owner/repo#n form (no runner call needed)`
- `infers repo from git origin URL when input is a bare number`
- `honors input.repo override for a bare number (no git-origin call)`
- `bare "1" with ssh origin URL expands to owner/repo#1 (T007 integration)`
- `propagates non-bare-number parse failures without falling through to git-origin`

Existing test tightened:
- `fails loudly when bare number is passed and git origin lookup fails` — assertion tightens from `/could not infer owner\/repo/` to `/bare issue number "123" is not accepted here.*Accepted:.*cwd-origin inference failed: could not infer owner\/repo/` (asserts the outer FR-002 wrapping AND the preserved inner reason).

New tests added:
- `bare-number failure copy does NOT contain "repos are not configured"` — explicit regression guard for SC-002.
- `bare-number failure copy does NOT contain "cockpit.repos"` — explicit regression guard for SC-003.

See also `contracts/parse-issue-ref.md` for the deleted `parseIssueRef` bare-number test.
