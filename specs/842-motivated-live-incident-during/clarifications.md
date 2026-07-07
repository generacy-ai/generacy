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

**Answer**: *Pending*

---

### Q2: CONTRIBUTOR tier disposition
**Context**: FR-003's default-trusted set is `OWNER`, `MEMBER`, `COLLABORATOR`. US1's excluded set is `NONE`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `MANNEQUIN`. The GitHub `CONTRIBUTOR` tier (account that has had at least one PR merged into the repo) is in neither, so its disposition is undefined.
**Question**: How should the default policy treat comments from authors with `author_association: CONTRIBUTOR`?
**Options**:
- A: Untrusted by default (fail-closed; ops must widen via FR-008 config to trust).
- B: Trusted by default (past-merged-PR is a reasonable low-bar trust signal).
- C: Trusted only for the context-ingestion surfaces (clarify-resume, pr-feedback) but never for the clarify answer-scanner.

**Answer**: *Pending*

---

### Q3: Unknown / future `author_association` values
**Context**: GitHub may introduce new `author_association` enum values. FR-011 covers the *unset* case (fail closed) but not the *known-but-unrecognized-string* case.
**Question**: How should the trust helper behave when it encounters an `author_association` value that is neither in the default-trusted set nor in the explicit untrusted enumeration (e.g., a future GitHub-added tier)?
**Options**:
- A: Treat any value not in the trusted allowlist as untrusted; no additional signaling.
- B: Treat as untrusted AND emit a `warn`-level log noting the unrecognized tier so operators find out.
- C: Fail the run (hard error) until the allowlist is explicitly updated.

**Answer**: *Pending*

---

### Q4: Config-widen scope across surfaces
**Context**: FR-008 permits widening the allowlist via `.agency/comment-trust.yaml`. The three surfaces have very different agency levels: the clarify **answer-scanner** deterministically writes into the spec via parsed `Q<N>:` answers, while **clarify-resume** and **pr-feedback** merely add context to prompts.
**Question**: Should the widen-config apply uniformly to all three surfaces, or should the answer-scanner be pinned to the hard default?
**Options**:
- A: Uniform — one allowlist applies to all three surfaces.
- B: Split — widen applies only to context surfaces (clarify-resume, pr-feedback); the answer-scanner stays at `OWNER`/`MEMBER`/`COLLABORATOR` + bot regardless of config.
- C: Per-surface config sections (`answer_scanner: {...}`, `context: {...}`) so ops can widen each independently.

**Answer**: *Pending*

---

### Q5: Skip visibility surface for the repo owner
**Context**: US2/FR-010 mandate a structured cluster-side log line per skipped comment. Cluster logs may not be readily accessible to a repo owner reviewing an in-flight run in the cloud dashboard or on GitHub, so a legitimate collaborator's dropped answer could go unnoticed.
**Question**: Beyond structured logs, does v1 need an additional user-facing surface for skipped comments?
**Options**:
- A: Structured logs only for v1; cloud/UI surfacing is a follow-up.
- B: Also emit a relay event (`cluster.workflow` or new channel) per skip so the cloud UI can display them in the run view.
- C: Post a bot summary comment on the issue/PR (e.g., at the end of the clarify or pr-feedback phase) listing skipped-comment metadata.

**Answer**: *Pending*

---
