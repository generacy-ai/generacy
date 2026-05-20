# Implementation Plan: Extract Orchestrator Types Package

**Feature**: Decouple CLI from orchestrator server dependencies by extracting a minimal types package
**Branch**: `672-background-generacy-ai`
**Status**: Complete

## Summary

The CLI package (`@generacy-ai/generacy`) currently declares `@generacy-ai/orchestrator` as a runtime dependency, pulling in ~50-100 MB of server-side code (Fastify, ioredis, prom-client, etc.) that `generacy launch` never uses. The fix extracts 3 type definitions into a new `@generacy-ai/orchestrator-types` package, moves orchestrator to `devDependencies`, and converts the `generacy orchestrator` subcommand to use dynamic `import()`.

## Technical Context

**Language/Version**: TypeScript 5.x, ESM, Node >=22
**Primary Dependencies**: No runtime deps in types package (types-only). CLI uses `commander`, `pino`, `zod`.
**Build**: `tsc` with `declaration: true`, `module: Node16`
**Testing**: Vitest
**Monorepo**: pnpm workspaces (`packages/*`)
**Target Platform**: npm registry (published via changesets)

## Current State Analysis

### CLI Import Surface (5 files total)

| File | Import Type | Symbols | Category |
|------|------------|---------|----------|
| `src/agency/subprocess.ts` | `import type` | `AgentLauncher` | Production, type-only |
| `src/cli/commands/orchestrator.ts` | runtime | `createServer`, `startServer`, `loadConfig`, `InMemoryApiKeyStore`, `OrchestratorConfig` (type) | Production, runtime |
| `src/agency/__tests__/subprocess.test.ts` | `import type` | `AgentLauncher`, `LaunchHandle` | Test, type-only |
| `src/agency/__tests__/subprocess-snapshot.test.ts` | runtime | `AgentLauncher`, `GenericSubprocessPlugin`, `RecordingProcessFactory`, `normalizeSpawnRecords` | Test, runtime |
| `src/cli/commands/__tests__/orchestrator-repos.test.ts` | runtime (mocked) | `loadConfig`, `createServer`, `startServer`, `InMemoryApiKeyStore` | Test, mocked |

### Key Insight

- **1 production file** needs type-only imports → types package
- **1 production file** needs runtime imports → dynamic `import()`
- **3 test files** need runtime imports → `devDependencies` provides these

## Project Structure

### New Package

```text
packages/orchestrator-types/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts              # Re-exports all types
    ├── launcher-types.ts     # AgentLauncher, LaunchHandle interfaces
    └── config-types.ts       # OrchestratorConfig interface
```

### Modified Files

```text
packages/generacy/
├── package.json                                    # orchestrator → devDependencies, add orchestrator-types
├── src/agency/subprocess.ts                        # import from orchestrator-types
└── src/cli/commands/orchestrator.ts                # dynamic import()

packages/orchestrator/
├── package.json                                    # add orchestrator-types dependency
└── src/index.ts                                    # re-export types from orchestrator-types
```

## Implementation Approach

### Phase 1: Create `@generacy-ai/orchestrator-types` package

1. Create `packages/orchestrator-types/` with minimal package.json (zero runtime deps)
2. Extract type-only definitions for `AgentLauncher`, `LaunchHandle`, `OrchestratorConfig`
3. These will be **interface** declarations (not tied to implementation classes)
4. The `AgentLauncher` type needs only the public surface: `launch(request): Promise<LaunchHandle>` and `registerPlugin(plugin): void`

### Phase 2: Wire orchestrator to re-export from types package

1. Add `@generacy-ai/orchestrator-types` as dependency of orchestrator
2. Orchestrator's `AgentLauncher` class `implements` the interface from types package
3. Re-export the types from orchestrator's index.ts so existing consumers are unaffected

### Phase 3: Update CLI imports

1. `subprocess.ts`: Change `import type { AgentLauncher } from '@generacy-ai/orchestrator'` → `from '@generacy-ai/orchestrator-types'`
2. `orchestrator.ts`: Wrap runtime imports in dynamic `import()` with try/catch and user-friendly error message

### Phase 4: Update CLI package.json

1. Move `@generacy-ai/orchestrator` from `dependencies` to `devDependencies`
2. Add `@generacy-ai/orchestrator-types` to `dependencies`
3. Test files continue working via devDep

### Phase 5: Validation

1. All existing tests pass
2. `generacy launch` works without orchestrator installed
3. `generacy orchestrator` shows clear error message if orchestrator missing
4. Type-check passes across all packages

## Design Decisions

### DD-1: Interface vs. Re-export for AgentLauncher

**Decision**: Define `AgentLauncher` as an **interface** in the types package, not re-export the class.

**Rationale**: The class definition depends on `CredhelperClient`, `ProcessFactory`, and other internal types. Extracting the class would pull in transitive deps. An interface with only the public contract (`launch`, `registerPlugin`) is sufficient for the CLI's type-only usage.

### DD-2: OrchestratorConfig as standalone interface

**Decision**: Define `OrchestratorConfig` as a plain TypeScript interface (not Zod-inferred type).

**Rationale**: The Zod schema imports ~20 sub-schemas. The CLI only uses the type for annotation in `orchestrator.ts`, which will become a dynamic import anyway. A simplified interface covering the fields the CLI actually reads suffices.

### DD-3: Dynamic import error message

**Decision**: On `import()` failure, print instructions to install orchestrator and offer `npx -y @generacy-ai/orchestrator` as a one-liner.

**Rationale**: Per clarification Q1, this is acceptable friction for the ~1% of installs that use `generacy orchestrator`.

### DD-4: No Zod schemas in types package

**Decision**: Types package contains only TypeScript interfaces, no Zod schemas.

**Rationale**: Per clarification Q3, Zod schemas carry a runtime dependency. The minimal approach (3 types) avoids this.

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Nominal type mismatch between types pkg interface and orchestrator class | Orchestrator class `implements` the interface; TypeScript enforces compatibility |
| Breaking existing orchestrator consumers | Orchestrator re-exports types from types package; no import path changes needed for other packages |
| Test breakage from devDep change | `devDependencies` are installed during `pnpm install` in development; only end-user `npx` installs skip them |
| pnpm workspace resolution | Use `workspace:^` protocol consistently |
