# Clarifications: Disambiguate `GENERACY_CLOUD_URL` into explicit env vars

**Issue**: #549 | **Branch**: `549-problem-single-env-var`

---

## Batch 1 — 2026-05-08

### Q1: Relay URL — keep as separate env var or derive from API URL?

**Context**: The spec proposes `GENERACY_RELAY_URL` as a standalone env var. However, currently `deriveRelayUrl()` in the scaffolder already derives it from the HTTP cloud URL via simple protocol swap + `/relay` path. If the relay URL always follows this pattern, a separate env var adds configuration surface without adding value. The spec recommends keeping it explicit for custom-domain and scaling scenarios.

**Question**: Should `GENERACY_RELAY_URL` remain a separate, independently-configurable env var (cloud sends it explicitly), or should readers derive it from `GENERACY_API_URL` and we drop the separate var?

**Options**:
- A: Keep separate — cloud sends all three URLs explicitly; readers consume `GENERACY_RELAY_URL` directly (spec recommendation)
- B: Derive from API URL — only `GENERACY_API_URL` and `GENERACY_APP_URL` are explicit; relay is derived client-side

**Answer**: **A — Keep separate.** Three reasons derivation (B) is worse: (1) it's not just protocol swap — needs scheme swap, `/relay` path, `?projectId=` — three transformations each with failure modes; (2) custom-domain and migration headroom — relay may move to a different domain for scaling; (3) the "savings" of dropping the var is one schema field + one `.env` line, not worth losing cloud-as-source-of-truth.

---

### Q2: projectId query parameter in cloud-provided relay URL

**Context**: Currently both `deriveRelayUrl()` (scaffolder.ts:77-84) and the orchestrator's config loader (loader.ts:280-290) append `?projectId=<id>` to the relay URL. If the cloud now sends `cloud.relayUrl` explicitly, there's an open question about whether the cloud includes the `projectId` query param or whether each reader still appends it. Double-appending would break connectivity; omitting it would also break.

**Question**: When the cloud sends `cloud.relayUrl` in the LaunchConfig, does it include `?projectId=<id>`, or must the scaffolder/reader still append the projectId?

**Options**:
- A: Cloud includes projectId — `cloud.relayUrl` is `wss://api.generacy.ai/relay?projectId=proj_123`, readers use as-is
- B: Cloud omits projectId — `cloud.relayUrl` is `wss://api.generacy.ai/relay`, scaffolder or orchestrator appends `?projectId=`
- C: Cloud sends base relay URL, scaffolder appends projectId when writing `.env` (so the orchestrator gets it pre-appended)

**Answer**: **A — Cloud includes projectId.** Both current code paths handle this: orchestrator config loader already guards with `if (!relayCloudUrl.includes('projectId='))`, and cloud's worker template generator already pre-appends projectId. Option A consolidates around the existing cloud-side pattern. Cloud is source of truth for both environment (relay base) and cluster (projectId). Bonus: drop the append logic from `loader.ts:280-290` as dead code.

---

### Q3: Cross-repo scope for this issue

**Context**: The spec lists FR-008 (cloud worker template), FR-009 (cluster-base `.env.template`), and FR-010 (DigitalOcean cloud-deploy) as changes in the `generacy-cloud` and `cluster-base` repos. This PR is in the `generacy` repo. If those changes are separate issues, this PR must handle the "cloud hasn't been updated yet" case gracefully (i.e., `LaunchConfig.cloud` might not exist).

**Question**: Are the generacy-cloud and cluster-base repo changes (FR-008, FR-009, FR-010, and Phase 1 cloud-side additions) tracked under this issue or as separate follow-up issues?

**Options**:
- A: All in this issue — this PR spans all three repos (or the cloud changes are prerequisite PRs under the same issue)
- B: Separate issues — this PR covers only the `generacy` repo; cloud/cluster-base changes are follow-ups. The code must tolerate missing `LaunchConfig.cloud`.

**Answer**: **B — Separate issues per repo.** This issue (#549, generacy repo) covers Phase 2 + Phase 3 changes in this repo — CLI fallback chain, scaffolder writing new `.env` names, schema additions. Must tolerate missing `LaunchConfig.cloud` by falling back to existing `LaunchConfig.cloudUrl`. Follow-up issues: (1) generacy-cloud for Phase 1 (`buildLaunchConfig` adds `cloud` object), (2) generacy-cloud for Phase 3 (worker template + DigitalOcean writers), (3) cluster-base for `.env.template` split, (4) generacy Phase 4 cleanup (remove fallbacks).

---

### Q4: Rename LaunchConfig.cloudUrl to LaunchConfig.cloud.appUrl

**Context**: The spec proposes adding `LaunchConfig.cloud: { apiUrl, appUrl, relayUrl }` and keeping `cloudUrl` as a deprecated alias. This is a breaking change to the LaunchConfig API shape. The spec recommends yes — the new name is clearer. But this affects both the cloud's `buildLaunchConfig` response and every consumer that parses it.

**Question**: Should `LaunchConfig.cloudUrl` be renamed to `LaunchConfig.cloud.appUrl` with `cloudUrl` kept as a deprecated alias for one release?

**Options**:
- A: Yes, rename with alias (spec recommendation) — add `cloud.appUrl`, keep `cloudUrl` deprecated for one release
- B: Yes, rename without alias — breaking change, old CLIs fail on new cloud responses
- C: No rename — keep `cloudUrl` as-is, add `cloud` as a sibling object (avoids breaking old CLIs entirely)

**Answer**: **A — Rename with deprecated alias.** Critical: `LaunchConfig.cloudUrl` is persisted into `~/.generacy/clusters.json` — breaking rename (B) would bork existing registries. C leaves permanent "which is canonical?" confusion. A is the right balance: new readers prefer `cloud.appUrl`, old readers read deprecated `cloudUrl` for one release, cloud emits both. Phase 4 cleanup removes `cloudUrl`. Short deprecation window is fine given small v1.5 user population.

---

### Q5: GENERACY_APP_URL cluster-side consumer

**Context**: The spec introduces `GENERACY_APP_URL` for "user-facing dashboard / browser deep-links." However, no current code inside the cluster reads an app/dashboard URL from an env var. The `open` CLI command reads `cloudUrl` from the registry, not from an env var. The control-plane's `GET /state` doesn't return a dashboard URL. Writing `GENERACY_APP_URL` to `.env` without a consumer would be dead configuration.

**Question**: Is there a concrete cluster-side consumer for `GENERACY_APP_URL` today, or is it written to `.env` purely for forward-compatibility (e.g., future orchestrator deep-link generation)?

**Options**:
- A: Forward-compatibility only — write it to `.env` now, consumers come later
- B: The orchestrator or control-plane already needs it — specify which component reads it and for what
- C: Skip writing it for now — only introduce `GENERACY_API_URL` and `GENERACY_RELAY_URL`; add app URL when there's a consumer

**Answer**: **C — Skip writing `GENERACY_APP_URL` to `.env`.** No current cluster-side consumer exists. Dead config invites confusion. Migration cost of *adding* a var later is trivial (one `.env` line); cost of *removing* dead config is higher (stale values in every scaffolded cluster). Cloud should still send `cloud.appUrl` in LaunchConfig (per Q4=A) — CLI uses it for registry's `cloudUrl` field. Just don't propagate to cluster runtime until something reads it.
