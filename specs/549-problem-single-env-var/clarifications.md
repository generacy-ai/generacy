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

**Answer**: *Pending*

---

### Q2: projectId query parameter in cloud-provided relay URL

**Context**: Currently both `deriveRelayUrl()` (scaffolder.ts:77-84) and the orchestrator's config loader (loader.ts:280-290) append `?projectId=<id>` to the relay URL. If the cloud now sends `cloud.relayUrl` explicitly, there's an open question about whether the cloud includes the `projectId` query param or whether each reader still appends it. Double-appending would break connectivity; omitting it would also break.

**Question**: When the cloud sends `cloud.relayUrl` in the LaunchConfig, does it include `?projectId=<id>`, or must the scaffolder/reader still append the projectId?

**Options**:
- A: Cloud includes projectId — `cloud.relayUrl` is `wss://api.generacy.ai/relay?projectId=proj_123`, readers use as-is
- B: Cloud omits projectId — `cloud.relayUrl` is `wss://api.generacy.ai/relay`, scaffolder or orchestrator appends `?projectId=`
- C: Cloud sends base relay URL, scaffolder appends projectId when writing `.env` (so the orchestrator gets it pre-appended)

**Answer**: *Pending*

---

### Q3: Cross-repo scope for this issue

**Context**: The spec lists FR-008 (cloud worker template), FR-009 (cluster-base `.env.template`), and FR-010 (DigitalOcean cloud-deploy) as changes in the `generacy-cloud` and `cluster-base` repos. This PR is in the `generacy` repo. If those changes are separate issues, this PR must handle the "cloud hasn't been updated yet" case gracefully (i.e., `LaunchConfig.cloud` might not exist).

**Question**: Are the generacy-cloud and cluster-base repo changes (FR-008, FR-009, FR-010, and Phase 1 cloud-side additions) tracked under this issue or as separate follow-up issues?

**Options**:
- A: All in this issue — this PR spans all three repos (or the cloud changes are prerequisite PRs under the same issue)
- B: Separate issues — this PR covers only the `generacy` repo; cloud/cluster-base changes are follow-ups. The code must tolerate missing `LaunchConfig.cloud`.

**Answer**: *Pending*

---

### Q4: Rename LaunchConfig.cloudUrl to LaunchConfig.cloud.appUrl

**Context**: The spec proposes adding `LaunchConfig.cloud: { apiUrl, appUrl, relayUrl }` and keeping `cloudUrl` as a deprecated alias. This is a breaking change to the LaunchConfig API shape. The spec recommends yes — the new name is clearer. But this affects both the cloud's `buildLaunchConfig` response and every consumer that parses it.

**Question**: Should `LaunchConfig.cloudUrl` be renamed to `LaunchConfig.cloud.appUrl` with `cloudUrl` kept as a deprecated alias for one release?

**Options**:
- A: Yes, rename with alias (spec recommendation) — add `cloud.appUrl`, keep `cloudUrl` deprecated for one release
- B: Yes, rename without alias — breaking change, old CLIs fail on new cloud responses
- C: No rename — keep `cloudUrl` as-is, add `cloud` as a sibling object (avoids breaking old CLIs entirely)

**Answer**: *Pending*

---

### Q5: GENERACY_APP_URL cluster-side consumer

**Context**: The spec introduces `GENERACY_APP_URL` for "user-facing dashboard / browser deep-links." However, no current code inside the cluster reads an app/dashboard URL from an env var. The `open` CLI command reads `cloudUrl` from the registry, not from an env var. The control-plane's `GET /state` doesn't return a dashboard URL. Writing `GENERACY_APP_URL` to `.env` without a consumer would be dead configuration.

**Question**: Is there a concrete cluster-side consumer for `GENERACY_APP_URL` today, or is it written to `.env` purely for forward-compatibility (e.g., future orchestrator deep-link generation)?

**Options**:
- A: Forward-compatibility only — write it to `.env` now, consumers come later
- B: The orchestrator or control-plane already needs it — specify which component reads it and for what
- C: Skip writing it for now — only introduce `GENERACY_API_URL` and `GENERACY_RELAY_URL`; add app URL when there's a consumer

**Answer**: *Pending*
