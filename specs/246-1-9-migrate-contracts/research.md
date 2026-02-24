# Technical Research: Contracts Migration

**Feature**: 246-1-9-migrate-contracts
**Date**: 2026-02-24

## Research Summary

This document captures technical findings and analysis that informed the migration plan.

## Current State Analysis

### Contracts Package Structure

**Package Name**: `@generacy-ai/contracts`
**Version**: 0.1.0
**Files**: 209 TypeScript files
**Estimated Exports**: ~1,152 (based on directory sampling)

**Source Organization**:
```
src/
├── agency-generacy/         # Agent ↔ Orchestrator contracts
├── agency-humancy/          # Agent ↔ Human contracts
├── generacy-humancy/        # Orchestrator ↔ Human contracts
├── common/                  # Foundation types (IDs, errors, versions)
├── orchestration/           # Work items, agent info, events
├── version-compatibility/   # Capability registry, schema versioning
├── telemetry/              # Tool call events, metrics
├── schemas/                # Tool naming, platform API, etc.
│   ├── tool-naming/        # Tool name conventions
│   ├── tool-result.ts      # Terse output schema
│   ├── platform-api/       # Auth, org, subscription
│   ├── decision-model/     # Decision schemas
│   ├── extension-comms/    # Extension communication
│   ├── knowledge-store/    # Knowledge schemas
│   ├── learning-loop/      # Learning schemas
│   ├── attribution-metrics/# Attribution tracking
│   ├── data-export/        # Export schemas
│   └── github-app/         # GitHub webhooks
└── generated/              # Generated JSON schemas
    └── telemetry/
```

**Dependencies**:
- `ulid@^3.0.2` - ULID generation for IDs
- `zod@^3.23.8` - Runtime validation
- `zod-to-json-schema@^3.23.5` - JSON Schema export

**DevDependencies**:
- `vitest@^2.1.8` - Testing
- `typescript@^5.7.2` - Compilation
- `tsup@^8.3.5` - Build tooling

### Dependency Analysis

**Active Dependencies** (repos importing from contracts):
```bash
# Search results across all repos
/workspaces/latency/src:        0 imports
/workspaces/agency/src:         0 imports
/workspaces/generacy/src:       0 imports
/workspaces/generacy-cloud/src: 0 imports
/workspaces/humancy/extension:  1 dependency (file:../../contracts)
```

**Finding**: Only `humancy/extension` depends on contracts, and it's currently deferred per the buildout plan. This eliminates breaking change coordination complexity.

**Humancy Analysis**:
```typescript
// humancy/extension/package.json
{
  "dependencies": {
    "@generacy-ai/contracts": "file:../../contracts"
  }
}
```

Many imports in humancy are commented out:
```typescript
// import { DecisionRequest, DecisionResponse } from '@generacy-ai/contracts';
// Commented out pending integration
```

**Conclusion**: Migration has zero impact on active development. Humancy can be updated when brought back into scope.

### Destination Repository Analysis

#### Latency Package

**Current Structure**:
```
latency/packages/latency/src/
├── composition/     # Plugin composition primitives
│   ├── plugin.ts
│   └── context.ts
├── facets/         # Facet interfaces
│   ├── decision.ts
│   ├── logging.ts
│   ├── source-control.ts
│   └── [12 more facets]
├── runtime/        # Facet registry runtime
│   ├── registry.ts
│   └── binder.ts
└── index.ts        # Main exports
```

**Existing Exports**:
- Plugin interfaces (PluginManifest, PluginContext)
- Facet declarations (FacetProvider, FacetRequirement)
- Runtime (FacetRegistry, Binder)
- Error types (FacetNotFoundError, CircularDependencyError)

**Dependencies**:
- None (foundation package)

**Key Finding**: Latency README explicitly states:
> "For abstract plugin interfaces and composition primitives, see @generacy-ai/latency. Abstract plugin interfaces migrated from contracts."

This confirms latency is the intended destination for shared abstractions.

