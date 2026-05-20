# Feature Specification: Split orchestrator into server vs client packages to slim CLI install

**Branch**: `672-background-generacy-ai` | **Date**: 2026-05-20 | **Status**: Draft

## Summary

The `@generacy-ai/generacy` CLI package declares `@generacy-ai/orchestrator` as a runtime dependency, pulling ~50-100 MB of server-side code (Fastify, ioredis, dockerode, gRPC, prom-client, etc.) on every `npx generacy launch`. Investigation shows only 2 production files import from orchestrator, and the primary onboarding command (`generacy launch`) doesn't use orchestrator at all. The fix is to extract the shared surface into a lightweight types/client package and make the full orchestrator an optional or dynamic dependency.

## Background

`@generacy-ai/orchestrator` bundles the complete Fastify server stack plus 7 workspace dependencies (cluster-relay, control-plane, credhelper, workflow-engine, etc.). When declared as a `dependency` in the CLI's `package.json`, npm must install the entire tree regardless of which subcommand the user runs.

### Investigation Findings

**Production imports from CLI into orchestrator (2 files only):**

| File | Symbols | Classification | Subcommand |
|------|---------|---------------|------------|
| `src/cli/commands/orchestrator.ts:9-15` | `createServer`, `startServer`, `loadConfig`, `InMemoryApiKeyStore`, `OrchestratorConfig` | **Runtime** — full server startup | `generacy orchestrator` |
| `src/agency/subprocess.ts:7` | `AgentLauncher` | **Type-only** — `import type`, optional constructor param with fallback | Agency subsystem (indirect) |

**Subcommands that do NOT import orchestrator:** `launch`, `deploy`, `up`, `down`, `stop`, `status`, `destroy`, `update`, `init`, `validate`, `claude-login`, `open`, `doctor`, `setup`.

**Orchestrator's heavy transitive deps:** Fastify + 5 plugins, ioredis, prom-client, dockerode (via plugin-claude-code), gRPC/protobuf, yaml, zod, plus 7 internal workspace packages.

## User Stories

### US1: Fast CLI onboarding for new users

**As a** developer running `npx generacy launch` for the first time,
**I want** the CLI to install quickly without pulling unnecessary server-side dependencies,
**So that** my onboarding experience is fast and I'm not waiting for ~100 MB of code I'll never execute.

**Acceptance Criteria**:
- [ ] `npx -y @generacy-ai/generacy@stable launch --claim=...` does not install Fastify, ioredis, dockerode, or prom-client
- [ ] Install size for the `launch` path is reduced by at least 50% compared to current
- [ ] The `launch` command functions identically to today

### US2: Full orchestrator server on host

**As a** developer running `generacy orchestrator` locally (dev/staging),
**I want** the full Fastify server stack to be available when I need it,
**So that** I can run the orchestrator on my host machine without Docker.

**Acceptance Criteria**:
- [ ] `generacy orchestrator` continues to start the Fastify server with all plugins
- [ ] The heavy dependencies are only installed when the user explicitly needs the orchestrator server
- [ ] No behavioral regression in orchestrator startup, config loading, or API key store

### US3: Type-safe agency subsystem

**As a** developer using the `SubprocessAgency` class,
**I want** access to the `AgentLauncher` type without pulling in the full orchestrator,
**So that** the type-only import doesn't bloat the dependency tree.

