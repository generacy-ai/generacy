# Clarifications

## Batch 1 — 2026-07-09

### Q1: Epic issue-set enumeration
**Context**: FR-001 says "on epic base-branch advance, enumerate all epic issues currently at `failed:validate`". The code needs a concrete way to answer "which issues belong to this epic?" — but the spec never says how epic membership is expressed. In this repo today, epics are variably identified by a parent-issue link (sub-issue relation), a milestone, a `workflow:speckit-*` label, or an `epic:*` label. Picking the wrong source risks missing stranded siblings (under-scan → cascade fails to converge → SC-001 miss) or re-arming unrelated issues that happen to share a base branch (over-scan → wasted validate spend, possible SC-002 dedupe pressure). This also decides whether the base-advance listener needs to consult GitHub's parent/sub-issue API, the milestone API, or just labels.
**Question**: What identifies "the epic" that scopes the FR-001 enumeration when a sibling merges?
**Options**:
- A: GitHub parent/sub-issue relation — the merged PR's linked issue's parent issue defines the epic; enumerate that parent's open sub-issues currently at `failed:validate`.
- B: Milestone — enumerate open issues in the merged PR-linked issue's milestone with `failed:validate`.
- C: An `epic:<id>` (or similar) label shared by every issue in the epic — enumerate open issues carrying the same `epic:*` label.
- D: Base-branch match — enumerate every open speckit-workflow issue whose branch's PR targets the same base branch as the just-merged PR (no explicit epic construct; epic membership = shared base branch).

**Answer**: D, and reframe the spec's scoping concept — "epic membership" is the wrong key; **merge-preview staleness is per (repo, base branch)**. Any advance of the base stales *every* `failed:validate` red whose PR targets it, sibling or not — and re-validating a red whose preview didn't materially change is a cheap no-op that comes back red with the same evidence hash (Q3), feeding the existing bound. A/B/C all import a membership construct (sub-issues, milestones, labels) that the orchestrator doesn't currently maintain and that adds an under-scan failure mode; D has none.

