# Feature Specification: CLI claude-login and open commands

`generacy claude-login` runs `claude /login` inside the orchestrator container so Claude Max users can authenticate without leaving the CLI

**Branch**: `496-context-generacy-claude-login` | **Date**: 2026-04-29 | **Status**: Draft

## Summary

Two new CLI commands for the `generacy` CLI: `claude-login` authenticates Claude Max users by proxying `claude /login` from the orchestrator container, and `open` launches the cluster's project page on generacy.ai in the user's default browser.

## Context

`generacy claude-login` runs `claude /login` inside the orchestrator container so Claude Max users can authenticate without leaving the CLI. `generacy open` opens the cluster's project page on generacy.ai. Architecture: [docs/dev-cluster-architecture.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/dev-cluster-architecture.md) — "CLI design" and Open-question #3 on Linux browser callback.

## Scope

`packages/generacy/src/cli/commands/claude-login/`:
- Resolves the cluster from cwd via the shared `getClusterContext` helper — walks up from cwd looking for `.generacy/` directory, reads `.generacy/cluster.json` for cluster identity, cross-references `~/.generacy/clusters.json` for registry metadata.
- Spawns `docker compose exec -it orchestrator claude /login` via `child_process.spawn` with `stdio: ['inherit', 'pipe', 'inherit']` — stdin/stderr inherited directly, stdout piped for URL scanning.
- Pipes stdout through to `process.stdout` while scanning for URL patterns (`https?://[^\s]+`, first match wins); auto-opens detected URLs on macOS/Windows via the host's default browser.
- For Linux: prints "Open this URL in your browser:" with the matched URL on a clear line; no automatic opening (per architecture doc Open-question #3).

`packages/generacy/src/cli/commands/open/`:
- Resolves the cluster from cwd or `--cluster <id>` (where `<id>` is the `cluster_id` from activation, same as docker compose project name).
- Looks up `cloudUrl` from `~/.generacy/clusters.json` registry.
- Opens `{cloudUrl}/clusters/{clusterId}` in the user's default browser.

Both commands fail clearly when the cluster isn't running.

## Acceptance criteria

- `claude-login` runs against a running cluster's orchestrator and proxies the prompt+input correctly.
- Linux path prints the URL clearly; macOS/Windows auto-opens it.
- `open` opens the right URL for the cluster in cwd.
- `--cluster <id>` resolves via the host-side registry.
- Both commands give clear errors when the cluster isn't running or no cluster exists in cwd.
- Unit tests for cluster resolution, integration test for `claude-login` against a fake `claude` binary.

## User Stories

### US1: Claude Max Authentication

**As a** Claude Max user,
**I want** to run `generacy claude-login` from my project directory,
**So that** I can authenticate Claude inside the orchestrator container without leaving the CLI.

**Acceptance Criteria**:
- [ ] Command resolves the cluster from cwd via `.generacy/cluster.json`
- [ ] Spawns `docker compose exec -it orchestrator claude /login` with terminal passthrough
- [ ] On macOS/Windows, detected URL is auto-opened in default browser
- [ ] On Linux, URL is printed with clear instructions

### US2: Open Cluster Dashboard

**As a** developer,
**I want** to run `generacy open` from my project directory,
**So that** I can quickly navigate to the cluster's project page on generacy.ai.

**Acceptance Criteria**:
- [ ] Command resolves the cluster from cwd or `--cluster <id>`
- [ ] Opens `{cloudUrl}/clusters/{clusterId}` in default browser
- [ ] Clear error when no cluster found or cluster not running

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `getClusterContext(cwd)` walks up from cwd looking for `.generacy/` directory, reads `.generacy/cluster.json` | P1 | Longest-prefix-match per #493-Q3 |
| FR-002 | `claude-login` spawns `docker compose exec -it orchestrator claude /login` with `child_process.spawn` and `stdio: ['inherit', 'pipe', 'inherit']` | P1 | stdin/stderr inherited, stdout piped for URL scanning |
| FR-003 | `claude-login` pipes stdout to terminal while scanning for URL patterns (`https?://[^\s]+`), auto-opens first match on macOS/Windows | P1 | First match wins; may lose TTY coloring on stdout |
| FR-004 | `claude-login` on Linux prints "Open this URL in your browser:" with the URL | P1 | No automatic browser opening |
| FR-005 | `open` accepts `--cluster <id>` where `<id>` is cluster_id (same as compose project name) | P1 | Looked up via `~/.generacy/clusters.json` |
| FR-006 | `open` reads `cloudUrl` from registry and opens `{cloudUrl}/clusters/{clusterId}` | P1 | |
| FR-007 | Both commands fail with clear errors when cluster isn't running or not found | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `claude-login` proxies interactive session | Works end-to-end | Manual test against running cluster |
| SC-002 | URL auto-open on macOS/Windows | Browser opens on URL detection | Integration test with fake claude binary |
| SC-003 | `open` resolves correct URL | Opens correct cluster page | Unit test for URL construction |

## Assumptions

- Host-side registry `~/.generacy/clusters.json` exists (defined in #494)
- Per-project `.generacy/cluster.json` mirror file is written during cluster setup
- `cluster_id` is used as the docker compose project name (per #494)
- `claude /login` is an interactive-only command that prints a URL to stdout

## Out of Scope

- Tab completion for `--cluster <id>` (future enhancement)
- Non-TTY / CI support for `claude-login` (interactive-only by design)
- Creating a new `packages/cli/` package (commands go in existing `packages/generacy/src/cli/commands/`)

---

*Generated by speckit*