**Acceptance Criteria**:
- [ ] `AgentLauncher` and related types are importable from a lightweight package
- [ ] `subprocess.ts` no longer imports from `@generacy-ai/orchestrator`
- [ ] Existing tests pass without modification (or with minimal import path changes)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Extract shared types (`AgentLauncher`, `LaunchHandle`, `OrchestratorConfig`, etc.) into a new lightweight package (e.g., `@generacy-ai/orchestrator-types` or `@generacy-ai/orchestrator-client`) | P1 | Zero heavy deps — only zod + TypeScript types |
| FR-002 | Update `subprocess.ts` to import `AgentLauncher` from the new types package | P1 | Currently `import type` — should be straightforward |
| FR-003 | Move `@generacy-ai/orchestrator` from CLI's `dependencies` to either `optionalDependencies` or remove entirely | P1 | Core goal: don't install on `npx generacy launch` |
| FR-004 | Convert `orchestrator.ts` command to use dynamic `import()` for the full orchestrator package | P2 | Ensures the heavy deps only load when `generacy orchestrator` is invoked; combined with FR-003, keeps install slim |
| FR-005 | Extract `loadConfig` and config schemas if they're needed by both CLI and orchestrator | P2 | Check if `loadConfig` is used outside `orchestrator.ts`; if not, no extraction needed |
| FR-006 | Ensure `InMemoryApiKeyStore` is available via dynamic import or the types package as appropriate | P2 | It's a class (runtime), so it stays in the orchestrator package and loads dynamically |
| FR-007 | Update test imports (`subprocess.test.ts`, `subprocess-snapshot.test.ts`, `orchestrator-repos.test.ts`) to reference new package paths | P1 | Tests use both type-only and runtime imports from orchestrator |

## Design Options

### Option A: Types package + dynamic import (Recommended)

1. Create `@generacy-ai/orchestrator-types` with shared types and lightweight schemas
2. CLI depends on `-types` (tiny); does NOT depend on `@generacy-ai/orchestrator`
3. `orchestrator.ts` uses `const { createServer, startServer, loadConfig, InMemoryApiKeyStore } = await import('@generacy-ai/orchestrator')` with a clear error message if the package isn't installed
4. User must `pnpm add @generacy-ai/orchestrator` explicitly if they want the `generacy orchestrator` command

**Pros:** Cleanest separation, smallest install for common paths.
**Cons:** `generacy orchestrator` requires an extra install step (acceptable — it's a niche dev command).

### Option B: Optional dependency + dynamic import

1. Keep `@generacy-ai/orchestrator` as `optionalDependencies` in CLI
2. Dynamic import in `orchestrator.ts` with graceful fallback
3. Move type imports to the types package

**Pros:** npm may still install it by default (less breakage).
**Cons:** `optionalDependencies` behavior varies across package managers; may still install the heavy deps.

### Option C: Conditional peer dependency

1. Declare `@generacy-ai/orchestrator` as `peerDependencies` with `"optional": true`
2. Same dynamic import pattern

**Pros:** Clear signal that it's optional.
**Cons:** pnpm strict mode may warn; npm 7+ installs peers by default.

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Install size of `npx generacy launch` path | < 50% of current | `du -sh node_modules` before/after or `npm pack --dry-run` size comparison |
| SC-002 | Zero `@generacy-ai/orchestrator` references in CLI `dependencies` | 0 | `grep orchestrator packages/generacy/package.json` in dependencies block |
| SC-003 | `generacy launch --claim=...` works without orchestrator installed | Pass | E2E test or manual verification |
| SC-004 | `generacy orchestrator` works when orchestrator is installed | Pass | Existing test suite + manual verification |
| SC-005 | No type errors in `subprocess.ts` or other consuming code | 0 errors | `pnpm tsc --noEmit` across workspace |
| SC-006 | All existing tests pass | 100% | `pnpm test` in generacy and orchestrator packages |

## Assumptions

- The `generacy orchestrator` host-side server command is a dev/staging convenience, not the primary user path
- `#669` (workspace:^ leak) is fixed before or independently of this work
- The types package will have minimal maintenance overhead (types are already stable)
- Dynamic `import()` is acceptable for ESM packages targeting Node >= 22

## Out of Scope

- Refactoring orchestrator's internal architecture or reducing its own dependency count
- Splitting other heavy packages (e.g., workflow-engine, cluster-relay) — those are consumed container-side
- Cloud-side changes
- CLI install size optimization beyond orchestrator removal (e.g., tree-shaking, bundling)

## Dependencies

- **#669** — workspace:^ leak must be fixed first (adjacent but independent)
- **generacy-cloud#518** — original v1.5 onboarding issue (context only)

---

*Generated by speckit*
