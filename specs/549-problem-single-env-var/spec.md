# Feature Specification: ## Problem

A single env var name, `GENERACY_CLOUD_URL`, is currently used by at least **six different readers** across three repos to mean **at least three different URLs** with different protocols and paths

**Branch**: `549-problem-single-env-var` | **Date**: 2026-05-08 | **Status**: Draft

## Summary

## Problem

A single env var name, `GENERACY_CLOUD_URL`, is currently used by at least **six different readers** across three repos to mean **at least three different URLs** with different protocols and paths. Every reader has independently decided how to interpret or derive its value, with no single source of truth, so the values can and do drift.

This was surfaced indirectly during the v1.5 staging walkthrough — the launch CLI defaulted `GENERACY_CLOUD_URL` to a prod *HTTP* URL while the cluster-relay inside the same cluster expected a *WebSocket* URL with a different host. The names matched; the meanings didn't.

## All current readers, what they actually want

| Reader | Reads value as | Source file |
|---|---|---|
| Launch CLI | HTTP **API base URL** (e.g. `https://api-staging.generacy.ai`) — used to call `/api/clusters/launch-config` | [packages/generacy/src/cli/commands/launch/index.ts:97](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/launch/index.ts#L97) |
| Orchestrator activation config | HTTP **API base URL** for device-code OAuth flow | [packages/orchestrator/src/config/loader.ts:245-246](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/config/loader.ts#L245-L246) |
| Orchestrator relay config | WebSocket **relay URL** (derives from `GENERACY_CHANNEL` if missing) | [packages/orchestrator/src/config/loader.ts:263-265](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/config/loader.ts#L263-L265) |
| Cluster-relay package | WebSocket **relay URL** | [packages/cluster-relay/src/relay.ts:25](https://github.com/generacy-ai/generacy/blob/develop/packages/cluster-relay/src/relay.ts#L25) |
| Cloud worker template generator | WebSocket **relay URL** with `?projectId=` appended | [generacy-cloud/services/worker/src/lib/templates.ts:122](https://github.com/generacy-ai/generacy-cloud/blob/develop/services/worker/src/lib/templates.ts#L122) |
| DigitalOcean cloud-deploy | (per source) relay URL set on cloud-deployed clusters | [generacy-cloud/services/api/src/services/cloud-deploy/digitalocean.ts:84](https://github.com/generacy-ai/generacy-cloud/blob/develop/services/api/src/services/cloud-deploy/digitalocean.ts#L84) |
| Cluster-base `.env.template` | WebSocket **relay URL** | [.devcontainer/generacy/.env.template](https://github.com/generacy-ai/cluster-base/blob/develop/.devcontainer/generacy/.env.template) |

The orchestrator package alone reads the same env var for two different URL kinds (HTTP API base + WS relay), 18 lines apart in the same config loader.

There's also a fourth, related URL — the **app/dashboard URL** — that the cloud's `buildLaunchConfig` sends in `LaunchConfig.cloudUrl` (a fourth distinct meaning) for the cluster to use when generating browser deep-links. It's not currently named `GENERACY_CLOUD_URL` on the cluster side, but the LaunchConfig field name does add to the confusion.

## Proposed shape

Split `GENERACY_CLOUD_URL` into explicit names. **Two** env vars are written to the cluster's `.env`; `GENERACY_APP_URL` is deferred until a cluster-side consumer exists (see Resolved Q5):

| Name | Value (staging example) | Purpose | Written to cluster `.env`? |
|---|---|---|---|
| `GENERACY_API_URL` | `https://api-staging.generacy.ai` | HTTP REST calls (launch-config, device-code, activate, etc.) | Yes |
| `GENERACY_RELAY_URL` | `wss://api-staging.generacy.ai/relay?projectId=proj_123` | Long-lived WebSocket from cluster-relay package (fully qualified, including projectId) | Yes |
| `GENERACY_APP_URL` | `https://staging.generacy.ai` | User-facing dashboard / browser deep-links | No — CLI uses for registry only |

`GENERACY_RELAY_URL` is kept as a separate, independently-configurable env var (not derived from `GENERACY_API_URL`) for custom-domain and relay-scaling headroom (see Resolved Q1). The cloud sends it fully qualified with `?projectId=` included (see Resolved Q2).

The cloud is the source of truth via a structured `cloud` object on `LaunchConfig`:

```ts
LaunchConfig {
  // ...existing fields...
  cloud: {
    apiUrl: string;    // built from PUBLIC_API_URL || PUBLIC_APP_URL on the cloud
    appUrl: string;    // built from PUBLIC_APP_URL on the cloud
    relayUrl: string;  // fully qualified: wss://host/relay?projectId=<id>
  };
  cloudUrl?: string;  // deprecated alias for cloud.appUrl, kept one release for compat
}
```

The launch scaffolder writes `GENERACY_API_URL` and `GENERACY_RELAY_URL` from the new `LaunchConfig.cloud` object. `cloud.appUrl` is used by the CLI for the registry's `cloudUrl` field but not propagated to the cluster runtime. Readers consume the explicit env var. No client-side derivation. No name overload.

## Why this is materially better than today

1. **Single source of truth.** The cloud knows its own URLs (it serves them). Today the launch CLI guesses by env var, the cluster-relay derives `wss://` from `https://` by string-munging, and the orchestrator looks up `GENERACY_CHANNEL` to decide which relay to use. Cloud-as-source-of-truth means everyone gets correct values for free.
2. **No ambiguity at the read site.** `process.env.GENERACY_API_URL` has one meaning. `process.env.GENERACY_CLOUD_URL` has — at minimum — three.
3. **Custom-domain ready.** A self-hosted Generacy install with `api.acme-corp.internal` for the API and `dashboard.acme-corp.internal` for the frontend just sets all three correctly. The current convention assumes URLs are related by string transformation, which breaks under custom domains.
4. **Eliminates the orchestrator's same-name-different-purpose pattern.** The two reads in `loader.ts` lines 245 and 263 become reads of two different env vars.

## Migration plan

**Scope for this issue (#549)**: generacy repo only (Phase 2 + Phase 3 reader/writer changes). Cloud-side and cluster-base changes are separate follow-up issues. Code must tolerate missing `LaunchConfig.cloud` by falling back to existing `LaunchConfig.cloudUrl` (see Resolved Q3).

**Phase 1: Cloud-side (additive) — SEPARATE ISSUE (generacy-cloud).**
- Add `cloud.apiUrl`, `cloud.appUrl`, `cloud.relayUrl` to `LaunchConfigSchema` and `buildLaunchConfig`. `cloud.relayUrl` is fully qualified with `?projectId=`. Keep existing `cloudUrl` field as deprecated alias for `cloud.appUrl`.

**Phase 2: Reader-side (additive, deprecation logs) — THIS ISSUE.**
- CLI: read `GENERACY_API_URL` first, fall back to `GENERACY_CLOUD_URL` with a one-time `[deprecated] GENERACY_CLOUD_URL is ambiguous, prefer GENERACY_API_URL` log.
- Orchestrator: split the two reads at `loader.ts:245` and `:263` to use `GENERACY_API_URL` and `GENERACY_RELAY_URL` respectively, with the same fallback pattern. Drop the `projectId` append logic at `loader.ts:280-290` (dead code once cloud pre-appends).
- Cluster-relay package: read `GENERACY_RELAY_URL` first, fall back to `GENERACY_CLOUD_URL`.
- All deprecation logs are debug-level, fired once per process.
- `LaunchConfigSchema`: add optional `cloud: { apiUrl, appUrl, relayUrl }` object. Keep `cloudUrl` as deprecated alias (see Resolved Q4). Consumers prefer `cloud.appUrl` when present, fall back to `cloudUrl`.

**Phase 3: Writer-side — THIS ISSUE (generacy repo parts only).**
- Launch scaffolder ([packages/generacy/src/cli/commands/cluster/scaffolder.ts:99](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/cluster/scaffolder.ts#L99)): write `GENERACY_API_URL` and `GENERACY_RELAY_URL` from `LaunchConfig.cloud` (when present) or derived from `LaunchConfig.cloudUrl` (fallback). Do NOT write `GENERACY_APP_URL` to `.env` (see Resolved Q5). Drop `GENERACY_CLOUD_URL` line.
- Test fixtures (STUB_LAUNCH_CONFIG in cloud-client.ts): add `cloud` object to match new schema.

**Phase 3b: Writer-side — SEPARATE ISSUES (other repos).**
- Cloud worker template generator: emit `GENERACY_RELAY_URL=` instead of `GENERACY_CLOUD_URL=`.
- DigitalOcean cloud-deploy: set the correct env var for what it configures.
- Cluster-base `.env.template`: split into two new lines (`GENERACY_API_URL`, `GENERACY_RELAY_URL`).

**Phase 4 (next major release): cleanup — SEPARATE ISSUE.**
- Remove the `GENERACY_CLOUD_URL` fallbacks from all readers.
- Remove the deprecated `LaunchConfig.cloudUrl` top-level field.
- Update v1.5 onboarding doc to reference the new names.

## Resolved questions (from clarify phase)

- **Q1 → A**: `GENERACY_RELAY_URL` stays as a separate env var. Not derived from API URL. Reasons: derivation is three transformations (scheme + path + projectId), custom-domain headroom, relay may move to separate domain.
- **Q2 → A**: Cloud includes `projectId` in `cloud.relayUrl` (fully qualified). Orchestrator's existing `includes('projectId=')` guard handles this. Drop the append logic from `loader.ts:280-290` as dead code.
- **Q3 → B**: This issue covers generacy repo only. Follow-up issues for: generacy-cloud Phase 1, generacy-cloud Phase 3 writers, cluster-base `.env.template`, generacy Phase 4 cleanup. Code must tolerate missing `LaunchConfig.cloud`.
- **Q4 → A**: Rename with deprecated alias. `LaunchConfig.cloud.appUrl` is canonical; `cloudUrl` kept for one release. Important: `cloudUrl` is persisted in `~/.generacy/clusters.json`, so breaking rename is not an option.
- **Q5 → C**: Skip writing `GENERACY_APP_URL` to cluster `.env`. No current consumer. Cloud still sends `cloud.appUrl` in LaunchConfig for CLI registry use. Add env var later when a cluster-side consumer exists.
- **Q1 (original)**: GitHub OAuth callback URL — out of scope for this issue.
- **Test fixtures**: STUB_LAUNCH_CONFIG and cloud tests need `cloud` object — confirmed, handled in Phase 3.

## Related

- generacy#543 — scaffolded compose runtime mismatch. The scaffolder work there will set the relevant env vars in `.env`. If this issue lands first, #543 writes the new names directly. If #543 lands first, this issue has a separate cleanup pass on the scaffolder. Either order works; coordination point is the scaffolder's writer code.
- generacy#545 — `--cloud-url` flag for `generacy launch`. The flag should be renamed `--api-url` once this issue lands, since "cloud URL" is now ambiguous.
- generacy-cloud#518 — "Run on my computer" copy-paste command. Today plans to embed `GENERACY_CLOUD_URL=...` (HTTP API URL). Should be `GENERACY_API_URL=...` once this issue lands, or `--api-url=...` if #545 also lands.
- The v1.5 onboarding doc references "cloud URL" generically in several places — should be audited for clarity once this lands.

## User Stories

### US1: Cluster operator deploys without URL confusion

**As a** cluster operator running `generacy launch`,
**I want** each env var to have exactly one meaning,
**So that** staging vs. production URL mismatches (like the v1.5 walkthrough failure) cannot happen.

**Acceptance Criteria**:
- [ ] `GENERACY_API_URL` is read by all HTTP API callers (CLI launch, orchestrator activation)
- [ ] `GENERACY_RELAY_URL` is read by all WebSocket consumers (orchestrator relay config, cluster-relay package)
- [ ] Falling back to `GENERACY_CLOUD_URL` produces a debug-level deprecation log
- [ ] Scaffolder writes new env var names to `.env` when `LaunchConfig.cloud` is present
- [ ] Scaffolder falls back to deriving from `LaunchConfig.cloudUrl` when `cloud` object is absent

### US2: Self-hosted install uses custom domains

**As a** self-hosted Generacy admin,
**I want** the API, relay, and app URLs to be independently configurable,
**So that** my `api.acme-corp.internal` and `ws.acme-corp.internal` setup works without string-munging assumptions.

**Acceptance Criteria**:
- [ ] Each URL is an independent env var — no derivation from another
- [ ] Cloud sends all three in `LaunchConfig.cloud`; cluster consumes as-is

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add optional `cloud` object to `LaunchConfigSchema` (apiUrl, appUrl, relayUrl) | P1 | Zod schema in launch/types.ts |
| FR-002 | CLI `resolveCloudUrl()` reads `GENERACY_API_URL` first, falls back to `GENERACY_CLOUD_URL` with deprecation log | P1 | cloud-url.ts |
| FR-003 | Orchestrator config loader reads `GENERACY_API_URL` at line 245, `GENERACY_RELAY_URL` at line 263, both with fallback | P1 | loader.ts |
| FR-004 | Cluster-relay reads `GENERACY_RELAY_URL` first, falls back to `GENERACY_CLOUD_URL` | P1 | relay.ts |
| FR-005 | Remove `projectId` append logic from orchestrator loader (dead code once cloud pre-appends) | P2 | loader.ts:280-290 |
| FR-006 | Scaffolder writes `GENERACY_API_URL` and `GENERACY_RELAY_URL` to `.env` from `LaunchConfig.cloud` | P1 | scaffolder.ts |
| FR-007 | Scaffolder falls back to deriving from `LaunchConfig.cloudUrl` when `cloud` is absent | P1 | Backward compat |
| FR-008 | `LaunchConfig.cloudUrl` kept as deprecated alias for `cloud.appUrl` | P1 | One release window |
| FR-009 | Update STUB_LAUNCH_CONFIG in cloud-client.ts to include `cloud` object | P2 | Test fixture |
| FR-010 | CLI uses `cloud.appUrl` (or `cloudUrl` fallback) for registry `cloudUrl` field, not written to cluster `.env` | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | No reader uses `GENERACY_CLOUD_URL` without fallback chain | 0 direct reads | grep codebase |
| SC-002 | Scaffolded `.env` contains `GENERACY_API_URL` and `GENERACY_RELAY_URL` | 100% of new clusters | Manual verification / test |
| SC-003 | Existing clusters (no `LaunchConfig.cloud`) still work | No regressions | Launch with old cloud response |

## Assumptions

- The cloud-side `LaunchConfig` changes (Phase 1) will land in a separate follow-up issue. This issue's code must work with or without the `cloud` object.
- The deprecation window of one release is sufficient given the small v1.5 user population.
- `cloud.relayUrl` from the cloud will always include `?projectId=` when present.

## Out of Scope

- GitHub OAuth callback URL (`OAUTH_REDIRECT_URI_*`) — separate concern
- Writing `GENERACY_APP_URL` to cluster `.env` — no consumer exists yet
- Cloud-side changes (generacy-cloud `buildLaunchConfig`, worker template, DigitalOcean deploy) — follow-up issues
- Cluster-base `.env.template` changes — follow-up issue
- Phase 4 cleanup (removing fallbacks) — follow-up issue after deprecation window

---

*Generated by speckit*
