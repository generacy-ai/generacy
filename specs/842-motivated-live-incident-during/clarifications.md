# Clarifications: Author-trust gating for workflow-ingested GitHub comments

**Issue**: [#842](https://github.com/generacy-ai/generacy/issues/842)
**Spec**: [spec.md](./spec.md)

---

## Batch 1 — 2026-07-07

### Q1: Bot identity source
**Context**: FR-012 requires the cluster's own bot identity to always be trusted. The spec does not say how the running code discovers the bot's GitHub login. This blocks FR-012 implementation because we need to know where to read the value from.
**Question**: Where should the cluster read its own bot login from?
**Options**:
- A: Env var (e.g., `GENERACY_BOT_LOGIN`) set by the orchestrator entrypoint from cluster-side config.
- B: Runtime `gh api /user` lookup at first use, memoized for the process lifetime.
- C: Field on `.generacy/cluster.json` (persisted at activation time).
- D: Convention-based derivation from the GitHub App slug (e.g., `<app-slug>[bot]`).

**Answer**: A, amended — don't mint a new `GENERACY_BOT_LOGIN`; reuse the existing cluster-identity resolution chain from `identity.ts` (`CLUSTER_GITHUB_USERNAME` → `GH_USERNAME` → memoized `gh api /user`, per #830). One identity mechanism across the orchestrator and this check. Option B alone is broken in exactly the environment that matters — `gh api /user` 403s on App-token clusters (the #830 lesson) — and D's slug derivation is fragile. If the chain resolves nothing, `warn` and proceed with association-tier trust only (never fail the run over an unresolvable bot login).

---

### Q2: CONTRIBUTOR tier disposition
**Context**: FR-003's default-trusted set is `OWNER`, `MEMBER`, `COLLABORATOR`. US1's excluded set is `NONE`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `MANNEQUIN`. The GitHub `CONTRIBUTOR` tier (account that has had at least one PR merged into the repo) is in neither, so its disposition is undefined.
**Question**: How should the default policy treat comments from authors with `author_association: CONTRIBUTOR`?
**Options**:
- A: Untrusted by default (fail-closed; ops must widen via FR-008 config to trust).
- B: Trusted by default (past-merged-PR is a reasonable low-bar trust signal).
- C: Trusted only for the context-ingestion surfaces (clarify-resume, pr-feedback) but never for the clarify answer-scanner.

**Answer**: A — `CONTRIBUTOR` is untrusted by default. One merged PR ever is a bar an attacker clears with a typo fix; the threat model here is steering autonomous agents, so fail closed and let teams widen via FR-008 config deliberately. Not C — a split disposition for a tier we distrust is complexity without a constituency.

---

### Q3: Unknown / future `author_association` values
**Context**: GitHub may introduce new `author_association` enum values. FR-011 covers the *unset* case (fail closed) but not the *known-but-unrecognized-string* case.
**Question**: How should the trust helper behave when it encounters an `author_association` value that is neither in the default-trusted set nor in the explicit untrusted enumeration (e.g., a future GitHub-added tier)?
**Options**:
- A: Treat any value not in the trusted allowlist as untrusted; no additional signaling.
- B: Treat as untrusted AND emit a `warn`-level log noting the unrecognized tier so operators find out.
- C: Fail the run (hard error) until the allowlist is explicitly updated.

**Answer**: B — treat unrecognized association values as untrusted AND emit a `warn`-level log naming the tier. Fail closed for safety, fail loud for operators; option C bricks every run the day GitHub adds an enum value.

---

### Q4: Config-widen scope across surfaces
**Context**: FR-008 permits widening the allowlist via `.agency/comment-trust.yaml`. The three surfaces have very different agency levels: the clarify **answer-scanner** deterministically writes into the spec via parsed `Q<N>:` answers, while **clarify-resume** and **pr-feedback** merely add context to prompts.
**Question**: Should the widen-config apply uniformly to all three surfaces, or should the answer-scanner be pinned to the hard default?
**Options**:
- A: Uniform — one allowlist applies to all three surfaces.
- B: Split — widen applies only to context surfaces (clarify-resume, pr-feedback); the answer-scanner stays at `OWNER`/`MEMBER`/`COLLABORATOR` + bot regardless of config.
- C: Per-surface config sections (`answer_scanner: {...}`, `context: {...}`) so ops can widen each independently.

**Answer**: B — the answer-scanner stays pinned to the hard default (`OWNER`/`MEMBER`/`COLLABORATOR` + bot) regardless of config; widening applies only to the context surfaces (clarify-resume, pr-feedback). The scanner deterministically writes into the spec — one YAML line letting outsiders answer clarifications is one YAML line letting outsiders steer the build. Context ingestion is advisory and can be team-tuned. Not C: per-surface config sections are surface nobody has asked for.

---

### Q5: Skip visibility surface for the repo owner
**Context**: US2/FR-010 mandate a structured cluster-side log line per skipped comment. Cluster logs may not be readily accessible to a repo owner reviewing an in-flight run in the cloud dashboard or on GitHub, so a legitimate collaborator's dropped answer could go unnoticed.
**Question**: Beyond structured logs, does v1 need an additional user-facing surface for skipped comments?
**Options**:
- A: Structured logs only for v1; cloud/UI surfacing is a follow-up.
- B: Also emit a relay event (`cluster.workflow` or new channel) per skip so the cloud UI can display them in the run view.
- C: Post a bot summary comment on the issue/PR (e.g., at the end of the clarify or pr-feedback phase) listing skipped-comment metadata.

**Answer**: C, narrowed — when a skipped comment **matched the answer pattern** (`Q<n>:` lines), post one bot comment on the issue: *"answers from @&lt;author&gt; were not applied (untrusted author tier); a member must post or confirm the answers."* That failure mode otherwise presents as the workflow inexplicably ignoring visible answers on GitHub — the confusion lives on GitHub, so the explanation must too. Generic context-surface skips stay structured-logs-only (option A's scope), and a relay/cloud-UI event (option B) is a sensible follow-up, not v1.

---
