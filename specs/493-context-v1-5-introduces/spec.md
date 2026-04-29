# Feature Specification: @generacy-ai/cli package skeleton + npm publish pipeline

**Issue**: [#493](https://github.com/generacy-ai/generacy/issues/493) | **Branch**: `493-context-v1-5-introduces` | **Date**: 2026-04-29 | **Status**: Draft

## Summary

Ship the `@generacy-ai/cli` package skeleton at `packages/cli/` with Commander.js subcommand dispatch, a cluster registry helper, structured logging, error handling, and a GitHub Actions publish pipeline. Subcommand implementations land in parallel issues; this issue covers the scaffold and tooling only.

## Context

v1.5 introduces a public npx CLI that drives local cluster lifecycle (`npx generacy launch`, `up`, `stop`, etc.). This issue ships the package skeleton and publishing pipeline; commands themselves land in parallel issues. Architecture: [docs/dev-cluster-architecture.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/dev-cluster-architecture.md) — "CLI design (`generacy`)".

## Scope

New package at `packages/cli/`. Per the maintainer's confirmation, the CLI lives in this repo (not its own).

- `package.json` with bin entry `generacy` -> `dist/index.js`. Name: `@generacy-ai/cli`. Public publish.
- Commander.js entry that dispatches subcommands (registered as empty placeholders for `launch`, `up`, `stop`, `down`, `destroy`, `status`, `update`, `open`, `claude-login`, `deploy`, `rebuild`).
- Node version check: refuse to run on Node < 22 with a clear install link.
- `~/.generacy/clusters.json` registry helper module: `loadRegistry()`, `saveRegistry()`, `addCluster()`, `removeCluster()`, `findClusterByCwd()`. Atomic write. Schema is `{version, clusters: [{id, name, path, cloudUrl, lastSeen}]}`.
- Pino logger with sane defaults; quiet mode flag.
- Global error handler that prints user-friendly errors (no stack traces unless `DEBUG=1`).

Publishing:
- GitHub Actions workflow at `.github/workflows/publish-cli.yml` triggered by tags matching `cli-v*` (or match prevailing convention).
- Publishes to npm as `@generacy-ai/cli`.
- Initial preview tag from this issue: `cli-v0.1.0-preview.1`.

## User Stories

### US1: Developer installs and runs the CLI

**As a** developer setting up a Generacy cluster,
**I want** to run `npx @generacy-ai/cli --help` and see all available subcommands,
**So that** I can discover the cluster lifecycle operations available to me.

**Acceptance Criteria**:
- [ ] `npx @generacy-ai/cli@<preview-tag> --version` prints the version
- [ ] `npx @generacy-ai/cli@<preview-tag> --help` lists all subcommands as placeholders

### US2: Developer gets a clear error on unsupported Node

**As a** developer on an older Node version,
**I want** the CLI to refuse to run on Node < 22 with a helpful error message,
**So that** I know immediately to upgrade rather than encountering cryptic failures.

**Acceptance Criteria**:
- [ ] Running on Node 20 exits with a clear message and install link
- [ ] Running on Node 22+ proceeds normally

### US3: CLI tracks cluster instances locally

**As a** developer managing multiple clusters,
**I want** the CLI to maintain a local registry at `~/.generacy/clusters.json`,
**So that** commands can auto-detect which cluster to target based on my working directory.

**Acceptance Criteria**:
- [ ] `loadRegistry()` / `saveRegistry()` round-trip without data loss
- [ ] `addCluster()` / `removeCluster()` modify the registry correctly
- [ ] `findClusterByCwd()` resolves the correct cluster for a given path
- [ ] Atomic write: simulated mid-write crash leaves the previous file intact

### US4: Package is published to npm

**As a** maintainer,
**I want** tagging `cli-v*` to trigger an automated npm publish,
**So that** users can install the CLI without building from source.

**Acceptance Criteria**:
- [ ] Publish workflow runs on `cli-v*` tags
- [ ] Package is pullable from npm after publish

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `packages/cli/package.json` with `bin.generacy` -> `dist/index.js`, name `@generacy-ai/cli` | P1 | Public publish |
| FR-002 | Commander.js entry dispatching 11 placeholder subcommands | P1 | launch, up, stop, down, destroy, status, update, open, claude-login, deploy, rebuild |
| FR-003 | Node version gate: exit on Node < 22 with install link | P1 | Check `process.versions.node` at startup |
| FR-004 | Cluster registry helper at `~/.generacy/clusters.json` | P1 | Atomic write via tmp+rename |
| FR-005 | Registry schema: `{version, clusters: [{id, name, path, cloudUrl, lastSeen}]}` | P1 | Zod validation |
| FR-006 | Pino logger with quiet mode (`-q` / `--quiet`) | P2 | |
| FR-007 | Global error handler: user-friendly messages, stack traces only when `DEBUG=1` | P2 | |
| FR-008 | GitHub Actions workflow `.github/workflows/publish-cli.yml` on `cli-v*` tags | P1 | Match prevailing publish conventions |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `--version` output | Prints correct semver | Manual run |
| SC-002 | `--help` subcommand listing | All 11 subcommands visible | Manual run |
| SC-003 | Node < 22 rejection | Exit code 1, clear message | Test on Node 20 |
| SC-004 | Registry round-trip | Zero data loss | Unit tests |
| SC-005 | Atomic write safety | Previous file survives simulated crash | Unit test |
| SC-006 | npm publish | Package installable from registry | Post-publish smoke test |

## Assumptions

- The monorepo tooling (pnpm workspaces) supports adding `packages/cli/` without build pipeline changes.
- Commander.js is an acceptable CLI framework (consistent with Node ecosystem norms).
- Node 22 is the minimum supported version for v1.5 CLI consumers.
- `~/.generacy/` is an acceptable config directory (no XDG override needed for v1).

## Out of Scope

- Actual subcommand implementations (land in parallel issues).
- Docker/container orchestration logic.
- Cloud API authentication flows.
- XDG base directory support.
- Windows-specific path handling.

---

*Generated by speckit*
