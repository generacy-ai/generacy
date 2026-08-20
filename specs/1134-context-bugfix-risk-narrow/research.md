# Research: #1134 Bugfix profiles

## Decision 1 — Diff-classification categories and guard precedence

**Decision**: A single pure function returns one of five classifications, evaluated
in a fixed precedence order so exactly one branch wins:

1. `full-fallback` — any changed file matches a root-config glob.
2. `single-package-plain` — repo is not a pnpm workspace.
3. `docs-only-skip-tests` — every changed file matches a docs glob.
4. `test-only` — every changed file matches a test glob.
5. `targeted` — otherwise (changed package source present).

**Rationale**: Guards are safety-first — root-config touches invalidate any
narrowing (a lockfile or root tsconfig change can affect every package), so it is
checked first. Single-package is checked next because the pnpm filter form is
meaningless there. Docs-only and test-only are "narrower than targeted" refinements.
The default is `targeted` — the whole point of the feature.

**Alternatives considered**: Evaluating guards as independent booleans and combining
— rejected because overlaps (e.g. a diff that is all docs AND touches a root
tsconfig) need a deterministic winner; ordered precedence gives that for free.

## Decision 2 — Built-in-default detection (Q1=B)

**Decision**: Export `DEFAULT_VALIDATE_COMMAND = 'pnpm test && pnpm build'` from
`config.ts`, wire the schema default to it, and rewrite only when
`config.validateCommand === DEFAULT_VALIDATE_COMMAND`.

**Rationale**: The clarification is explicit — an operator who set a custom
`validateCommand` gets it run verbatim; the engine only transforms the string it
authored. Comparing against a single exported constant is the least-magic detector
and keeps the schema default and the detector in sync by construction.

**Alternatives considered**: A sentinel/opt-in flag (Q1=C) — rejected by
clarification. Rewriting any resolved command (Q1=A) — rejected by clarification
(would surprise operators who set a bespoke command).

## Decision 3 — Changed-file set source

**Decision**: Reuse `github.getFilesChangedBetween(baseRef, 'HEAD')` with `baseRef`
from `resolveBaseRef` / `resolveBaseBranch` (`origin/<name>`), the same base the
pre-validate base-merge and the `...[origin/<base>]` filter use.

**Rationale**: The engine already computes this exact set for `computeProductDiff`
(`product-diff.ts:85`). One source of truth for "what changed" keeps the classifier,
the filter form, and the `failThenPass` worktree consistent (spec Assumptions).

## Decision 4 — Workspace detection

**Decision**: Presence of `pnpm-workspace.yaml` at the checkout root determines
`isWorkspace`. Single `fs.stat`; absent or unreadable → `false`.

**Rationale**: Cheap, deterministic, matches the FR-005 guard semantics ("not a
multi-package workspace → plain command"). No dependency graph parse is needed — the
pnpm `...[origin/<base>]` filter computes changed-packages-and-dependents itself at
runtime.

## Decision 5 — `failThenPass` execution model (Q3=A)

**Decision**: Detached git worktree at the base ref. Filter the changed-file set to
test globs; empty → non-blocking no-op. Run those test files in the worktree (expect
failure) and on the branch checkout (expect pass). Fail validate if base passes (no
regression proven) or branch fails.

**Rationale**: A worktree leaves the branch checkout and its node_modules untouched
and avoids the stash/restore hazards of same-tree checkout. Mirrors the existing
`base-merge.ts` git orchestration patterns already trusted in this codebase.

**Alternatives considered**: Same-tree stash (Q3=B) — rejected by clarification.
Empty-set fails/warns (Q3=C/D) — rejected by clarification (non-blocking no-op).

## Decision 6 — Scope to speckit-bugfix (Q4=B)

**Decision**: Gate the classify-rewrite-and-failThenPass block on
`context.item.workflowName === 'speckit-bugfix'`.

**Rationale**: Clarified blast radius. Feature and epic runs keep the plain resolved
command, preserving SC-005 byte-identity for the common path.

## Decision 7 — Verification charter wording (FR-001)

**Decision**: Replace the generic "needs verification" paragraph in the
`verification` branch with four explicitly numbered/headed questions. The `standard`
branch, the "do NOT run tests/builds" section, the empty-diff finding, and the
sidecar write instructions are untouched.

**Rationale**: FR-002 requires standard byte-identity; the change must be isolated to
the `if (profile === 'verification')` block. The four questions come verbatim from
the epic design (`docs/engine-review-remediate-plan.md`, "Bugfix profiles").

## Decision 8 — Per-workflow agents keying (Q5=A)

**Decision**: No code. `resolveAgentForPhase` already resolves review/remediate
agents through the five-tier precedence. Add a harness assertion only (SC-003/US4).

**Rationale**: FR-012 mandates no new resolution path; the capability shipped in
#1095/#1122.
