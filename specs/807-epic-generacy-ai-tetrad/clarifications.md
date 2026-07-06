# Clarifications

## Batch 1 — 2026-07-06

### Q1: Artifact-paths bundle shape
**Context**: FR-002(c) introduces a new bundle for `waiting-for:spec-review` / `waiting-for:plan-review` / `waiting-for:tasks-review` — "artifact-paths bundle listing the relevant paths under `specs/<dir>/`". Unlike the clarification bundle (`{spec, plan, codeReferences}` with `{path, body}` objects) and the PR bundle (metadata + diff + checks), this shape has no precedent. Assumptions §5 admits it's "a small, new shape defined in this spec (previously implicit in the CLI's file-scanning code in `clarify-context.ts`)" — but the shape is not actually defined anywhere in the spec.
**Question**: What fields does the artifact-paths bundle emit, and how does it handle missing files?
**Options**:
- A: Paths only, keyed by artifact name (`{issue, gate, artifacts: {spec: "specs/807-…/spec.md", plan: null, tasks: null}}`) — `null` when the file does not exist. Downstream consumers read the file themselves.
- B: Same as A, but include file body when the file exists (`{spec: {path, body}, plan: null, tasks: null}`) — parallels the clarification bundle's shape.
- C: Only the artifact relevant to the current gate (spec-review → just `spec`; plan-review → just `plan`; tasks-review → just `tasks`), full-body per B.
- D: All three artifacts (spec/plan/tasks) always emitted, per B — regardless of which review gate is active.

**Answer**: *Pending*

### Q2: Gate classification — issue labels vs. PR labels
**Context**: Today's split verbs handle gate discovery inconsistently. `clarify-context` reads only the issue's labels (`gh.fetchIssueLabels`) and refuses if `waiting-for:clarification` is not on the issue. `review-context` skips issue labels entirely and calls `gh.resolveIssueToPRRef` → operates on the linked PR. When `context` is unified around "the issue's current gate," the classifier has to decide whether to consult PR labels too.
**Question**: For the unified `context <issue>`, does the gate classification look only at the issue's labels, or does it also fetch and merge the linked PR's labels (e.g. for `waiting-for:implementation-review`, which today lives on the PR)?
**Options**:
- A: Issue labels only. If `waiting-for:implementation-review` is not on the issue itself, exit 3 (gate refusal). Callers who want PR-side bundling must ensure the label is mirrored to the issue.
- B: Issue labels first; if no `waiting-for:*` found there, fall back to fetching the linked PR's labels. First match (in the precedence order defined by `WAITING_PIPELINE_ORDER`) wins.
- C: Merge issue + linked-PR labels into one set and classify against the union, using existing `classify()` precedence to pick the source label. PR label wins ties.

**Answer**: *Pending*

### Q3: "Merge-preflight equivalent" — concrete label name
**Context**: FR-002(b) bundles PR metadata for `waiting-for:implementation-review` and the "merge-preflight equivalent" but never names the second label. `WAITING_PIPELINE_ORDER` (`packages/cockpit/src/state/precedence.ts:25-32`) lists `waiting-for:manual-validation` immediately after `waiting-for:implementation-review`, and `merge.ts` is the natural home for this gate. Implementers need the exact label(s) that trigger the PR bundle branch.
**Question**: Which concrete gate label(s) map to the PR bundle in FR-002(b) alongside `waiting-for:implementation-review`?
**Options**:
- A: Exactly `waiting-for:manual-validation` (the label the `merge` command reads today) — one additional label.
- B: `waiting-for:manual-validation` plus any other pre-merge gate (`waiting-for:sibling-review`, `waiting-for:pr-feedback`, `waiting-for:address-pr-feedback`) — every PR-scoped waiting gate emits the PR bundle.
- C: `waiting-for:implementation-review` only; there is no separate "merge-preflight equivalent" and the spec's phrasing was aspirational — treat merge-preflight as out of scope for `context`.

**Answer**: *Pending*

### Q4: Exit code when linked PR is missing for a PR-scoped gate
**Context**: Today's `review-context` returns exit code 1 when `gh.resolveIssueToPRRef` returns null ("No PR resolved for issue"). Under the unified verb, exit codes are canonicalized as `0 success / 1 gh-IO / 2 usage / 3 gate refusal` (FR-004). A missing PR is not a gh-IO failure (gh responded successfully; the linkage just isn't there) nor a usage error nor precisely a gate refusal (the issue is legitimately at a PR-scoped gate — the PR just can't be found).
**Question**: When `context <issue>` classifies the gate as PR-scoped (implementation-review / merge-preflight) but no linked PR can be resolved, which exit code applies and where does the diagnostic go?
**Options**:
- A: Exit 3 (gate refusal) — treat a PR-scoped gate with no resolvable PR as an unhandled gate; message names the label and the missing-PR condition.
- B: Exit 1 (gh-IO failure) — preserves today's `review-context` behavior even though gh itself did not fail.
- C: Introduce a fifth exit code (e.g. 4) for "gate consistent but referent missing" — explicit signal for scripts/skills.

**Answer**: *Pending*

### Q5: `--repo` flag on `context`
**Context**: The two verbs `context` replaces disagree on flag surface: `clarify-context` takes only `<issue>` and infers everything from the ref shape and cwd; `review-context` takes `<issue>` plus `--repo <repo>` and uses `resolveContext` (which is one of the modules being collapsed in FR-008). The collapsed resolver has to decide which surface `context` exposes.
**Question**: Does `generacy cockpit context <issue>` accept a `--repo <owner/repo>` flag?
**Options**:
- A: No flag — the resolver infers the repo strictly from the `<issue>` argument (accepts `owner/repo#N` or full URL); cwd is used only when the ref is a bare number. Matches `clarify-context`; drops the `--repo` surface `review-context` had.
- B: Yes — keep `--repo` as a way to override cwd inference when the ref is a bare number (`generacy cockpit context 807 --repo owner/repo`). Matches `review-context`; extends `clarify-context`'s surface.
- C: No flag on `context`, but the collapsed resolver still exposes an internal `repo` override for programmatic callers of `resolveContext` — CLI surface stays minimal while the shared module stays flexible.

**Answer**: *Pending*
