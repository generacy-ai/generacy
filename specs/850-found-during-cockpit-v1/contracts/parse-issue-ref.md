# Contract: `parseIssueRef` — strict qualified-forms parser

**File**: `packages/generacy/src/cli/commands/cockpit/resolver.ts`
**Visibility**: `@internal` (JSDoc). Callers MUST use `resolveIssueContext` instead — enforced by the ESLint rule in `contracts/eslint-rule.md`.
**Related**: [contracts/resolve-issue-context.md](./resolve-issue-context.md), [data-model.md](../data-model.md).

## Signature

```ts
export function parseIssueRef(input: string): IssueRef;
```

Synchronous. Throws `Error` on any invalid input.

## Accepted inputs

| Form                                             | Example                                                  | Result                                              |
|--------------------------------------------------|----------------------------------------------------------|-----------------------------------------------------|
| `<owner>/<repo>#<n>`                              | `owner/repo#7`                                           | `{ owner: "owner", repo: "repo", number: 7, nwo: "owner/repo" }` |
| `https://github.com/<owner>/<repo>/issues/<n>`   | `https://github.com/owner/repo/issues/99`                | `{ owner: "owner", repo: "repo", number: 99, nwo: "owner/repo" }` |
| `https://github.com/<owner>/<repo>/pull/<n>`     | `https://github.com/owner/repo/pull/788`                 | `{ owner: "owner", repo: "repo", number: 788, nwo: "owner/repo" }` |
| Either URL form with trailing `?…` or `#…`       | `https://github.com/o/r/issues/12?foo=1#bar`             | `number: 12` — query/fragment stripped               |
| `http://` prefix                                 | `http://github.com/owner/repo/issues/1`                  | Accepted (regex is `https?://`).                    |

Leading / trailing whitespace on the input is trimmed before matching.

## Rejected inputs & thrown messages

All throws prefix `parse issue: ` (loud-errors convention). Callers wrap with `Error: cockpit <verb>: ` on top.

| Input                              | Thrown message (after `parse issue: ` prefix)                                                              |
|------------------------------------|-------------------------------------------------------------------------------------------------------------|
| `""` or whitespace-only            | `issue argument is required`                                                                                |
| `"123"` — a **bare number**        | `unrecognized issue ref "123". Use <n>, <owner>/<repo>#<n>, or https://github.com/<owner>/<repo>/issues/<n>.` |
| `"garbage"` / `"not-an-issue"`     | `unrecognized issue ref "…". Use <n>, <owner>/<repo>#<n>, or https://github.com/<owner>/<repo>/issues/<n>.` |
| `"owner/repo#0"` or `"o/r#-1"`     | `issue number must be a positive integer, got "0"` (from `makeRef`)                                         |
| `"a b/repo#1"` (owner has space)   | `invalid owner "a b"` (from `makeRef`)                                                                       |
| `"owner/a b#1"` (repo has space)   | `invalid repo "a b"` (from `makeRef`)                                                                        |
| `"owner//#1"` / `"/repo#1"`        | `invalid owner "…"` or `invalid repo "…"` (from `makeRef`)                                                   |

### Delta from the pre-change parser

- **Pre-change**: bare number `"123"` threw `bare issue number "123" is not accepted — repos are not configured, so a bare number is ambiguous. Use <owner>/<repo>#123 or the full URL.`.
- **Post-change**: bare number `"123"` throws `unrecognized issue ref "123". Use <n>, <owner>/<repo>#<n>, or …` (the same throw as any other unrecognized form).

The bare-number *remedy* (cwd-origin inference) moves to `resolveIssueContext` — see the sibling contract.

## Return shape

```ts
interface IssueRef {
  owner: string;   // GitHub owner login, non-empty, no "/" or whitespace
  repo: string;    // GitHub repo name, non-empty, no "/" or whitespace
  number: number;  // Positive integer
  nwo: string;     // `${owner}/${repo}` — cached for gh CLI calls
}
```

Guarantees:
- On success, `number >= 1` and `Number.isInteger(number) === true` (enforced by `makeRef`).
- `nwo === `${owner}/${repo}``.

## Purity

- Pure function. No I/O, no side effects, no runner. Same input → same output/throw.
- `Number.parseInt(x, 10)` is used for numeric extraction; radix is always 10.

## Test surface

Located in `packages/generacy/src/cli/commands/cockpit/__tests__/resolver.test.ts`.

Existing tests that MUST continue to pass unchanged:
- `parses owner/repo#number form`
- `parses an issues URL`
- `parses a pull URL (PRs are issues on GitHub)`
- `accepts URLs with trailing query strings or fragments`
- `rejects empty input`
- `rejects garbage`
- `garbage error message enumerates <n>, <owner>/<repo>#<n>, and URL forms`
- `rejects issue number 0 in owner/repo#n form`

Existing test that MUST be **deleted** (per FR-007 and D1):
- `refuses a bare number (repos are not configured)` — the bare-number path no longer throws that message. Coverage of `parseIssueRef('123')` moves under the generic `rejects garbage` case (already asserted as `/^parse issue: unrecognized issue ref/`).
