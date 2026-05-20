# Feature Specification: ## Background

`@generacy-ai/generacy` (the CLI users run via `npx`) declares `@generacy-ai/orchestrator` as a runtime dependency

**Branch**: `672-background-generacy-ai` | **Date**: 2026-05-20 | **Status**: Draft

## Design Decision

**Option A selected**: Extract a minimal `@generacy-ai/orchestrator-types` package containing only `AgentLauncher`, `LaunchHandle`, and `OrchestratorConfig` type definitions. Remove `@generacy-ai/orchestrator` from CLI `dependencies`. The `generacy orchestrator` subcommand will use a dynamic `import()` with a clear error message if orchestrator is not installed. `@generacy-ai/orchestrator` moves to `devDependencies` for test usage.

Key rationale:
- `optionalDependencies` and `peerDependencies` are still installed by default (npm 7+), so they don't reduce install size
- ~99% of installs are `generacy launch` (needs only types), ~1% are `generacy orchestrator` (needs full server)
- Orchestrator should re-export its types from the types package to maintain nominal type alignment

## Summary

## Background

`@generacy-ai/generacy` (the CLI users run via `npx`) declares `@generacy-ai/orchestrator` as a runtime dependency. Orchestrator's published `dependencies` include the full Fastify server stack:

```
@fastify/cors, @fastify/helmet, @fastify/jwt, @fastify/oauth2, @fastify/rate-limit,
fastify, ioredis, prom-client
```

When a user runs `npx -y @generacy-ai/generacy@stable launch --claim=...`, npm installs ~50–100 MB of server-side code that the launch flow never executes. The actual host-side use cases for orchestrator code are partial:

- The CLI's `generacy orchestrator` subcommand ([generacy/packages/generacy/src/cli/commands/orchestrator.ts:15](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/orchestrator.ts#L15)) imports `loadConfig, createServer` and DOES start the Fastify server on the host — this scenario justifies the heavy deps.
- The CLI's `generacy launch` flow (the common onboarding path) imports only a TYPE (`AgentLauncher`) at [generacy/packages/generacy/src/agency/subprocess.ts:7](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/agency/subprocess.ts#L7).

So today every `npx generacy launch` user pays the orchestrator install cost for one type import.

## What needs investigating

Per @christrudelpw: \"in some scenarios the cli is run on a host machine, not having an orchestrator instance to call. Perhaps whatever is needed might be better split out into a shared package? I think it will require more investigation.\"

Questions worth answering before designing a fix:

1. **Which subcommands actually need orchestrator runtime code?**
   - `generacy orchestrator` — yes, full server (Fastify + everything)
   - `generacy launch` — only types
   - `generacy worker`, `generacy agent` — current source mentions they're \"replaced by internal WorkerDispatcher in @generacy-ai/orchestrator\" — need to confirm whether they still call into orchestrator at runtime
   - Other subcommands?

2. **Where does the host-side `generacy orchestrator` server fit in the cluster-vs-host story?**
   - Is it expected to be a long-term supported deployment shape, or a dev/staging convenience?
   - If long-term, the heavy deps are fine — they're paying for a real feature.
   - If transitional, splitting out a thin client package is probably the right move.

3. **What's the smallest shared surface between CLI and orchestrator server?**
   - The types (`AgentLauncher`, `LaunchHandle`, etc.) are obvious candidates.
   - The schemas / config types (zod validators?) likely too.
   - These could go into a new `@generacy-ai/orchestrator-types` (or `-client`) package that both the CLI and the orchestrator server depend on.

4. **Tradeoff vs. existing structure.** The current split (`activation-client`, `config`, etc.) already separates some concerns. Whether orchestrator needs further splitting depends on whether the answer to (1) is \"CLI only uses types\" or \"CLI uses some runtime helpers too.\"

## Suggested next step

Spike: produce a dependency report of every symbol the CLI imports from `@generacy-ai/orchestrator` across all subcommands (not just `launch`), classify each as type-only / runtime, and use that to decide whether a `-types` package extraction is worth it or whether the right fix is conditional / dynamic imports inside the CLI so the heavy deps only load when `generacy orchestrator` is invoked.

(Dynamic imports won't reduce the npm install size since npm doesn't know about runtime branching — only a package extraction does that.)

## Related

- generacy-ai/generacy#669 — workspace:^ leak. Adjacent but independent. That bug must be fixed first; this issue is the structural followup.
- generacy-ai/generacy-cloud#518 — original v1.5 onboarding copy-paste issue.

## User Stories

### US1: Fast CLI Onboarding

**As a** new user running `npx generacy launch`,
**I want** the CLI to install quickly without unnecessary server-side dependencies,
**So that** my onboarding experience is fast and I only download code that's actually used.

**Acceptance Criteria**:
- [ ] `npx -y @generacy-ai/generacy@stable launch --claim=...` does not install Fastify, ioredis, prom-client, or other orchestrator server deps
- [ ] `generacy launch` continues to work identically to current behavior
- [ ] `generacy orchestrator` provides a clear error message with install instructions if orchestrator package is missing

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Create `@generacy-ai/orchestrator-types` package with `AgentLauncher`, `LaunchHandle`, `OrchestratorConfig` type exports | P1 | Types-only, no runtime deps |
| FR-002 | Update CLI production imports to use `@generacy-ai/orchestrator-types` instead of `@generacy-ai/orchestrator` for type-only imports | P1 | `subprocess.ts`, etc. |
| FR-003 | Remove `@generacy-ai/orchestrator` from CLI `dependencies` | P1 | Core goal |
| FR-004 | Add `@generacy-ai/orchestrator` as `devDependency` of CLI package | P1 | For tests |
| FR-005 | Add dynamic `import()` in `generacy orchestrator` subcommand with clear error if orchestrator not installed | P1 | User-friendly fallback message |
| FR-006 | Orchestrator package re-exports its types from `@generacy-ai/orchestrator-types` | P2 | Maintains nominal type alignment |
| FR-007 | Update test imports to reference correct package paths | P1 | Tests keep runtime imports via devDep |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Install size of `npx generacy launch` | Reduce by ~50-100 MB | Compare `du -sh node_modules` before/after |
| SC-002 | All existing tests pass | 100% | CI green |
| SC-003 | `generacy launch` works unchanged | No regression | Manual test |
| SC-004 | `generacy orchestrator` error message | Clear install instructions | Manual test |

## Assumptions

- #669 (workspace:^ leak) is fixed before this work begins
- The types package will contain no Zod schemas or runtime code
- The `generacy orchestrator` subcommand is a dev/power-user scenario (~1% of installs)

## Out of Scope

- Comprehensive extraction of all orchestrator types (expand later as needed)
- Auto-install via `npx -y @generacy-ai/orchestrator` fallback (consider in plan phase)
- Changes to orchestrator's internal structure beyond re-exporting types

---

*Generated by speckit*
