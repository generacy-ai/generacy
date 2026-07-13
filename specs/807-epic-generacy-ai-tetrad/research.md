# Research: Cockpit CLI Surface Collapse (#807)

## Decision 1 — Where the unified resolver lives

**Decision**: New file `packages/generacy/src/cli/commands/cockpit/resolver.ts`.

**Rationale**:
- Both current sources (`issue-ref.ts` and `shared/resolve-context.ts`) already live under `packages/generacy/src/cli/commands/cockpit/`. Keeping the collapsed module in the same directory minimizes import-path churn and matches the "Owns (isolation)" clause in the spec.
- `packages/cockpit/src/resolver/` exists but resolves **epic bodies** (a different concept using a name-clashing `IssueRef` type). Moving CLI-level ref parsing there would confuse readers about that package's purpose.
- Single file (not a subdirectory) keeps the module count = 1, which SC-003 measures directly.

**Alternatives considered**:
- **A**: `packages/cockpit/src/gh/ref.ts` — rejected: `packages/cockpit` is currently framework-neutral; introducing cwd/git-origin inference (which touches process cwd) would leak CLI concerns.
- **B**: Merge into existing `packages/cockpit/src/resolver/` — rejected: name clash on `IssueRef` and semantic mismatch (epic-body resolution vs. CLI ref parsing).

## Decision 2 — `CockpitGh` fold-in strategy

**Decision**: Extend the `GhWrapper` interface and `GhCliWrapper` class in `packages/cockpit/src/gh/wrapper.ts` with the eight distinct methods currently unique to `CockpitGh`, and expose single-label helpers (`addLabel`/`removeLabel`) as thin delegates over the existing plural methods.

**Rationale**:
- FR-007 says "folded in", not "redesigned" (also called out in Assumptions §5 of the spec). A redesign of the gh surface is explicitly out of scope.
- Reusing existing plural `addLabels`/`removeLabels` for single-label calls preserves atomicity (a single `gh issue edit` call passes multiple `--add-label` flags today) — single-label helpers just pass a 1-element array.
- The overlap matrix:

    | CockpitGh method | GhWrapper equivalent today | Action |
    |---|---|---|
    | `fetchIssueLabels(repo, n)` | none (`getIssue` returns full projection) | NEW method |
    | `fetchIssueState(repo, n)` | none | NEW method |
    | `postIssueComment(repo, n, body)` | none | NEW method |
    | `addLabel(repo, n, label)` | `addLabels(repo, n, labels[])` | delegate |
    | `removeLabel(repo, n, label)` | `removeLabels(repo, n, labels[])` | delegate |
    | `addAssignees(repo, n, logins[])` | none | NEW method |
    | `fetchIssueTimeline(repo, n)` | none | NEW method |
    | `fetchIssueComments(repo, n)` | none | NEW method |
    | `getCurrentUser()` | none | NEW method |
    | `findOpenPrForBranch(repo, branch)` | `resolveIssueToPRRef` (different shape) | NEW method |
    | `prDiffNames(repo, prNumber)` | none | NEW method |
    | `prDiffPatch(repo, prNumber)` | `getPullRequestDetail` returns capped diff | NEW method (uncapped, for code-references) |

**Alternatives considered**:
- **A**: Break `CockpitGh` into finer interfaces (`IssueOps`, `PrOps`, `UserOps`) — rejected: increases surface area, contrary to the FR-007 intent of "one home".
- **B**: Keep `CockpitGh` as a wrapper around `GhWrapper` (composition, not fold) — rejected: leaves the CLI-local extension in place; explicit non-goal (FR-007: "no CLI-side gh extension survives").

## Decision 3 — Bundle discriminator field

**Decision**: All three bundle shapes include `{issue, gate, …}` at the top level, where `gate` is the exact `waiting-for:*` label string that triggered the branch.

**Rationale**:
- Downstream skills can dispatch on a single field (`bundle.gate`) rather than shape-sniffing.
- Matches today's `clarify-context` output shape (already emits `issue: "owner/repo#n"`).
- The `gate` field on the implementation-review bundle is `"waiting-for:implementation-review"` verbatim — no aliasing.

**Alternatives considered**:
- **A**: Bundle-type discriminator (`type: 'clarification' | 'implementation-review' | 'artifact-paths'`) — rejected: introduces a second vocabulary that must stay in sync with the label vocabulary. Redundant.
- **B**: No discriminator — rejected: forces downstream shape-sniffing.

## Decision 4 — Handling `completed:validate` (Q3 answer detail)

**Decision**: When the issue's label set includes `completed:validate` and no other `waiting-for:*` label wins classification, `context` exits **3** with a stderr diagnostic pointing at `generacy cockpit merge`.

**Rationale**:
- Clarifications Q3 → C explicitly names this behavior.
- Aligns with FR-004's canonicalized exit-code table: `completed:validate` is a state-consistency refusal (label consistent but not context's job), not a usage or gh-IO failure.

## Decision 5 — Repo inference when the ref is a bare number

**Decision**: Fall back to `git remote get-url origin` inference **only** when the ref is a bare number. Owner/repo-qualified refs (`owner/repo#N`) and URL refs never inspect cwd.

**Rationale**:
- Preserves the current `parseIssueRef` behavior (which throws on bare numbers because "repos are not configured"). We keep the throw *unless* the resolver-wrapper can infer from git origin — which is the exact behavior `review-context` used via `resolveContext`.
- Matches Q5 clarification: "cwd is used only when the ref is a bare number".

**Implementation detail**: `parseIssueRef` (pure parser) still throws on bare numbers. `resolveIssueContext` catches that throw and, if the input was numeric-only, attempts cwd inference before re-throwing. This keeps the pure parser predictable and easily unit-testable.

## Decision 6 — Diff cap on implementation-review bundle

**Decision**: Reuse `getPullRequestDetail`'s existing 256 KiB diff cap (`DIFF_BYTE_CAP`). No new cap logic.

**Rationale**:
- Preserves parity with today's `review-context` (which uses `buildReviewContextPayload` fed by `getPullRequestDetail`).
- The bundle emits both `diff` and `diffTruncated: boolean` so downstream consumers can detect truncation.

## Implementation Patterns Followed

1. **Dependency-injected `CommandRunner`** — every gh call routes through `CommandRunner`; tests inject `vi.fn()` stubs (existing pattern in `state.test.ts`, `clarify-context.test.ts`, `review-context.test.ts`).
2. **`CockpitExit` exit-carrier** — Commander action wraps the run-function in `try/catch (isCockpitExit)` and translates to `process.exit(err.code)` after writing to stderr. Tests catch the thrown `CockpitExit` directly — no `process.exit`.
3. **Loud parse failures** — Zod schemas at gh-JSON boundaries; failures throw with the shape `gh <op> JSON shape mismatch: <reason>`.
4. **Read-only against GitHub** — `context` never writes labels/comments/assignees.

## Key Sources

- Spec: [spec.md](./spec.md)
- Clarifications: [clarifications.md](./clarifications.md)
- Current `CockpitGh`: `packages/generacy/src/cli/commands/cockpit/gh-ext.ts` (to be deleted)
- Current `GhWrapper`: `packages/cockpit/src/gh/wrapper.ts` (to be extended)
- Precedence order: `packages/cockpit/src/state/precedence.ts` (`WAITING_PIPELINE_ORDER`)
- Existing clarify bundle: `packages/generacy/src/cli/commands/cockpit/clarify-context.ts`
- Existing review bundle: `packages/generacy/src/cli/commands/cockpit/shared/review-context-json.ts`