### Q2: Base-advance trigger source and scope
**Context**: FR-001 says "triggered by merge event, not polling", but does not specify (i) the transport (GitHub webhook, GraphQL poll of the base branch's head SHA, existing `LabelMonitorService` extension), or (ii) whether the trigger considers *only* sibling PR merges within the epic, or *any* advance of the base branch — including a direct push to `develop` or a merge from an unrelated PR that also invalidates a stale integration red. Choice (ii) shapes SC-004 ("no phantom integration-red fixes"): if only sibling merges trigger re-arm, an external merge that unblocks the import will never be picked up and the fix-cycle in (b) will spuriously fire on what is actually still an integration red. Choice (i) affects deployability (webhooks require app-level infrastructure that may not exist in the target environment).
**Question**: What event source drives the base-advance re-arm, and what set of events counts as a "base advance"?
**Options**:
- A: Webhook on `pull_request.closed` (merged=true) where the merged PR's base equals the target base — sibling merges only; external commits to the base branch are ignored.
- B: Poll base-branch head SHA on a cadence (e.g., every N seconds via existing monitor loop) — any SHA change (sibling merge, direct push, external PR merge) counts as a base advance and triggers enumeration + re-validate.
- C: Hybrid — webhook fires the immediate re-arm on sibling merges, and a cheaper periodic poll catches non-sibling base advances (external merges, direct pushes) as a backstop.

**Answer**: B, correcting FR-001's "not polling" wording — local clusters have no webhook infrastructure by design; the orchestrator is poll-based everywhere else. One base-branch head-SHA compare per monitor cycle (~60s) is effectively free, and the SHA change *is* the event — it fires exactly once per advance (natural dedupe key: the new SHA, which is also the re-arm key) and uniformly catches sibling merges, external PR merges, and direct pushes — the case A silently misses and SC-004 worries about.

### Q3: Evidence-hash canonicalization
**Context**: FR-004/FR-009 use an "evidence hash" to bound fix attempts to exactly one per distinct red — same hash → no re-attempt without human release; different hash → fresh attempt allowed. The hash's canonicalization decides whether cosmetic re-runs (different timestamps, different tmp paths, node PIDs, ANSI colour codes, ordering of failure lines) look like the "same" red or a "new" red. Too loose (hash the entire raw stdout) → benign re-runs mint new hashes and the "one attempt per red" bound leaks. Too tight (hash only a single error line) → genuinely different failures collide and get incorrectly de-duped. This directly determines SC-003 (exactly 1 autonomous attempt per evidence hash) and whether FR-005's "stdout-inclusive" prompt is a superset of the hashed content or its own thing.
**Question**: What content and normalization define the evidence hash?
**Options**:
- A: SHA-256 of `next build`/test-runner stdout+stderr after stripping ANSI escapes, timestamps (`\d{4}-\d{2}-\d{2}T…`), absolute paths (canonicalize to repo-relative), and per-run identifiers (PIDs, tmp dirs, port numbers). Whole normalized transcript is hashed.
- B: SHA-256 of a structured extract: sorted list of `{failing_test_name | failing_module_path}` + first error line per failure, with the same normalizations as A applied. Prompt still gets full stdout (FR-005) but the hash is over the summary.
- C: SHA-256 of stdout+stderr raw (no normalization) — accept that cosmetic re-runs create new hashes; treat the resulting looseness as safe because #883 termination discipline (no-diff → stop) prevents an actual retry loop even if a fresh hash is minted.

**Answer**: B — hash a structured extract (sorted failing test/module identifiers + first error line each, ANSI/timestamp/path-normalized), not the whole transcript: durations, progress counters, and compile timings vary per run and survive A's normalizations, leaking the one-attempt bound. Collisions err in the safe direction — "same red" → no autonomous re-attempt → escalation gate. The FR-005 prompt still carries the full stdout-inclusive evidence; the hash is identity, not payload.

### Q4: Sibling-duplication guard mechanics and "same phase" scope
**Context**: FR-011 says the fix cycle "refuses to create a file that exists on any open sibling PR branch of the same phase". Two things are unresolved: (i) what defines "sibling of the same phase" — the speckit workflow phase (e.g., all issues currently in `implement`), the auto-mode wave/queue-batch, or the epic-level phase; and (ii) how the file-set manifest is computed — on-demand `gh pr diff` per open sibling PR (cheap to reason about, N network calls per fix-cycle spawn), or a queue-maintained manifest updated on each PR open/push (fewer calls at fix time, more state to keep coherent). SC-005 depends on this — a stale manifest lets the guard miss a sibling that opened a PR seconds ago; on-demand queries are always current but add latency.
**Question**: What set of PRs is scanned for the file-duplication guard, and how is the file-set derived?
**Options**:
- A: On-demand `gh pr diff --name-only` per every open PR in the same epic (Q1's definition of epic); "same phase" means "in the same epic and currently open" — do not narrow further by speckit workflow phase.
- B: On-demand `gh pr diff --name-only` per every open PR whose speckit workflow phase label matches the current issue's phase label (e.g., both at `phase:implement`); ignore siblings in different phases.
- C: Queue-side pre-computed manifest updated on each PR open/push event — fix cycle consults an in-memory or Redis map `phase → {branch → files[]}`; refresh on any staleness signal.

**Answer**: A, rescoped per Q1 — on-demand `gh pr diff --name-only` across every open PR targeting the same base branch. Fix-cycle spawns are rare, so N small calls beat C's cache-coherence machinery, and always-current matters exactly here (a sibling PR opened seconds ago is the collision you must see). Don't narrow by phase label (B): the file-owning sibling can be sitting in a different phase.

### Q5: Fix-cycle agent identity and credentials
**Context**: FR-004/FR-005/FR-006 describe a single autonomous attempt with full failure evidence in the prompt, terminating on no-diff. The spec doesn't say *which* agent runs it — a fresh worker instance on the same role that produced the red (same tools, same allowlist, same repo credentials the validate ran against), or a dedicated fixer role parallel to merge-fixer / PR-feedback (potentially different tool budget, different context window, distinct rate-limit accounting). This decides whether the fix cycle inherits the workflow's `credentialRole` (per CLAUDE.md's credhelper flow) automatically or needs a new role wired end-to-end. It also affects observability (FR-012): does a fix-cycle attempt appear as another `implement` run in the epic's activity, or as its own event stream?
**Question**: Under what role identity does the fix-cycle attempt spawn, and does it share the originating phase's credentials/tool budget?
**Options**:
- A: Fresh worker on the *same* role as the validate that produced the red (inherits `credentialRole`, tools, and prompt shell of the originating phase; the fix cycle is "a re-invocation of implement with different prompt content").
- B: A dedicated `validate-fixer` role — new role definition parallel to `merge-fixer` / `pr-feedback-handler`, with its own tool allowlist, credential wiring, and event channel (`cluster.validate-fix` or similar for FR-012 observability).
- C: Reuse the existing `merge-fixer` role verbatim (it already has the "fix failing checks" shape and the termination-discipline plumbing); provide the validate failure evidence as its prompt payload.

**Answer**: A — same role, credentials, and tool shell as the validate that produced the red; the fix is workflow work on the workflow's own branch, and a new role (B) means new credential wiring for no security boundary gained. Implementation note: share the `PrFeedbackHandler`'s spawn→commit→push→re-check plumbing (same shape, different prompt/evidence source) rather than minting a parallel stack; FR-012's observability comes from a distinct ledger/event tag, not a distinct identity. C's "merge-fixer role" doesn't exist server-side to reuse — the merge fixer is a plugin-side subagent.
