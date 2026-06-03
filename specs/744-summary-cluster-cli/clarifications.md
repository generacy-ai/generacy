# Clarifications

<!-- Each batch adds questions with sequential numbering. Answers replace `*Pending*` in place. -->

## Batch 1 — 2026-06-03

### Q1: Tunnel name source
**Context**: FR-001 keeps `deriveTunnelName(clusterId)` UUID-derived (`g-<uuid18>`). The spec's Open Question 1 asks whether to keep that or switch to a name-derived scheme (sanitized display name + uniqueness suffix). This choice ripples through the helper, the collision story (FR-012), and how cloud renders tunnel identity.
**Question**: Should the tunnel name continue to be UUID-derived (`g-<uuid18>`), or should it be derived from the user-facing display name with a uniqueness suffix?
**Options**:
- A: Keep UUID-derived (`g-<uuid18>`) — already unique within the 20-char/lowercase/letter-initial constraint, fully decouples tunnel name from display name (matches spec recommendation and FR-008).
- B: Name-derived (sanitize the display name to `[a-z0-9-]`, truncate, append `-<n>` if a collision is detected locally) — tunnel name is human-readable but coupled to display name and must be regenerated on rename.
- C: Hybrid — name-prefix + short UUID hash suffix (e.g. `<short-name>-<6hex>`).

**Answer**: **A** — Keep UUID-derived (`g-<uuid18>`). Matches generacy-ai/generacy-cloud#792 Q1; the tunnel name stays decoupled from the display name, within the ≤20 / lowercase / letter-initial constraint, with no sanitization/collision handling needed.

### Q2: Default-name uniqueness scope
**Context**: FR-004 says the default name pattern is `<sanitized-project>-local-<n>`, where "`<n>` is the next free integer for that project on the local machine." Open Question 2 asks what "for that project" means — strictly per project, or per project+mode (so cloud-launched and local-launched clusters increment separately). This determines the registry lookup used by the scaffolder.
**Question**: When generating the default `<n>` for a new local cluster, which scope should be used to find the "next free integer"?
**Options**:
- A: Per `projectId` only — count any existing cluster entry in `~/.generacy/clusters.json` whose `projectId` matches, regardless of deployment mode.
- B: Per `projectId` + deployment mode — only count clusters whose `deploymentMode === 'local'` (cloud / SSH-deployed clusters increment a separate sequence; matches the `-local-` literal in the pattern).
- C: Per `projectId` + name-prefix — count entries whose name starts with `<sanitized-project>-local-` (so manually-renamed clusters don't shift the sequence).

**Answer**: **B** — Per `projectId` + deployment mode (count only entries where `deploymentMode === 'local'`). Matches the `-local-` literal in the pattern and #792's per-(project, mode) sequence decision; cloud/SSH clusters increment their own sequence.

### Q3: Cluster UUID minting site
**Context**: Open Question 3 asks where the cluster UUID is minted so cloud and local agree on the id. Today the activation flow (`packages/orchestrator/src/activation/`) treats the cluster id as cloud-issued (returned in the device-flow poll result and persisted in `cluster.json`). The scaffolder writes `cluster.json` *before* activation runs, so it currently leaves `cluster_id` blank or placeholder. With multi-cluster, the CLI needs a stable id from creation time.
**Question**: Where should the cluster UUID be minted for newly-launched clusters?
**Options**:
- A: Cloud-minted (status quo) — CLI scaffolds with no `cluster_id`; activation device-flow returns the id and writes it. Default name `<...>-local-<n>` is computed *after* activation, against the cloud-returned id.
- B: CLI-minted at scaffold time — CLI generates a UUIDv4, writes it into `cluster.json`, and the activation request *advertises* it to cloud (cloud accepts the proposed id or rejects on conflict).
- C: CLI-minted with cloud confirmation — CLI proposes, cloud may overwrite during activation; CLI updates `cluster.json` with whichever id cloud confirms.

**Answer**: **A** — Cloud-minted (status quo). Local `launch` already activates against cloud via the device-code flow, so keep cloud as the single authority for the cluster UUID and have the CLI write back the id cloud returns. Avoids propose/confirm conflict handling. The default name doesn't need the id (it's `<sanitized-project>-local-<n>` derived from the local registry), so it can be computed independently of activation.

### Q4: Name validation and project-sanitization rules
**Context**: FR-003 says `--name <name>` is "validated as non-empty," but doesn't specify the allowed character set, max length, or how the display name is normalized at persistence time. FR-004 references `<sanitized-project>` without defining the sanitization algorithm or how it handles edge cases (uppercase, spaces, emoji, leading digits, very long project names). These are blocking for the scaffolder and the registry schema.
**Question**: What are the validation rules for `--name <name>` input and the sanitization rules for `<sanitized-project>` in the default pattern?
**Options**:
- A: **Strict slug** — `--name` must match `^[a-z0-9][a-z0-9-]{0,62}$` (reject otherwise with a clear error). Project sanitization: lowercase, replace any non-`[a-z0-9-]` run with `-`, trim leading/trailing `-`, truncate to 40 chars, prepend `c-` if first char is not a letter.
- B: **Permissive + normalize** — Accept any non-empty `--name` up to 63 chars; normalize internally (same algorithm as project sanitization in A) and store the normalized form as the display name. Reject only if normalization yields an empty string.
- C: **Permissive + preserve** — Store `--name` verbatim (UTF-8, non-empty, ≤63 chars) as the display name; apply sanitization only when generating the default `<sanitized-project>-local-<n>` form.

**Answer**: **B** — Permissive + normalize. Accept any non-empty `--name` (≤63 chars), normalize to a slug with the same algorithm as project sanitization, and store the normalized form as the display name; reject only if it normalizes to empty. Keeps user-provided names visually consistent with the auto-generated `<project>-local-<n>` names and avoids display/identity drift. (The tunnel name is UUID-derived regardless, so this is purely about the human label.)

### Q5: Naming parity for `generacy deploy`
**Context**: The spec scopes naming to `generacy launch` (FR-003, FR-005). But `generacy deploy ssh://...` follows the same scaffolder + registry path and also produces a multi-cluster-eligible cluster. Without explicit guidance, it's unclear whether `deploy` gets the same `--name` flag, the same `<sanitized-project>-<mode>-<n>` default, or whether naming is launch-only in this milestone.
**Question**: Should `generacy deploy` also accept `--name` (and a parallel default-name scheme) in this milestone, or is naming limited to `launch`?
**Options**:
- A: **Yes, full parity** — `deploy` accepts `--name`, persists it the same way, and defaults to `<sanitized-project>-ssh-<n>` (or `<sanitized-project>-<host>-<n>`). Same registry treatment.
- B: **Yes, flag only** — `deploy` accepts `--name`, but default-name generation for non-launch paths is out of scope (deploy without `--name` falls back to current behavior / cluster id).
- C: **No, launch-only** — Naming flag is `launch`-only in this milestone; `deploy` naming is a follow-up issue.

**Answer**: **B** — Accept `--name` on `generacy deploy` too (cheap flag parity so the CLI surface isn't inconsistent), but defer deploy **default-name generation** (the `-ssh-<n>` / `-<host>-<n>` scheme) to a follow-up. `launch` gets the full default generator in this milestone.