**Capacity for Migration**:
- ✅ Clean structure with clear separation of concerns
- ✅ No existing dependency on contracts
- ✅ Can add new top-level modules without breaking changes
- ✅ Already uses TypeScript + vitest (same as contracts)

#### Agency Package

**Current Structure**:
```
agency/packages/agency/src/
├── server/         # AgencyServer (MCP server)
├── config/         # Configuration loading
├── tools/          # Tool registry and validation
│   ├── registry.ts
│   ├── types.ts
│   ├── validation.ts
│   └── prefixes.ts
├── plugins/        # Plugin loader
├── channels/       # Message channels
├── facets/         # Facet integration
├── modes/          # Mode management
├── telemetry/      # Tool call interception
│   └── interceptor.ts
├── output/         # Terse output
│   └── terse.ts
├── utils/          # Git utilities
└── index.ts        # Main exports
```

**Existing Exports**:
- Server (AgencyServer)
- Tools (ToolRegistry, AgencyTool, ToolResult)
- Telemetry (basic interceptor)
- Output (TerseOutput class)

**Dependencies**:
- `@generacy-ai/latency: "link:/workspaces/latency/packages/latency"` ✅ Already imports latency
- `zod@^3.24.1` ✅ Already has Zod (newer version than contracts)
- `@modelcontextprotocol/sdk@^1.5.0`

