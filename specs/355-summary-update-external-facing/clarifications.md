# Clarifications: Update Getting-Started Docs for Cluster Base Repo Approach

## Batch 1 — 2026-03-12

### Q1: No Existing cluster-templates References
**Context**: The spec's primary goal is to "replace all `cluster-templates` references in getting-started docs," but a search of the entire `docs/` directory finds zero occurrences of `cluster-templates`. This fundamentally changes the scope of work — it may be new content rather than replacements.
**Question**: Are we adding new cluster setup documentation from scratch, or do the `cluster-templates` references exist in a different location (e.g., a branch, a different docs directory, or an upstream repo)?
**Options**:
- A: The docs haven't been written yet — this is net-new content about the base repo approach
- B: The `cluster-templates` references exist elsewhere and need to be pointed out
- C: The docs were already partially cleaned up — focus on adding the new base repo content

**Answer**: No Existing cluster-templates References
**Context**: The spec's primary goal is to "replace all `cluster-templates` references in getting-started docs," but a search of the entire `docs/` directory finds zero occurrences of `cluster-templates`. This fundamentally changes the scope of work — it may be new content rather than replacements.
**Question**: Are we adding new cluster setup documentation from scratch, or do the `cluster-templates` references exist in a different location (e.g., a branch, a different docs directory, or an upstream repo)?
**Options**:
- A: The docs haven't been written yet — this is net-new content about the base repo approach
- B: The `cluster-templates` references exist elsewhere and need to be pointed out
- C: The docs were already partially cleaned up — focus on adding the new base repo content

---

### Q2: Where Does Cluster Setup Content Go?
**Context**: The current `dev-environment.md` covers dev containers (single-repo and multi-repo with Docker Compose) and `generacy init`. The spec talks about a different mechanism — merging standalone base repos via `git remote add` + `git merge`. These seem like separate concepts. Placing the content incorrectly could confuse developers.
**Question**: Should the cluster base repo setup be documented as a new section within `dev-environment.md`, as a separate new page (e.g., `cluster-setup.md`), or does it replace the existing dev container content?
**Options**:
- A: New section within `dev-environment.md` (e.g., "Cluster Setup" section)
- B: Separate new page in getting-started
- C: Replaces the existing dev container content (the dev container setup IS the cluster setup)

**Answer**: Where Does Cluster Setup Content Go?
**Context**: The current `dev-environment.md` covers dev containers (single-repo and multi-repo with Docker Compose) and `generacy init`. The spec talks about a different mechanism — merging standalone base repos via `git remote add` + `git merge`. These seem like separate concepts. Placing the content incorrectly could confuse developers.
**Question**: Should the cluster base repo setup be documented as a new section within `dev-environment.md`, as a separate new page (e.g., `cluster-setup.md`), or does it replace the existing dev container content?
**Options**:
- A: New section within `dev-environment.md` (e.g., "Cluster Setup" section)
- B: Separate new page in getting-started
- C: Replaces the existing dev container content (the dev container setup IS the cluster setup)

---

### Q3: What Is a "Cluster" to Developers?
**Context**: The term "cluster" isn't used anywhere in the current getting-started docs. The spec references `cluster-base` and `cluster-microservices` repos but doesn't define what a "cluster" means in developer-facing terms. Without a clear definition, the docs could be confusing to new developers.
**Question**: What is the developer-facing definition of a "cluster"? Is it the dev container/environment setup, infrastructure configuration, or something else? How should we introduce this concept to developers who are reading the docs for the first time?

**Answer**: What Is a "Cluster" to Developers?
**Context**: The term "cluster" isn't used anywhere in the current getting-started docs. The spec references `cluster-base` and `cluster-microservices` repos but doesn't define what a "cluster" means in developer-facing terms. Without a clear definition, the docs could be confusing to new developers.
**Question**: What is the developer-facing definition of a "cluster"? Is it the dev container/environment setup, infrastructure configuration, or something else? How should we introduce this concept to developers who are reading the docs for the first time?

---

### Q4: Onboarding PR in project-setup.md
**Context**: The spec says to "update description of what the onboarding PR does (merge commit vs file copy)" in `project-setup.md`, but the current `project-setup.md` only covers `generacy init` and doesn't mention onboarding PRs at all. The onboarding PR concept appears to be a workflow step that doesn't yet exist in the docs.
**Question**: Is the "onboarding PR" a new concept that should be added to `project-setup.md`, or is it documented elsewhere? What does the onboarding PR workflow look like from the developer's perspective — is it created by `generacy init`, by a GitHub App, or by some other mechanism?

**Answer**: Onboarding PR in project-setup.md
**Context**: The spec says to "update description of what the onboarding PR does (merge commit vs file copy)" in `project-setup.md`, but the current `project-setup.md` only covers `generacy init` and doesn't mention onboarding PRs at all. The onboarding PR concept appears to be a workflow step that doesn't yet exist in the docs.
**Question**: Is the "onboarding PR" a new concept that should be added to `project-setup.md`, or is it documented elsewhere? What does the onboarding PR workflow look like from the developer's perspective — is it created by `generacy init`, by a GitHub App, or by some other mechanism?

---

### Q5: Migration Plan as Source of Truth
**Context**: The spec references a [migration plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cluster-base-migration-plan.md) as the source of truth for technical details, but the spec itself only includes high-level information. Implementation details like the exact `cluster-base.json` schema, the git commands for each scenario, and the fork chain update workflow would be needed to write accurate documentation.
**Question**: Should the migration plan document be read and used as the primary reference for writing the new doc content, or does the spec contain sufficient detail? If the migration plan should be used, is it up-to-date and finalized?
**Options**:
- A: Yes, read the migration plan — it has the authoritative details needed for the docs
- B: The spec is sufficient — don't reference the migration plan for doc content
- C: The migration plan is still in flux — wait for it to be finalized

**Answer**: Migration Plan as Source of Truth
**Context**: The spec references a [migration plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cluster-base-migration-plan.md) as the source of truth for technical details, but the spec itself only includes high-level information. Implementation details like the exact `cluster-base.json` schema, the git commands for each scenario, and the fork chain update workflow would be needed to write accurate documentation.
**Question**: Should the migration plan document be read and used as the primary reference for writing the new doc content, or does the spec contain sufficient detail? If the migration plan should be used, is it up-to-date and finalized?
**Options**:
- A: Yes, read the migration plan — it has the authoritative details needed for the docs
- B: The spec is sufficient — don't reference the migration plan for doc content
- C: The migration plan is still in flux — wait for it to be finalized

---

*Please reply with answers in the format `Q1: A`, `Q2: your answer`, etc.*
