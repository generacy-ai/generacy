# Feature Specification: Post-Activation Wizard Credentials Surfacing

**Branch**: `589-symptoms-after-bootstrap` | **Date**: 2026-05-12 | **Status**: Draft

## Summary

After the bootstrap wizard completes and credentials (GitHub App token, Anthropic API key) are stored in the cluster-local credstore, the post-activation script fails because those credentials are never exported as environment variables. The `setup-credentials.sh` script expects `GH_TOKEN` in the process environment but nothing bridges the sealed credstore to bash.

The fix (Option A) has the control-plane's `bootstrap-complete` handler unseal stored credentials and write a transient `.env` file before triggering the post-activation sentinel. The cluster-base post-activation script sources this file, then deletes it after consumption.

## Symptoms

```
[setup-credentials] WARNING: GH_TOKEN not set - git operations requiring auth will fail
[post-activation] Cloning project repo: christrudelpw/onboarding-test-4 (branch: main)
fatal: ...
post-activation exited 128
```

## Root Cause

The bootstrap wizard credential flow stores secrets in encrypted `credentials.dat` via `ClusterLocalBackend`, but nothing in the `bootstrap-complete` -> post-activation pipeline exports those secrets as env vars. The bash scripts (`setup-credentials.sh`, `entrypoint-post-activation.sh`) cannot access the credhelper-daemon's session-based API.

## User Stories

### US1: First-time cluster bootstrap succeeds end-to-end

**As a** developer onboarding via the bootstrap wizard,
**I want** the credentials I provide in the wizard to be available to the post-activation setup scripts,
**So that** the project repo clone and workspace setup complete automatically without manual intervention.

**Acceptance Criteria**:
- [ ] After wizard completion, `git clone` of the project repo succeeds using the wizard-provided GitHub token
- [ ] No manual `docker exec` or env var injection is required
- [ ] The transient credentials file is deleted after consumption (no plaintext secrets persist on disk)

### US2: Idempotent re-start does not leak stale credentials

**As a** developer restarting a previously-bootstrapped cluster,
**I want** the post-activation flow to be a no-op on subsequent starts,
**So that** no stale or outdated credential files accumulate.

**Acceptance Criteria**:
- [ ] On second container start (post-activation already ran), no wizard-credentials.env file is written or remains
- [ ] The post-activation watcher recognizes the cluster is already set up and skips credential surfacing

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `bootstrap-complete` handler unseals all stored credentials from `ClusterLocalBackend` before writing the sentinel file | P1 | Control-plane package |
| FR-002 | Unsealed credentials written to `/var/lib/generacy/wizard-credentials.env` (mode 0600, uid node) as `KEY=value` pairs | P1 | Transient env file |
| FR-003 | Credential type mapping: `github-app` -> `GH_TOKEN`, `api-key` (anthropic) -> `ANTHROPIC_API_KEY` | P1 | Extensible mapping table |
| FR-004 | `entrypoint-post-activation.sh` sources `wizard-credentials.env` before calling `setup-credentials.sh` | P1 | cluster-base repo change |
| FR-005 | `wizard-credentials.env` is deleted after successful consumption (first read) | P2 | Defense in depth |
| FR-006 | If no credentials exist in the credstore at bootstrap-complete time, the handler still succeeds (empty env file or no file) | P1 | Graceful degradation |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Post-activation `git clone` succeeds after wizard | 100% of wizard-complete flows | Manual E2E test on live cluster |
| SC-002 | No plaintext credential files persist after post-activation completes | 0 files at `/var/lib/generacy/wizard-credentials.env` after setup | `ls` / `stat` check post-setup |
| SC-003 | `bootstrap-complete` handler latency increase | < 100ms | Unseal is a local AES-256-GCM decrypt, should be sub-ms |

## Assumptions

- `ClusterLocalBackend` is initialized and contains the wizard-written credentials by the time `bootstrap-complete` fires (steps 2-3 complete before step 4)
- The post-activation scripts in cluster-base can be modified (separate PR to `generacy-ai/cluster-base`)
- `/var/lib/generacy/` directory exists and is writable by the node user (already true for `credentials.dat` and `master.key`)
- Only Option A (transient env file) is in scope for this issue; Option B (CLI subcommand) is a follow-up

## Out of Scope

- `generacy credentials get` CLI subcommand (Option B) — follow-up issue
- `REPO_URL` normalization (`owner/repo` -> full HTTPS URL) — separate issue
- Cache coherence for credhelper-daemon after bootstrap-complete credential writes
- cluster-base `entrypoint-post-activation.sh` changes (tracked in cluster-base repo, referenced here for context)

## Cross-Repo Dependencies

| Repo | Change | Blocking? |
|------|--------|-----------|
| `generacy` (this repo) | Control-plane `bootstrap-complete` handler writes env file | Yes |
| `generacy-ai/cluster-base` | `entrypoint-post-activation.sh` sources env file, deletes after use | Yes (separate PR) |

## Related

- generacy-ai/cluster-base#26 (vscode-cli volume — adjacent wizard-credential seam)
- generacy-ai/generacy-cloud (to be filed) — `REPO_URL` sent as `owner/repo` shorthand
- #572 (cluster <-> cloud contract consolidation)
- #558 (credential persistence in control-plane — the write side of this flow)
- #562 (bootstrap-complete lifecycle action — the trigger)

---

*Generated by speckit*
