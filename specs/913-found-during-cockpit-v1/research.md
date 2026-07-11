# Research: cockpit merge tier-1 resolver hardening (#913)

## Decision 1 — FR-002 fetch strategy: `gh api graphql` vs. per-PR `gh pr view`

**Chosen**: `gh api graphql` with an explicit selection set (single call). Clarify Q5→B.

**Alternatives considered**:

- **Per-PR `gh pr view --json state,headRefName,isDraft`** — one call per resolved PR number.
  - **Pro**: reuses established `--json` idiom already in `wrapper.ts` (dozens of call sites); no new query surface to teach; state/headRefName/isDraft are first-class REST fields on `gh pr view`, less likely to drift than the union field that started this fire.
  - **Con** *(disqualifying)*: this is the same contract class that broke. Q5→B: "the whole moral of #913 is that gh's `--json` serializer shape is an implicit contract that drifts under us; re-anchoring the fix on the same contract class is a step backward." Even if these three specific fields feel stable today, the pattern normalizes drift as an in-flight risk on the merge path.
  - **Con**: N calls (partial-failure axis surfaces per Q4). A dropped call in a set of 4 forces a "hard-fail vs. filter to survivors" decision that has no good answer for a merge resolver (silent-wrong on the survivors path; degrade-to-tier-2 on the abort path — see Decision 3).

- **Belt-and-suspenders (graphql primary + `gh pr view` fallback on graphql failure)** — Q5 option D.
  - **Rejected**: maintains two drift surfaces (graphql schema + `--json` shape) to hedge one. Q4→D and Q5→B collapse to the observation that FR-002a's one-retry-then-`--pr` is the sanctioned resolver-down story — a code-path fallback is redundant, not defense-in-depth.

**Rationale**: GraphQL's schema is versioned and deprecation-cycled (see [GitHub GraphQL breaking-changes calendar](https://docs.github.com/en/graphql/overview/breaking-changes)); our field selection is an **explicit contract** rather than an implicit whatever-`--json`-emits. One call regardless of PR count also dissolves Q4's partial-failure axis (Decision 3). Cost: introduces the first `gh api graphql` invocation in `wrapper.ts` beyond the existing `gh api branches/…` REST endpoint at line 1011. Not a novel dependency (gh 2.0+ ships `gh api graphql` unconditionally), and the `getRequiredCheckNames` idiom for parsing the response is already well-worn.

**Selection-set form**: aliased per-PR (`pr0: pullRequest(number: N0) { … } pr1: pullRequest(number: N1) { … }`) instead of `pullRequests(first: 50) { nodes { … } }` + client-side filter. Detail in `contracts/graphql-selection-set.md`; the aliased form is deterministic per input, avoids pagination entirely, and produces a per-N miss signal (`null` node → PR deleted/hidden) the caller can act on without a separate query.

## Decision 2 — `--pr <number>` linkage source

**Chosen**: PR-side `closingIssuesReferences.nodes` fetched via the same explicit GraphQL selection (FR-006). Clarify Q1→B.

**Alternatives considered**:

- **Q1-A: trust the operator (no linkage check)** — permissive, simplest.
  - **Rejected**: merge is the one irreversible verb; a mistyped `--pr` silently merging the wrong PR while stamping an unrelated issue "validated" is exactly the coin-flip class #904 abolished. A safety-hatch that reintroduces the safety hole isn't a safety-hatch.

- **Q1-C: drop `<ref>` when `--pr` present, derive closing issue from PR** — inverts authorization.
  - **Rejected**: the operator names the issue whose gate state licenses the merge; deriving from the PR fails when the PR declares no closing issue (a real, non-error state — see the operator-typo class), and it lets a genuinely-linked PR merge under whatever gate state the derived issue happens to have, not the one the operator intended to authorize.

- **Q1-D: warn on mismatch, prompt to confirm** — hedged refusal.
  - **Rejected**: no interactive prompt composes with non-interactive `cockpit auto` transport. A warn+continue path silently degrades merge safety on the exact axis that already killed the sanctioned path.

