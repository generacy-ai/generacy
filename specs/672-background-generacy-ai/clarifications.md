# Clarifications for #672: Split orchestrator into server vs client packages

## Batch 1 — 2026-05-20

### Q1: Design Option Confirmation
**Context**: The spec lists three design options and marks Option A (types package + dynamic import, orchestrator fully removed from CLI `dependencies`) as "Recommended." The spec is in "Draft" status, and the original issue body notes "questions worth answering before designing a fix." Confirming the design choice affects every subsequent implementation decision.
**Question**: Should we proceed with Option A? The key implication is that `generacy orchestrator` will require users to explicitly install `@generacy-ai/orchestrator` before it works — is that acceptable?
**Options**:
- A: Yes, proceed with Option A (types package + dynamic import, orchestrator removed from `dependencies`)
- B: Use Option B (optional dependency) to keep `generacy orchestrator` working out of the box where possible
- C: Use Option C (conditional peer dependency)

**Answer**: *Pending*

### Q2: Test File Import Strategy
**Context**: `subprocess-snapshot.test.ts` imports `AgentLauncher` (class), `GenericSubprocessPlugin` (class), `RecordingProcessFactory`, and `normalizeSpawnRecords` as *runtime* imports from `@generacy-ai/orchestrator` and `@generacy-ai/orchestrator/test-utils`. These are runtime classes/functions, not types — they can't live in a types-only package. FR-007 says "update test imports to reference new package paths" but doesn't address this mismatch. The natural solution is to add `@generacy-ai/orchestrator` as a `devDependency` (tests work in dev, not installed for end users), but this isn't mentioned in the spec.
**Question**: How should test files that need runtime orchestrator imports be handled?
**Options**:
- A: Move `@generacy-ai/orchestrator` to `devDependencies` in the CLI package (tests keep current imports, users don't install it)
- B: Move test utilities (`RecordingProcessFactory`, etc.) and the `AgentLauncher` class into the new types package (making it more than types-only)
- C: Restructure/remove the snapshot test so it doesn't need runtime orchestrator imports

**Answer**: *Pending*

### Q3: Types Package Scope
**Context**: FR-001 says "Extract shared types (AgentLauncher, LaunchHandle, OrchestratorConfig, etc.)" — the "etc." is unspecified. The CLI's production code only uses 3 types from orchestrator: `AgentLauncher` (type-only in `subprocess.ts`), and `OrchestratorConfig` (type used in `orchestrator.ts` alongside runtime imports). The orchestrator exports 80+ types covering API schemas, relay types, SSE, monitors, etc. A minimal package is less work and less maintenance; a comprehensive one could serve future consumers.
**Question**: Should the new types package include only the types the CLI currently imports (minimal: ~3 types), or a broader set of orchestrator types/schemas for potential future use?
**Options**:
- A: Minimal — only types currently imported by CLI production code (`AgentLauncher`, `LaunchHandle`, `OrchestratorConfig`)
- B: Moderate — types + Zod schemas that are independent of Fastify/Redis (config schemas, auth types, launcher types)
- C: Comprehensive — all orchestrator type exports that don't depend on heavy runtime code

**Answer**: *Pending*