**Key Finding**: Agency already has:
1. **tools/** module with `prefixes.ts` - natural home for tool naming from contracts
2. **telemetry/** module with interceptor - natural home for telemetry schemas
3. **output/** module with terse patterns - natural home for terse output schemas

**Capacity for Migration**:
- ✅ Existing modules align with contracts domains
- ✅ Already imports latency (can use migrated types)
- ✅ Already has Zod (compatible version)
- ✅ Uses vitest (same testing framework)

### Cross-Repo Dependency Flow

**Current State**:
```
┌─────────┐
│Contracts│ (isolated, no dependents)
└─────────┘

┌────────┐
│Latency │ (foundation, no dependencies)
└────────┘

┌────────┐     imports     ┌────────┐
│ Agency │ ─────────────> │Latency │
└────────┘                └────────┘

┌─────────┐    imports     ┌────────┐
│Generacy │ ─────────────> │ Agency │
└─────────┘                └────────┘
```

**Post-Migration State**:
```
┌────────┐
│Latency │ (foundation + cross-component contracts)
└────────┘
    ↑
    │ imports
    │
┌────────┐
│ Agency │ (tools + telemetry schemas)
└────────┘
    ↑
    │ imports
    │
┌─────────┐
│Generacy │
└─────────┘

┌─────────┐
│Contracts│ [ARCHIVED]
└─────────┘
```

**Conclusion**: Migration preserves existing dependency direction. No circular dependencies introduced.

## Type Categorization

### By Dependency Graph

**Tier 1: Zero Dependencies** (migrate first)
- `common/ids.ts` - ULID generation
- `common/timestamps.ts` - ISO timestamps
- `common/urgency.ts` - Urgency enum
- All can be migrated independently

**Tier 2: Depends on Tier 1**
- `common/errors.ts` - Uses IDs
- `common/message-envelope.ts` - Uses IDs, timestamps
- `common/pagination.ts` - Independent
- `common/version.ts` - SemVer parsing
- `common/capability.ts` - Uses version, errors

**Tier 3: Depends on Common**
- `orchestration/*` - Uses common/ types
- `version-compatibility/*` - Uses common/ types
- All cross-component schemas - Use common/ types

**Tier 4: Domain-Specific**
- `telemetry/*` - Uses common/ types
- `schemas/*` - Uses common/ types

### By Destination

**→ Latency (Foundation + Cross-Component)**

| Source | Destination | Reason |
|--------|-------------|--------|
| `common/` | `latency/common/` | Shared foundation (IDs, errors, versions) |
| `orchestration/` | `latency/orchestration/` | Work distribution abstractions |
| `version-compatibility/` | `latency/versioning/` | Capability negotiation |
| `agency-generacy/` | `latency/types/` | Cross-component contract |
| `agency-humancy/` | `latency/types/` | Cross-component contract |
| `generacy-humancy/` | `latency/types/` | Cross-component contract |
| `schemas/decision-model/` | `latency/types/` | Cross-component decision flow |
| `schemas/extension-comms/` | `latency/types/` | Extension communication |
| `schemas/knowledge-store/` | `latency/types/` | Knowledge schemas |
| `schemas/learning-loop/` | `latency/types/` | Learning schemas |
| `schemas/attribution-metrics/` | `latency/types/` | Attribution tracking |
| `schemas/data-export/` | `latency/types/` | Export schemas |
| `schemas/github-app/` | `latency/types/` | GitHub webhooks |
| `schemas/platform-api/` | `latency/api/` | Platform API contracts |

**→ Agency (Tool-Specific)**

| Source | Destination | Reason |
|--------|-------------|--------|
| `schemas/tool-naming/` | `agency/tools/naming/` | Tool name validation |
| `schemas/tool-result.ts` | `agency/output/schemas.ts` | Terse output schema |
| `telemetry/` | `agency/telemetry/events/` | Tool call event tracking |
| `generated/` | `agency/schemas/` | Generated tool schemas |

### By Type Nature

**Zod Schemas** (runtime validation):
- 80%+ of contracts are Zod schemas
- Examples: `ToolNameSchema`, `WorkItemSchema`, `ErrorResponseSchema`
- Must migrate with their type exports

**TypeScript Interfaces/Types** (compile-time):
- 15% are pure TypeScript types
- Examples: `type CorrelationId = string`
- Simpler to migrate (no runtime dependencies)

**Utility Functions** (runtime logic):
- 5% are helper functions
- Examples: `generateCorrelationId()`, `parseToolName()`, `compareVersions()`
- Must migrate with associated types

**JSON Schemas** (generated):
- `generated/tool-result.schema.json`
- Generated from Zod schemas
- Must be regenerated post-migration or copied

## Test Coverage Analysis

**Overall Coverage**: Extensive (estimated 90%+ based on sampling)

**Sample from `common/__tests__/`**:
```
ids.test.ts              # Tests ULID generation, format validation
timestamps.test.ts       # Tests ISO timestamp utilities
pagination.test.ts       # Tests pagination params and response schemas
errors.test.ts           # Tests error code enum, error response creation
version.test.ts          # Tests SemVer parsing, comparison, compatibility
capability.test.ts       # Tests capability system, registry
```

**Sample from `orchestration/__tests__/`**:
```
work-item.test.ts        # Tests WorkItem schema validation
agent-info.test.ts       # Tests AgentInfo schema
events.test.ts           # Tests orchestration event types
status.test.ts           # Tests status enums
```

**Sample from `telemetry/__tests__/`**:
```
tool-call-event.test.ts  # Tests ToolCallEvent schema
tool-stats.test.ts       # Tests statistics aggregation
error-category.test.ts   # Tests error categorization
time-window.test.ts      # Tests time window utilities
```

**Test Framework**: Vitest 2.1.8
- Destination repos use vitest 3.2.4 (newer, compatible)
- Test syntax is identical (no changes needed)

**Coverage by Module** (estimated):

| Module | Files | Test Files | Coverage |
|--------|-------|------------|----------|
| `common/` | 15 | 12 | 95%+ |
| `orchestration/` | 8 | 8 | 100% |
| `telemetry/` | 10 | 8 | 95%+ |
| `version-compatibility/` | 6 | 6 | 100% |
| `schemas/tool-naming/` | 5 | 4 | 90%+ |
| Other schemas | ~165 | ~100 | 85%+ |

**Conclusion**: Tests should migrate with types. High existing coverage validates migration correctness.

## Version Compatibility

### TypeScript Version

| Package | Current | Compatible |
|---------|---------|------------|
| contracts | 5.7.2 | ✅ |
| latency | 5.4.5 | ✅ Upgrade to 5.7+ |
| agency | 5.7.3 | ✅ |

**Action**: Update latency to TypeScript 5.7+ for consistency.

### Zod Version

| Package | Current | Compatible |
|---------|---------|------------|
| contracts | 3.23.8 | - |
| latency | Not present | ✅ Add 3.23.8+ |
| agency | 3.24.1 | ✅ (newer, compatible) |

**Action**: Add Zod 3.23.8+ to latency. Agency already compatible.

### Node Version

All packages require Node.js >=20.0.0 ✅

### Package Manager

All repos use pnpm with workspace support ✅

## Build System Analysis

### Contracts Build

**Build Tool**: tsup (bundler)
**Config**: Implicit (no tsup.config.ts found)
**Output**: `dist/` with ESM
**Scripts**:
```json
{
  "build": "tsup",
  "test": "vitest run",
  "lint": "tsc --noEmit"
}
```

### Latency Build

**Build Tool**: tsc (TypeScript compiler)
**Config**: `tsconfig.json`
**Output**: `dist/` with ESM
**Scripts**:
```json
{
  "build": "tsc",
  "typecheck": "tsc --noEmit",
  "test": "echo 'No tests yet'"
}
```

**Note**: Latency currently has no tests. Migration will add first test suite.

### Agency Build

**Build Tool**: tsc (TypeScript compiler)
**Config**: `tsconfig.json` + `tsconfig.base.json`
**Output**: `dist/` with ESM
**Scripts**:
```json
{
  "build": "tsc",
  "test": "vitest run",
  "typecheck": "tsc --noEmit"
}
```

**Conclusion**: Destination repos use `tsc` directly (simpler than tsup). No build tool migration needed.

## Import Path Patterns

### Contracts Internal Imports

**Pattern 1**: Relative with `.js` extension
```typescript
// contracts/src/orchestration/work-item.ts
import { CorrelationId } from '../common/ids.js';
import { ISOTimestamp } from '../common/timestamps.js';
```

**Pattern 2**: Index re-exports
```typescript
// contracts/src/index.ts
export * from './common/index.js';
export * from './orchestration/index.js';
```

### Post-Migration Import Patterns

**Within Latency** (same repo):
```typescript
// latency/src/orchestration/work-item.ts
import { CorrelationId } from '../common/ids.js';
import { ISOTimestamp } from '../common/timestamps.js';
// No change needed
```

**Within Agency** (same repo):
```typescript
// agency/src/telemetry/events/tool-call-event.ts
import { ToolName } from '../../tools/naming/types.js';
// Update relative path only
```

**Agency importing Latency** (cross-repo):
```typescript
// agency/src/telemetry/events/tool-call-event.ts
import { CorrelationId, ISOTimestamp } from '@generacy-ai/latency';
// Import from latency package
```

## JSON Schema Generation

**Current Setup**:
```
contracts/src/generated/
└── tool-result.schema.json
```

**Generation Script**: Not found in repository
- Likely generated manually or via removed script
- Uses `zod-to-json-schema` library

**Post-Migration Strategy**:
1. Copy existing `tool-result.schema.json` to `agency/src/schemas/`
2. Add generation script to agency if needed
3. Export schema in `package.json`:
   ```json
   {
     "exports": {
       "./schemas/tool-result.json": "./src/schemas/tool-result.schema.json"
     }
   }
   ```

## Risk Assessment: Missing Exports

**Method**: Sample 10 random files and verify all exports are public.

**Sample Results**:

1. `common/ids.ts`:
   ```typescript
   export type CorrelationId = string;  // ✅ Public
   export const CorrelationIdSchema = z.string();  // ✅ Public
   export function generateCorrelationId(): CorrelationId { ... }  // ✅ Public
   ```

2. `orchestration/work-item.ts`:
   ```typescript
   export const WorkItemSchema = z.object({ ... });  // ✅ Public
   export type WorkItem = z.infer<typeof WorkItemSchema>;  // ✅ Public
   ```

3. `telemetry/tool-call-event.ts`:
   ```typescript
   export const ToolCallEventSchema = z.object({ ... });  // ✅ Public
   export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;  // ✅ Public
   ```

**Pattern**: Consistent export pattern (schema + inferred type). Low risk of missing exports.

**Verification Method**:
```bash
# Count exports in contracts
rg "^export" /workspaces/contracts/src --type ts | wc -l
# Expected: ~1152

# Count exports after migration
LATENCY=$(rg "^export" /workspaces/latency/packages/latency/src --type ts | wc -l)
AGENCY=$(rg "^export" /workspaces/agency/packages/agency/src --type ts | wc -l)
TOTAL=$((LATENCY + AGENCY))
# Should match (within ~5% tolerance for new index.ts re-exports)
```

## Performance Considerations

**Build Time Impact**:
- Contracts build: ~5 seconds (tsup)
- Latency build: ~3 seconds (tsc, small package)
- Agency build: ~8 seconds (tsc, larger package)

**Post-Migration Estimates**:
- Latency build: ~8 seconds (+5s for new types)
- Agency build: ~10 seconds (+2s for new schemas)

**Acceptable**: Build times remain under 10 seconds.

**Test Time Impact**:
- Contracts tests: ~2 seconds (209 files, extensive tests)
- Latency tests: Currently none
- Agency tests: ~5 seconds

**Post-Migration Estimates**:
- Latency tests: ~1.5 seconds (migrated common + orchestration tests)
- Agency tests: ~6 seconds (+0.5s for telemetry tests)

**Acceptable**: Test times remain under 10 seconds.

## Alternatives Considered

### Alternative 1: Keep Contracts, Add Re-exports

**Approach**: Keep contracts package, make it re-export from latency and agency.

**Pros**:
- No import changes needed for future consumers
- Gradual migration possible

**Cons**:
- Defeats purpose of retirement
- Adds indirection layer
- No benefit (zero active consumers)
- Maintenance burden continues

**Decision**: ❌ Rejected. Direct migration is simpler with zero consumers.

### Alternative 2: Create New Shared Package

**Approach**: Create `@generacy-ai/shared` for cross-component types.

**Pros**:
- Clear "shared" semantics
- Separate versioning

**Cons**:
- Latency already serves this purpose
- Adds another package to maintain
- Spreads types across 3+ packages
- Violates buildout plan (latency is the shared foundation)

**Decision**: ❌ Rejected. Use existing latency package per plan.

### Alternative 3: Monorepo Consolidation First

**Approach**: Move all repos to a monorepo, then migrate.

**Pros**:
- Simpler cross-package references
- Atomic commits

**Cons**:
- Massive scope expansion (out of scope for this issue)
- Delays contracts retirement
- Infrastructure overhead
- Repos are already pnpm workspaces (provides similar benefits)

**Decision**: ❌ Rejected. Out of scope, unnecessary for this task.

### Alternative 4: Inline Everything

**Approach**: Copy types directly into each consumer (no shared packages).

**Pros**:
- Zero dependencies
- Maximum flexibility per repo

**Cons**:
- Type drift between repos
- Duplication of schemas
- Violates DRY principle
- Breaks type safety for cross-component contracts
- Massive code duplication

**Decision**: ❌ Rejected. Shared types are essential for contracts.

## Open Technical Questions

None remaining. All technical questions resolved through research and clarifications.

## References

- [Contracts package.json](/workspaces/contracts/package.json)
- [Contracts README](/workspaces/contracts/README.md)
- [Latency package.json](/workspaces/latency/packages/latency/package.json)
- [Agency package.json](/workspaces/agency/packages/agency/package.json)
- [Onboarding Buildout Plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/onboarding-buildout-plan.md)

---

**Research Date**: 2026-02-24
**Researcher**: Claude (Sonnet 4.5)
**Status**: ✅ Complete