**Rationale**: The linkage check runs **PR → issue** (`closingIssuesReferences` on the PR), not **issue → PR** (`closedByPullRequestsReferences` on the issue, which is the field #913 broke). It rides the same explicit GraphQL selection FR-002 is already hardening — one fixed path for the hatch and its guard. Empty-refs → still refuse, with guidance to add the Development sidebar link (cheap durable fix, keeps "merge never guesses" absolute).

**Reference selection-set choice**: `closingIssuesReferences(first: 20) { nodes { number, repository { nameWithOwner } } }` — 20 nodes because that's GitHub's realistic cap on the issue→PR linkage side and matches the tier-1 upper bound (issues rarely close more than a handful of PRs). Cross-repo linkage supported via `repository.nameWithOwner` — the operator can `--pr <n>` against a PR in the same repo (99% case) or a linked PR in a sibling repo (rare but valid multi-repo cockpit case, per the `WorkspaceConfig.repos` multi-repo work in Phases 1–3 above).

## Decision 3 — Tier-1 follow-up failure semantics

**Chosen**: retry once with 1s backoff, then hard-fail (never filter, never fall through to tier-2). Clarify Q4→D.

**Alternatives considered**:

- **Q4-A: hard-fail on any failure (no retry)** — simplest, safest against silent drops.
  - **Rejected as insufficient, not wrong**: without a retry, transient network flakes (routine against api.github.com) surface as hard failures. The correct fix is A + one retry, which is Q4-D verbatim.

- **Q4-B: fall through to tier-2 on total failure, hard-fail on partial** — tries to salvage.
  - **Rejected**: degrades a stronger signal to a weaker one on infrastructure failure. Tier-1 *knows* closing refs exist (the initial call succeeded) but couldn't read their state; letting branch-search pick instead risks selecting a different PR than the one closed by the issue. The architecture already has the right resolver-down story — that's what the `--pr` hatch is for.

- **Q4-C: fall through on total, filter on partial** — most resilient.
  - **Rejected — Q4-C admits silent-wrong in its own option text**. If the "successful subset" filters out the *actual* target PR, tier-1 returns a different PR and the merge caller merges the wrong one under a green cross-check. Disqualifying for a merge resolver.

**Rationale**: The one-retry absorbs routine flakes without semantic drift; the hard-fail terminates the resolver so the operator can escalate to `--pr <n>` with confidence that no silent-wrong outcome shipped. The single-call graphql selection dissolves the partial-failure axis Q4 originally posed — one call either succeeds or fails; there is no "3 of 5 PRs" state.

## Decision 4 — Payload excerpt cap

**Chosen**: 512 chars. Clarify Q2→B.

**Alternatives considered**:

- **Q2-A: 200 chars** — parity with sibling `.slice(0, 200)` sites in `wrapper.ts` (lines 507, 529, 768).
  - **Rejected**: `closedByPullRequestsReferences` refs are richer than the sibling shapes (each carries `id`+`repository`+`url`, ~120–180 chars each in minimal shape). 200 can truncate mid-element, leaving the "which key is missing?" diagnostic question open — exactly the shape drift 512 must reveal.

- **Q2-C: 1024** / **Q2-D: 2048** — near-full fidelity.
  - **Rejected**: optimize for many-PR fidelity nobody needs. The shape repeats per element; 2–3 complete elements is sufficient evidence. The extra bytes wrap on narrow terminals and add log-line noise.

**Rationale**: 512 comfortably shows 2–3 complete refs in the minimal shape, staying one-line-ish in modern terminals. The diagnostic's job is to reveal *which fields disappeared*, and that's visible within one complete ref.

## Decision 5 — `--pr` on already-MERGED PR

**Chosen**: idempotent no-op success (exit 0). Clarify Q3→B.

**Alternatives considered**:

- **Q3-A: refuse on MERGED (symmetric with CLOSED-unmerged)** — every merge is a distinct action.
  - **Rejected in the auto-mode retry context**: `cockpit auto` retries after transient failures (gh timing out *after* the merge landed is not hypothetical — see the observed cockpit v1 traffic). A hard refusal on MERGED spawns spurious escalations that mask the real cause (the transient) and force operator intervention on what is objectively the goal state.

- **Q3-C: opt-in idempotence via `--allow-already-merged`** — explicit.
  - **Rejected**: adds a flag the operator has to remember on every retry. The linkage guard in FR-006a already neutralizes Q3-A's "hides operator error" concern — a typo'd `--pr` at some random merged PR exits 3 on linkage mismatch, never exits 0 as a no-op.

- **Q3-D: both MERGED and CLOSED-unmerged succeed** — most permissive.
  - **Rejected**: CLOSED-unmerged is unambiguously operator error — the PR was closed without merging, and succeeding-with-nothing-done hides that.

**Rationale**: Convergent verbs (`terraform apply`, `kubectl apply`, `docker pull`) succeed when the goal state already holds. Merge is convergent under the retry model. The linkage guard makes the idempotent path safe against operator confusion — the only way exit 0 fires on MERGED is if the PR does declare `<ref>` as a closing issue, i.e., the operator got the linkage right.

## Decision 6 — New `getPullRequestGraphqlDetail` method vs. reuse `getPullRequestDetail`

**Chosen**: new method with a distinct selection set.

**Alternatives considered**:

- **Reuse `getPullRequestDetail` (existing at `wrapper.ts:729`ish)** — backed by `gh pr view --json …,body,diff`.
  - **Rejected on two grounds**: (a) it's `gh pr view --json`-backed, the exact contract class #913 is escaping. (b) It doesn't include `closingIssuesReferences` (nor could it be added — `--json closingIssuesReferences` was itself the field union that broke).

- **Extend `getPullRequestDetail` to include closing refs via a graphql sidecar** — hybrid.
  - **Rejected**: introduces a second gh call per `getPullRequestDetail` invocation across all callers (of which there are several — advance, watch, PR status paths in `packages/orchestrator`). The `--pr` path is the only caller that needs the linkage; keeping the surface narrow avoids a project-wide latency regression for one narrow use.

**Rationale**: `getPullRequestGraphqlDetail` is `--pr`-specific by intent. Its schema is small (5 top-level fields + linkage array), its parse boundary is a single zod schema, and its impl is under 40 LOC.

## Decision 7 — Where do the GraphQL query strings live?

**Chosen**: module-private constants in `wrapper.ts`, adjacent to the schemas that consume them.

**Alternatives considered**:

- **Extract to `packages/cockpit/src/gh/queries/` or a sibling `graphql-queries.ts`** — potential for reuse.
  - **Rejected**: no second caller. The overhead of a new module boundary (import path, re-export, doc surface) is not paid off by the one caller in `wrapper.ts`. Follow the codebase's existing pattern (`PullRequestRefRawSchema` and friends are all inline).

- **`.graphql` files loaded via ESM assertions** — matches some GitHub SDKs.
  - **Rejected**: introduces a build-time asset type not used elsewhere in the repo (all schema-adjacent code is TypeScript source). No editor/tooling ergonomic win for two short queries.

**Rationale**: inline template literals with `/* graphql */` prefix comments cost nothing, keep the schema and its query on-screen together, and match the codebase idiom.

## Decision 8 — Test-time fake `gh --version`

**Chosen**: mock the runner. No production-code branching for version capture.

**Alternatives considered**: injecting a `versionProvider` into `GhCliWrapper`'s constructor — considered and rejected as premature abstraction. `captureGhVersion` takes the runner as an argument; that's the DI seam tests use.

## Sources / references

- GitHub CLI 2.96.0 release notes — https://github.com/cli/cli/releases/tag/v2.96.0 (documents the `closedByPullRequestsReferences` shape narrowing that triggered this finding).
- GitHub GraphQL API — [PullRequest object](https://docs.github.com/en/graphql/reference/objects#pullrequest), [`closingIssuesReferences` on PullRequest](https://docs.github.com/en/graphql/reference/objects#pullrequest), [Issue's `closedByPullRequestsReferences`](https://docs.github.com/en/graphql/reference/objects#issue).
- `wrapper.ts:478–520` — `parseResolveIssueToPr` — the sibling tolerant-parser this fix's initial-shape schema mirrors.
- `wrapper.ts:748–803` — `queryTier1ClosingRefs` — the direct rewrite target.
- `merge.ts:100–296` — `runMerge` — the direct extension target for `--pr`.
- `packages/generacy/src/cli/commands/cockpit/exit.ts` — `CockpitExit` — the exit-code carrier both new branches use.
- Prior spec-level clarifications — `specs/913-found-during-cockpit-v1/clarifications.md` Batch 1 Q1–Q5.
- `tetrad-development#92` snappoll run — the incident that surfaced the outage. 11 manual `gh pr merge` invocations during the run; zero after the fix.
