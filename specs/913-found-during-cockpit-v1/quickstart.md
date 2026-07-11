# Quickstart: cockpit merge tier-1 hardening + `--pr` escape hatch (#913)

## Prerequisites

- `pnpm install` (repo root) — no new npm deps.
- `gh` CLI on `PATH`. Fix targets gh 2.96.0 shape drift; passes on gh 2.95.x and 2.96.0+.
- Repo access via `gh auth status`.

## Local dev loop

### 1. Watch the two packages

```bash
pnpm --filter @generacy-ai/cockpit dev
pnpm --filter @generacy-ai/generacy dev
```

### 2. Run the targeted test suites

```bash
# Tier-1 hardening + FR-009/FR-013 version-skew diagnostics
pnpm --filter @generacy-ai/cockpit test wrapper.tier1-shape-drift.test.ts

# --pr escape hatch (FR-012, FR-012a, FR-012b)
pnpm --filter @generacy-ai/generacy test merge.pr-flag.test.ts

# --pr PR-detail graphql surface
pnpm --filter @generacy-ai/cockpit test wrapper.pr-graphql-detail.test.ts
```

### 3. Type-check + full test suite

```bash
pnpm typecheck
pnpm test
```

## Manual verification

### Sanctioned path against gh 2.96.0 (FR-011, SC-001)

```bash
# From inside a repo checkout with a completed:validate issue + open PR:
generacy cockpit merge 913
```

Expected: successful merge (or refusal at a real gate — `missing-label`, `checks-failing` — depending on issue state). MUST NOT fail with `gh resolveIssueToPRRef tier1 JSON shape mismatch: expected string, received undefined`.

### `--pr` escape hatch — happy path (FR-005, FR-007, SC-003)

```bash
generacy cockpit merge 913 --pr 921
```

Expected: same successful-merge behavior as the resolver-driven path when linkage + `completed:validate` + green checks all hold on PR 921 declaring `913` as a closing issue.

### `--pr` refusal — mismatch (FR-006a, SC-007)

```bash
# Operator typo — PR 100 does not close issue 913
generacy cockpit merge 913 --pr 100
```

Expected: exit 3. Refusal message names linkage. STDOUT JSON envelope's `reason` is `pr-flag-linkage-refused`, `kind` is `mismatch` (or `empty-refs` if PR 100 declares no closing refs at all).

### `--pr` refusal — CLOSED-unmerged (FR-006b, SC-008)

```bash
# PR 500 is closed without merge but does declare 913 as closing
generacy cockpit merge 913 --pr 500
```

Expected: exit 3. Refusal message: `PR #500 is closed without merge`.

### `--pr` idempotent no-op — MERGED (FR-006b, SC-008)

```bash
# PR 456 was already merged and declares 913 as closing
generacy cockpit merge 913 --pr 456
```

Expected: exit **0**. STDOUT: `PR #456 already merged, no-op`. Rationale: convergent verb, safe against `cockpit auto`'s retry-after-transient behavior.

### `--pr` argument-parse (SC via argument-parse tests)

```bash
generacy cockpit merge 913 --pr abc
generacy cockpit merge 913 --pr 0
generacy cockpit merge 913 --pr -5
```

Expected: exit 2 with `merge: --pr must be a positive integer, got: "abc"` (or the exact input echoed).

### Simulating the FR-002a graphql failure

There's no clean way to induce this from the shell without altering `gh`'s network. The test suite covers it via a mocked `CommandRunner`. To confirm behavior against a real network partition, temporarily set:

```bash
GH_HOST=nonexistent.invalid generacy cockpit merge 913
```

Expected: exit 1 after ~1s retry delay. Refusal message names the graphql follow-up failure. **Zero calls to `gh pr list --search`** (verify with `strace` / `dtrace` if you're being paranoid).

## Troubleshooting

### `Error: gh resolveIssueToPRRef tier1 initial shape JSON shape mismatch: … (gh version: gh version 2.96.0 …; payload excerpt: …)`

The FR-009 diagnostic. The `gh version:` substring tells you the CLI version at parse time; the `payload excerpt` shows the offending body. If you see this after the fix ships, the gh serializer has drifted **again** on the initial `closedByPullRequestsReferences` call — file a follow-up (do not silently expand the schema).

### `Error: gh resolveIssueToPRRef tier1 follow-up graphql failed after 1 retry: …`

Two possibilities:
1. GitHub graphql is degraded / partially down. Retry after ~1 minute; use `--pr <n>` if you know the target.
2. The graphql schema has changed — one of the four fields (`state`, `headRefName`, `isDraft`, `url`) was renamed or removed. Same follow-up-file-a-bug path.

### `--pr` refused with `PR #N declares no closing issues`

The PR you named doesn't declare `<ref>` as a closing issue. Open the PR in GitHub, click "Development" in the right sidebar, add `<ref>` to the linked issues, then re-run.

### `--pr` succeeded on MERGED but I meant a different PR

The linkage guard (FR-006a) protects against this — if the operator typo'd `--pr` at a random merged PR that happened to declare `<ref>` as closing, then the typo picked a genuinely-related PR. Verify by grepping the merged commit for the branch name; if it's the wrong PR, the linkage graph is wrong upstream (someone linked two PRs to the same issue).

## Reference

- Spec: `specs/913-found-during-cockpit-v1/spec.md`
- Clarifications: `specs/913-found-during-cockpit-v1/clarifications.md`
- Plan: `specs/913-found-during-cockpit-v1/plan.md`
- Contracts: `specs/913-found-during-cockpit-v1/contracts/`
- Related: #904 (introduced the tier-1 resolver), tetrad-development#92 (the incident that surfaced this).
