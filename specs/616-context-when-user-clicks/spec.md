# Feature Specification: ## Context

When a user clicks "+ Add Cluster" inside a project on the cloud dashboard, the generated `npx generacy launch --claim=…` command kicks off a fresh activation

**Branch**: `616-context-when-user-clicks` | **Date**: 2026-05-14 | **Status**: Draft

## Summary

## Context

When a user clicks "+ Add Cluster" inside a project on the cloud dashboard, the generated `npx generacy launch --claim=…` command kicks off a fresh activation. The CLI fetches `launch-config?claim=…` from the cloud — which already includes `projectId` — then scaffolds and starts the cluster. The orchestrator runs the device-code flow and prints something like:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Cluster Activation Required

  Go to: https://staging.generacy.ai/cluster-activate
  Enter code: ABCD-1234

  Code expires in 10 minutes.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

The URL is bare. When the user opens it, the cluster-activate page asks them to pick a project — even though the project was known three system boundaries ago. The companion `generacy-ai/generacy-cloud` issue updates the cluster-activate page to honor a `?projectId=` query param and skip the dropdown. This issue covers the cluster-side changes so the URL the orchestrator emits actually carries that param.

## Proposed change

### 1. CLI scaffolder writes `GENERACY_PROJECT_ID` into `.generacy/.env`

[`packages/generacy/src/cli/commands/launch/scaffolder.ts`](packages/generacy/src/cli/commands/launch/scaffolder.ts): when scaffolding the project directory, write `GENERACY_PROJECT_ID=${config.projectId}` to `.generacy/.env`. The compose file already bind-mounts this `.env` into the orchestrator container, so the var is available as `process.env.GENERACY_PROJECT_ID` at orchestrator startup. The CLI already has `config.projectId` from the launch-config response, no schema change needed.

### 2. Orchestrator threads `projectId` through to the printed activation URL

[`packages/orchestrator/src/activation/index.ts:50-66`](packages/orchestrator/src/activation/index.ts#L50-L66): after the cloud returns the `deviceCode` response, construct the user-facing URL by combining `verification_uri` + `user_code` + `projectId`:

```ts
const projectId = process.env.GENERACY_PROJECT_ID;
const url = new URL(deviceCode.verification_uri);
url.searchParams.set('code', deviceCode.user_code);
if (projectId) url.searchParams.set('projectId', projectId);
const activationUrl = url.toString();

logger.info(
  `\n` +
  `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
  `  Cluster Activation Required\n` +
  `\n` +
  `  Go to: ${activationUrl}\n` +
  `  Enter code: ${deviceCode.user_code}\n` +
  `\n` +
  `  Code expires in ${Math.floor(deviceCode.expires_in / 60)} minutes.\n` +
  `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
);
```

When `GENERACY_PROJECT_ID` is unset (e.g., cluster started directly via `docker compose up` outside the `npx launch` flow), `projectId` is undefined and the URL just gets `?code=…` — graceful fallback to the existing two-step flow.

### 3. CLI log-scraper detection still works

[`packages/generacy/src/cli/commands/launch/compose.ts`](packages/generacy/src/cli/commands/launch/compose.ts)'s `streamLogsUntilActivation` parses the orchestrator's log to extract `verificationUri` + `userCode`. With this change the `Go to:` line now contains a full URL with both params; the parser should pull that whole URL and use it directly for the `openBrowser(activationUrl)` call rather than rebuilding. Otherwise the user opens a URL without the `projectId` param even though the cluster emitted one.

Minor: rename `activationUrl: string; userCode: string;` if the structure changes to a single URL. The browser-open step just needs *some* URL.

## Out of scope

- Cluster-activate page-side changes (companion issue in `generacy-ai/generacy-cloud`).
- `--claim`-as-force-reactivate-signal behavior (already covered by #614 / FR-005 — that PR's CLI changes are a natural place to bundle this scaffolder tweak if they ship together).

## Security note

The `projectId` query param is an identifier, not a credential. The cloud's existing `/api/clusters/activate` endpoint authorizes by user-owns-project. So all this changes is pre-fill behavior; if the cluster somehow emits a stale or wrong projectId, the activation call would 403 — same as if a malicious link supplied a projectId directly.

## Test plan

- [ ] `npx generacy launch --claim=<valid>` → `.generacy/.env` contains `GENERACY_PROJECT_ID=<projectId>`.
- [ ] Cluster boots, orchestrator prints `Go to: …/cluster-activate?code=…&projectId=…` (both params present).
- [ ] CLI's `streamLogsUntilActivation` picks up the new URL form and `openBrowser` opens it as-is (browser tab opens the cluster-activate page with both params populated).
- [ ] When `GENERACY_PROJECT_ID` is unset (e.g., manual `docker compose up` without the `.generacy/.env` shim), the URL just gets `?code=…` — current behavior preserved.
- [ ] Unit test for the URL construction: validate `URL.searchParams.set('code', …)` round-trips correctly when the cloud's `verification_uri` already has a trailing slash or fragment.

## Independence

The cloud-side change (the cluster-activate page reading `?projectId=`) is independent and safe to ship first — the page just ignores the param until cluster-side starts emitting it. So this issue and its cloud counterpart can ship in either order, but the user-visible win lands only when both have shipped.

## Related

- Companion: `generacy-ai/generacy-cloud` issue for cluster-activate page changes (accept `?projectId=`, pre-select + lock).
- #614 (cluster-side activation force-reactivate signal — natural bundle if they land together).
- `generacy-ai/generacy-cloud#553` (Add Cluster within project — the UX that surfaces this gap).

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
