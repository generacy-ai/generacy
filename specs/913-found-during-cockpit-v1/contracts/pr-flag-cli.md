# Contract: `cockpit merge <ref> --pr <number>` CLI surface

## §1 — Command shape

```
generacy cockpit merge <issue> [--repo <owner/name>] [--pr <number>]
```

- `<issue>`: the same issue-ref grammar the sanctioned path accepts (`123`, `owner/repo#123`, or the full URL — routed through `resolveIssueContext` per `resolver.ts`).
- `--repo`: unchanged from today; inferred from cwd if absent.
- `--pr <number>`: the new escape-hatch option. Positive integer. Required to be > 0.

**When `--pr` is present**: `runMergeWithExplicitPr` runs. The tier-1/2/3 resolution chain is skipped entirely.
**When `--pr` is absent**: today's `runMerge` runs unchanged (except for its internal use of the newly-hardened `queryTier1ClosingRefs`).

## §2 — Argument parsing (`parsePrFlag`)

```ts
export function parsePrFlag(input: string): number {
  const trimmed = input.trim();
  if (trimmed.length === 0) throwArgError(input);
  if (!/^\d+$/.test(trimmed)) throwArgError(input);
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(n) || n <= 0) throwArgError(input);
  return n;
}

function throwArgError(input: string): never {
  throw new CockpitExit(2, `merge: --pr must be a positive integer, got: "${input}"`);
}
```

- Exit code: **2** (argument-parse convention).
- Accepted: `"1"`, `"42"`, `"999999"`.
- Rejected: `""`, `" "`, `"0"`, `"-3"`, `"1.5"`, `"1e6"`, `"abc"`, `"42abc"`, values > MAX_SAFE_INTEGER.

## §3 — Gate ordering (FR-008)

**Every** gate refusal exits 3 and names the gate that tripped. The order is fixed and documented so operators reading the refusal message can predict which downstream fix is needed.

```
[ --pr <number> path enters here ]
             │
             ▼
   ┌──────────────────────────┐
   │ Fetch PR detail via      │  → transport failure → exit 1
   │ getPullRequestGraphqlDetail │
   └──────────────────────────┘
             │
             ▼
   ┌──────────────────────────┐
   │ GATE 1 — FR-006a linkage │
   │  (nodes include <ref>?)  │
   └──────────────────────────┘
       │           │
     PASS       FAIL → exit 3, reason: 'pr-flag-linkage-refused'
       │              kind: 'empty-refs' | 'mismatch'
       ▼              message includes "Add via Development sidebar"
   ┌──────────────────────────┐
   │ GATE 2 — FR-006b state   │
   └──────────────────────────┘
       │           │
   OPEN → continue │
   MERGED → exit 0, "PR already merged, no-op"
   CLOSED → exit 3, reason: 'pr-flag-closed-unmerged'
                    message: "PR is closed without merge"
       ▼
   ┌──────────────────────────┐
   │ GATE 3 — FR-007 label    │
   │  (completed:validate on  │
   │   <ref>, not the PR)     │
   └──────────────────────────┘
       │           │
     PASS       FAIL → exit 3, reason: 'missing-label',
       │              missingLabel: 'completed:validate'
       ▼
   ┌──────────────────────────┐
   │ GATE 4 — FR-007 checks   │
   │  (classifyChecks)        │
   └──────────────────────────┘
       │           │
     PASS       FAIL → exit 3, reason: 'checks-failing',
       │              failingChecks: [...]
       ▼
   ┌──────────────────────────┐
   │ MERGE + branch delete    │
   │  → exit 0                │
   └──────────────────────────┘
```

## §4 — Refusal message contract

Each gate's refusal STDOUT is a JSON envelope produced by `serializeFailingCheckJson(buildFailingCheckPayload({...}))`, which is already the shape for `runMerge`. The new `reason` values are:

- `pr-flag-linkage-refused` — carries `kind: 'empty-refs' | 'mismatch'` and remediation text.
- `pr-flag-closed-unmerged` — carries the PR number and closed-at timestamp (if graphql supplies).
- Existing `missing-label` / `checks-failing` reasons — reused verbatim from `runMerge`.

The FR-008 refusal-message wording MUST name the failing gate. Example strings (chosen for grep-ability):

- Linkage empty-refs:
  > `--pr 456 refused: PR #456 declares no closing issues. Add x/y#123 via the PR's Development sidebar link, then re-run.`
- Linkage mismatch:
  > `--pr 456 refused: PR #456 does not declare x/y#123 as a closing issue (has: x/y#789). Add x/y#123 via the PR's Development sidebar link, then re-run.`
- CLOSED-unmerged:
  > `--pr 456 refused: PR #456 is closed without merge.`
- Missing label (existing):
  > `--pr 456 refused: issue x/y#123 does not carry completed:validate; run cockpit advance to promote.`
- Checks failing (existing):
  > `--pr 456 refused: PR #456 has N failing/pending required checks.`

## §5 — Shared-tail `exitPolicy` parameter

`assertCompletedValidateAndMerge` (the shared tail between `runMerge` and `runMergeWithExplicitPr`) accepts an `exitPolicy` argument:

```ts
type ExitPolicy = 'resolver' | 'pr-flag';

interface AssertInput {
  gh: GhWrapper;
  issueRef: IssueRefWithState;
  prNumber: number;
  logger: Logger;
  exitPolicy: ExitPolicy;
  linkMethod?: LinkMethod;  // 'resolver' path passes this; 'pr-flag' path omits
}
```

- `exitPolicy: 'resolver'` — missing label / failing checks → exit **1** (parity with today's `runMerge`).
- `exitPolicy: 'pr-flag'` — missing label / failing checks → exit **3** (per FR-008).

This avoids a behavioral regression on the sanctioned path (which today returns exit 1 for these refusals). No other observable behavior differs between the two policies.

## §6 — Non-goals for the CLI surface

- **No `--force`** — the spec explicitly forbids a safety bypass. Neither the resolver-driven path nor `--pr` accepts an override.
- **No comment posted on refusal** — refusal writes to stderr / stdout (JSON envelope) and returns non-zero; no GitHub-side artifact.
- **No auto-injection of Development-link** — the "add via Development sidebar" remediation is documented text, not an API call. Operators fix the link themselves.
- **No `--pr` in `cockpit auto`** — auto-mode does not have an escape hatch by design. `--pr` is human-invoked-only. This is documented in the help text and out-of-scope for automation integration.

## §7 — Help text (canonical)

```
Usage: generacy cockpit merge <issue> [options]

  Squash-merge the PR for <issue> iff it carries completed:validate and every
  required check is green.

Arguments:
  <issue>         GitHub issue number (bare N, owner/repo#N, or full URL)

Options:
  --repo <repo>   Owner/name (inferred from cwd if absent)
  --pr <number>   Escape hatch — target this PR directly, skipping issue→PR
                  resolution. <issue> remains required as the authorization
                  source for completed:validate. Enforces linkage verification
                  and all safety preconditions; never bypasses safety.
```
