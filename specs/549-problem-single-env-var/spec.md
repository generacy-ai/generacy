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

Split `GENERACY_CLOUD_URL` into three explicit names corresponding to the three actual services:

| Name | Value (staging example) | Purpose |
|---|---|---|
| `GENERACY_API_URL` | `https://api-staging.generacy.ai` | HTTP REST calls (launch-config, device-code, activate, etc.) |
| `GENERACY_APP_URL` | `https://staging.generacy.ai` | User-facing dashboard / browser deep-links |
| `GENERACY_RELAY_URL` | `wss://api-staging.generacy.ai/relay` | Long-lived WebSocket from cluster-relay package |

And make the cloud the source of truth via a structured `cloud` object on `LaunchConfig`:

```ts
LaunchConfig {
  // ...existing fields...
  cloud: {
    apiUrl: string;    // built from PUBLIC_API_URL || PUBLIC_APP_URL on the cloud
    appUrl: string;    // built from PUBLIC_APP_URL on the cloud
    relayUrl: string;  // explicit env var on the cloud, or derived once consistently
  };
  cloudUrl?: string;  // deprecated alias for cloud.appUrl, kept one release for compat
}
```

The launch scaffolder writes all three names into the cluster's `.env`. Readers (orchestrator activation, orchestrator relay, cluster-relay) consume the explicit one. No client-side derivation. No name overload.

## Why this is materially better than today

1. **Single source of truth.** The cloud knows its own URLs (it serves them). Today the launch CLI guesses by env var, the cluster-relay derives `wss://` from `https://` by string-munging, and the orchestrator looks up `GENERACY_CHANNEL` to decide which relay to use. Cloud-as-source-of-truth means everyone gets correct values for free.
2. **No ambiguity at the read site.** `process.env.GENERACY_API_URL` has one meaning. `process.env.GENERACY_CLOUD_URL` has — at minimum — three.
3. **Custom-domain ready.** A self-hosted Generacy install with `api.acme-corp.internal` for the API and `dashboard.acme-corp.internal` for the frontend just sets all three correctly. The current convention assumes URLs are related by string transformation, which breaks under custom domains.
4. **Eliminates the orchestrator's same-name-different-purpose pattern.** The two reads in `loader.ts` lines 245 and 263 become reads of two different env vars.

## Migration plan

Three repos touched, additive first / cleanup last:

**Phase 1: Cloud-side (additive).**
- Add `cloud.apiUrl`, `cloud.appUrl`, `cloud.relayUrl` to `LaunchConfigSchema` and `buildLaunchConfig` ([generacy-cloud/services/api/src/services/launch-config.ts](https://github.com/generacy-ai/generacy-cloud/blob/develop/services/api/src/services/launch-config.ts)). Keep the existing `cloudUrl` field as `cloud.appUrl`'s value so old CLIs keep working.

**Phase 2: Reader-side (additive, deprecation logs).**
- CLI: read `GENERACY_API_URL` first, fall back to `GENERACY_CLOUD_URL` with a one-time `[deprecated] GENERACY_CLOUD_URL is ambiguous, prefer GENERACY_API_URL` log.
- Orchestrator: split the two reads at `loader.ts:245` and `:263` to use `GENERACY_API_URL` and `GENERACY_RELAY_URL` respectively, with the same fallback pattern.
- Cluster-relay package: read `GENERACY_RELAY_URL` first, fall back to `GENERACY_CLOUD_URL`.
- All deprecation logs are debug-level, fired once per process.

**Phase 3: Writer-side.**
- Launch scaffolder ([packages/generacy/src/cli/commands/cluster/scaffolder.ts:99](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/cluster/scaffolder.ts#L99)): write all three names from the new `LaunchConfig.cloud` object. Drop the old `GENERACY_CLOUD_URL` line (or keep it commented as a transition aid).
- Cloud worker template generator ([generacy-cloud/services/worker/src/lib/templates.ts:122](https://github.com/generacy-ai/generacy-cloud/blob/develop/services/worker/src/lib/templates.ts#L122)): emit `GENERACY_RELAY_URL=` instead of `GENERACY_CLOUD_URL=`.
- DigitalOcean cloud-deploy ([generacy-cloud/services/api/src/services/cloud-deploy/digitalocean.ts:84](https://github.com/generacy-ai/generacy-cloud/blob/develop/services/api/src/services/cloud-deploy/digitalocean.ts#L84)): set the right one of the three for what it's actually trying to configure (verify which during plan).
- Cluster-base `.env.template` ([.devcontainer/generacy/.env.template](https://github.com/generacy-ai/cluster-base/blob/develop/.devcontainer/generacy/.env.template)): split the single `GENERACY_CLOUD_URL=wss://...` line into the three new lines.

**Phase 4 (next major release): cleanup.**
- Remove the `GENERACY_CLOUD_URL` fallbacks from all readers.
- Remove the deprecated `LaunchConfig.cloudUrl` top-level field (`LaunchConfig.cloud.appUrl` replaces it).
- Update v1.5 onboarding doc to reference the new names.

## Open questions for clarify phase

- **Q1**: Should the cloud also send a fourth URL for the GitHub OAuth callback (currently spread across `OAUTH_REDIRECT_URI_*` repo variables on the cloud-cloud side)? Out of scope for this issue?
- **Q2**: Is there a use case where `GENERACY_RELAY_URL` legitimately differs from `${GENERACY_API_URL}/relay`? If not, should the cluster-relay package derive it from `GENERACY_API_URL` and skip making it a separate env var? (Recommend: keep it explicit, both because it composes the projectId query param differently and because relays can in principle be hosted on a different domain than the API for scaling reasons.)
- **Q3**: How long should the `GENERACY_CLOUD_URL` deprecation window be? One release feels right given the small population of v1.5 users today, but if there are existing production clusters running older orchestrator builds the window may need to be longer.
- **Q4**: Should the rename also touch the `LaunchConfig.cloudUrl` field name, renaming it to `LaunchConfig.cloud.appUrl` (with `cloudUrl` as a deprecated alias)? Recommend yes — the new name is clearer about which URL it is.
- **Q5**: Test fixtures ([packages/generacy/src/cli/commands/launch/cloud-client.ts](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/launch/cloud-client.ts) STUB_LAUNCH_CONFIG, [generacy-cloud/services/api/src/routes/clusters/__tests__/launch-config.test.ts](https://github.com/generacy-ai/generacy-cloud/blob/develop/services/api/src/routes/clusters/__tests__/launch-config.test.ts)) need updating to include the new `cloud` object. Confirm during plan.

## Related

- generacy#543 — scaffolded compose runtime mismatch. The scaffolder work there will set the relevant env vars in `.env`. If this issue lands first, #543 writes the new names directly. If #543 lands first, this issue has a separate cleanup pass on the scaffolder. Either order works; coordination point is the scaffolder's writer code.
- generacy#545 — `--cloud-url` flag for `generacy launch`. The flag should be renamed `--api-url` once this issue lands, since "cloud URL" is now ambiguous.
- generacy-cloud#518 — "Run on my computer" copy-paste command. Today plans to embed `GENERACY_CLOUD_URL=...` (HTTP API URL). Should be `GENERACY_API_URL=...` once this issue lands, or `--api-url=...` if #545 also lands.
- The v1.5 onboarding doc references "cloud URL" generically in several places — should be audited for clarity once this lands.

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
