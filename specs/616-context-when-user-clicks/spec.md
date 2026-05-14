# Feature Specification: Thread projectId into activation URL

**Branch**: `616-context-when-user-clicks` | **Issue**: [#616](https://github.com/generacy-ai/generacy/issues/616) | **Date**: 2026-05-14 | **Status**: Draft

## Summary

When a user clicks "+ Add Cluster" inside a project, the CLI already knows the `projectId` from the launch-config response, but the orchestrator's printed activation URL (`Go to: …/cluster-activate`) omits it. The user lands on the cluster-activate page and must re-select the project manually. This feature threads `projectId` through to a `?projectId=` query param on the activation URL so the cloud-side page can pre-select and lock the project dropdown.

## Context

The `projectId` is known at three system boundaries before the user sees the activation URL:
1. Cloud sets it in the launch-config response
2. CLI scaffolder writes it to `.generacy/.env` as `GENERACY_PROJECT_ID` (already done — `scaffolder.ts:284`)
3. Compose mounts `.env` into the orchestrator container

But the orchestrator's `activate()` function (`activation/index.ts:56-66`) prints the raw `verification_uri` from the cloud without appending any query params. The CLI's log scraper (`compose.ts`) then extracts `verificationUri` and `userCode` separately and could reconstruct a URL, but currently passes the bare URI to `openBrowser`.

## User Stories

### US1: Seamless project context during activation

**As a** developer adding a cluster to an existing project,
**I want** the activation URL to carry my project context,
**So that** the cluster-activate page pre-selects my project and I don't have to pick it from a dropdown.

**Acceptance Criteria**:
- [ ] When `GENERACY_PROJECT_ID` is set, the activation URL includes `?code=…&projectId=…`
- [ ] When `GENERACY_PROJECT_ID` is unset, the URL just has `?code=…` (graceful fallback)
- [ ] CLI opens browser with the full parameterized URL

### US2: Manual docker compose users unaffected

**As a** developer running `docker compose up` directly (not via `npx generacy launch`),
**I want** activation to work as before,
**So that** the absence of `GENERACY_PROJECT_ID` doesn't break my flow.

**Acceptance Criteria**:
- [ ] No `projectId` param when env var is absent — current behavior preserved
- [ ] No errors or warnings about missing `GENERACY_PROJECT_ID`

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Orchestrator reads `GENERACY_PROJECT_ID` env var and appends `projectId` query param to the activation URL alongside `code` | P1 | `activation/index.ts:50-66` |
| FR-002 | Use `URL` API to construct the activation URL with both `code` and `projectId` params from `verification_uri` | P1 | Handles edge cases (trailing slashes, existing params) |
| FR-003 | CLI log scraper extracts the full parameterized URL from "Go to:" line and passes it directly to `openBrowser` | P1 | `compose.ts` — existing regex already captures the full URL |
| FR-004 | Graceful fallback: when `GENERACY_PROJECT_ID` is unset, URL gets only `?code=…` | P1 | No breaking change for non-launch flows |

## Analysis of Existing Code

### Already done (no changes needed)
- **`scaffolder.ts:284`**: `scaffoldEnvFile()` already writes `GENERACY_PROJECT_ID=${input.projectId}` to `.generacy/.env`
- **`compose.ts:64`**: `VERIFICATION_URI_RE` regex (`/Go to:\s+(https?:\/\/[^\s\\"']+)/`) already captures the full URL including query params — no regex change needed

### Needs modification
- **`activation/index.ts:56-66`**: Replace bare `${deviceCode.verification_uri}` with URL-constructed string that includes `code` and optional `projectId` params
- **`compose.ts:88`**: Return type and caller may need adjustment — the extracted `verificationUri` will now contain `?code=…&projectId=…`, so callers should use it directly rather than rebuilding a URL

## Security Note

`projectId` is an identifier, not a credential. The cloud's `/api/clusters/activate` endpoint authorizes by user-owns-project. A stale/wrong `projectId` results in 403 — same as a manually crafted URL.

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Activation URL includes `projectId` param when env var is set | 100% of launch flows | Manual test: `npx generacy launch --claim=…` |
| SC-002 | Activation URL omits `projectId` param when env var is unset | 100% of direct compose flows | Manual test: `docker compose up` without `.env` |
| SC-003 | CLI opens browser with full parameterized URL | First browser tab has both params | Observe browser URL bar |

## Test Plan

- [ ] `npx generacy launch --claim=<valid>` → `.generacy/.env` contains `GENERACY_PROJECT_ID=<projectId>` (already true)
- [ ] Cluster boots, orchestrator prints `Go to: …/cluster-activate?code=…&projectId=…`
- [ ] CLI's `streamLogsUntilActivation` extracts the full URL and `openBrowser` opens it as-is
- [ ] When `GENERACY_PROJECT_ID` is unset, URL just gets `?code=…` — current behavior preserved
- [ ] Unit test: URL construction round-trips correctly when `verification_uri` has trailing slash or existing query params

## Out of Scope

- Cloud-side cluster-activate page changes (companion issue in `generacy-ai/generacy-cloud`)
- `--claim`-as-force-reactivate-signal (covered by #614)
- Schema changes to `LaunchConfig` or device-code response

## Assumptions

- The compose file's `env_file` directive mounts `.generacy/.env` into the orchestrator container (confirmed in `scaffoldDockerCompose`)
- The cloud's `verification_uri` response is a valid URL parseable by `new URL()`
- The CLI log scraper regex already captures URL query params (confirmed)

## Related

- Companion: `generacy-ai/generacy-cloud` issue for cluster-activate page changes (accept `?projectId=`, pre-select + lock)
- #614 (cluster-side activation force-reactivate signal)
- `generacy-ai/generacy-cloud#553` (Add Cluster within project UX)

---

*Generated by speckit*
