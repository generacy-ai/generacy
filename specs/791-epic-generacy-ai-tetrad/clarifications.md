# Clarifications: G3.2 — `cockpit queue <phase>`

**Issue**: generacy-ai/generacy#791
**Branch**: `791-epic-generacy-ai-tetrad`

---

## Batch 1 — 2026-06-26

### Q1: Phase issue enumeration source
**Context**: FR-001 says the command resolves `<phase>` to "the set of open epic issues belonging to that phase" and notes the phase logic is "from G1.2 (#788)". But G1.2 classifies a single issue's *workflow* state (e.g., `phase:plan`, `waiting-for:*`); it does not group epic children by epic-phase (e.g., `P3`). The grouping signal is owned by the epic manifest (G3.1 / #790), which writes `.generacy/epics/<slug>.yaml` with `phases[].issues: [owner/repo#N, ...]`. G3.1 has not landed yet. The choice determines whether this command can stand alone or hard-depends on a manifest.
**Question**: How should `cockpit queue <phase>` enumerate the issues belonging to a phase?
**Options**:
- A: Read `.generacy/epics/*.yaml` via `@generacy-ai/cockpit`'s existing `readManifest` / `resolveEpicIssues`, find the manifest whose `phases[].name` matches `<phase>`, and use that phase's `issues` list. Hard error with a "run `cockpit manifest init` first" hint if no manifest is found. (Treats G3.1 as a strict runtime prereq.)
- B: Same as A, plus a fallback: if no manifest exists, look up issues in the epic via the existing `epic-child` label / `epic-parent` body-ref search and require an additional `phase:<name>` label per issue. (Manifest preferred, label-only fallback usable.)
- C: Skip the manifest entirely in v1; require each in-scope issue to carry a `phase:<name>` label and resolve by GitHub search (`repo:… is:issue is:open label:phase:<name> label:epic-child`). (Standalone; no G3.1 dependency.)
- D: Other (please specify).

**Answer**: *Pending*

---

### Q2: Cluster account login source
**Context**: FR-004 says "assign each in-scope issue to the cluster account" and notes "Cluster account identity reused from existing cockpit cluster-account resolution." But `CockpitConfigSchema` in `packages/cockpit/src/config/schema.ts` currently has no `clusterAccount` (or equivalent) field, and no resolver exists. Some prior cockpit verbs use `gh auth status` for the current user, but the *cluster* account may differ from the developer running the CLI (the cluster runs as e.g. `christrudelpw` per the in-container `GH_TOKEN`). This question pins the source so the implementer doesn't either invent a config field unilaterally or silently assign issues to the wrong identity.
**Question**: Where does `cockpit queue` read the cluster account login from?
**Options**:
- A: Add a new `clusterAccount: string` field to the `cockpit:` block in `.generacy/config.yaml` (extending `CockpitConfigSchema`); error at startup if it is unset. (Explicit, requires schema change in this issue.)
- B: Read it from the `CLUSTER_ACCOUNT` (or similar) environment variable injected in-container, falling back to `gh api user --jq .login` (the gh-authenticated identity) when unset. (No config schema change; assumes the dev's `gh` identity == cluster identity, which is true in the orchestrator container.)
- C: Add a `--assignee <login>` CLI flag (required when the config field is unset); look up config first, then CLI flag, then error. (Per-invocation override with a config home for later.)
- D: Other (please specify).

**Answer**: *Pending*

---

### Q3: Cross-repo issues within a phase
**Context**: The `PhaseEntrySchema` in `@generacy-ai/cockpit` allows `phases[].issues` to be a list of `owner/repo#N` refs — i.e., a phase can legitimately span multiple repos (the epic plan in tetrad-development calls this out: `[generacy#690, generacy#691, agency#212]`). But this spec's Out of Scope says "Cross-repo phase queuing — single repo per invocation." The implementer needs a deterministic rule for which repo "this invocation" targets and what to do with phase entries pointing at other repos.
**Question**: When the manifest's phase contains issues from multiple repos, what should `cockpit queue <phase>` do?
**Options**:
- A: Require a `--repo <owner>/<repo>` flag (or fall back to a single value in `cockpit.repos` config when there is exactly one); filter the phase's `issues` to that repo only, and print the skipped cross-repo refs in the preview so they are visible-but-untouched.
- B: Error out if the phase spans multiple repos and no `--repo` filter is given; with `--repo` set, behave as A. (Strict — no silent filtering.)
- C: Use the epic-primary repo recorded in the manifest's `epic.repo` field as the single in-scope repo; phase entries from other repos are shown in the preview as skipped. (Zero-config; couples to manifest's epic.repo.)
- D: Other (please specify).

**Answer**: *Pending*

---

### Q4: Partial-failure semantics
**Context**: FR-006 says "Exit non-zero with a structured error if any individual assign/label call fails; report which issues succeeded and which failed." This pins the *output* but not the *control flow*: on the first failure, does the command stop processing the remaining issues (fail-fast: leaves remaining issues untouched in their previous state), or does it continue through every issue and report all results at the end (best-effort: maximizes progress but may leave the phase partially-queued)? SC-003 (idempotency) means a follow-up retry is safe either way, but the operator UX differs.
**Question**: When an assign/label call fails mid-queue, should the command keep going or stop?
**Options**:
- A: Best-effort: continue through every issue regardless of failures, then exit non-zero with a structured summary listing every issue's success/failure outcome. (Maximizes per-invocation progress; rerun is trivial because of idempotency.)
- B: Fail-fast: on the first failure, halt; do not touch remaining issues; exit non-zero reporting which issues were already mutated, the one that failed, and which were skipped. (Stops on first sign of trouble — e.g., auth expiry — to avoid amplifying the problem.)
- C: Best-effort within a single issue boundary (i.e., if assign succeeds but label fails on the *same* issue, still mark that issue as partial-failure, but move on to the next issue). Continue-on-failure across issues.

**Answer**: *Pending*

---

### Q5: Ineligible-issue handling in the resolved set
**Context**: Out of Scope excludes "closed issues, draft issues, or issues without a resolvable phase classification." But when the source-of-truth (manifest or label-search) returns the candidate set, some entries may be ineligible — the issue was closed since the manifest was written, or it lacks the expected `phase:*` classification. The spec is silent on whether ineligible entries appear in the preview, are filtered silently before the operator sees the list, or cause the whole command to fail. This affects the preview UX and the matching FR-002 contract.
**Question**: How should ineligible issues (closed / missing phase classification) be handled?
**Options**:
- A: Silently filter them before the preview; the operator only sees the eligible set. (Cleanest UX; ineligible issues are invisible.)
- B: Include them in the preview output marked as `[SKIP: closed]` / `[SKIP: no phase]`, but only mutate the eligible subset on confirm. (Visible but non-blocking.)
- C: Treat any ineligible entry as a hard error: refuse to proceed until the manifest/labels are reconciled (the operator must run `cockpit manifest sync` from G3.1 or fix the labels first). (Strict; forces the manifest to be authoritative.)
- D: Other (please specify).

**Answer**: *Pending*

---

_Posted by `/clarify` for issue #791._
