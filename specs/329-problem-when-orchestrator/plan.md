# Implementation Plan: Pre-Validate Dependency Installation

**Feature**: Add dependency installation before orchestrator validate phase
**Branch**: `329-problem-when-orchestrator`
**Status**: Complete

## Summary

When the orchestrator worker resumes a workflow into the validate phase, it clones the repository fresh but does not run `pnpm install` before executing `pnpm test && pnpm build`. This causes immediate failure because `vitest` and other devDependencies are missing from the fresh clone (`node_modules` doesn't exist).

The fix adds a configurable `preValidateCommand` (defaulting to `pnpm install`) that runs before the validate command in the phase loop.

## Technical Context

- **Language**: TypeScript
- **Runtime**: Node.js
- **Framework**: Fastify (HTTP server), custom worker orchestration
- **Package Manager**: pnpm (monorepo with workspace protocol)
- **Testing**: Vitest
- **Validation**: Zod schemas for configuration
- **Key Package**: `packages/orchestrator`

## Approach

**Option chosen: Pre-validate install step in the phase loop (spec Option 1)**

This is the cleanest approach because:
- Keeps the validate command config focused on actual validation
- The phase loop already has branching logic for validate vs CLI phases
- Reuses the existing `CliSpawner` process management infrastructure
- Configurable: projects can customize or disable the install step

### Why not the alternatives:
- **Prepend to validateCommand** (Option 2): Conflates installation with validation in config; harder to disable/customize independently
- **Post-checkout hook** (Option 3): Over-engineering — only validate needs deps installed (Claude CLI phases handle deps internally)

## Implementation Design

### 1. Add `preValidateCommand` to WorkerConfig

Add a new optional config field to `WorkerConfigSchema` in `config.ts`:

```typescript
preValidateCommand: z.string().default('pnpm install')
```

This allows:
- Default behavior: runs `pnpm install` before validate
- Customization: projects can set a different install command (e.g., `npm ci`, `yarn install`)
- Disabling: set to empty string to skip

### 2. Add `runPreValidateInstall` method to CliSpawner

Add a new method to `CliSpawner` that runs the install command before validation. This mirrors `runValidatePhase` but with its own timeout and logging context:

```typescript
async runPreValidateInstall(
  checkoutPath: string,
  installCommand: string,
  signal: AbortSignal,
): Promise<PhaseResult>
```

- Timeout: 5 minutes (300,000ms) — `pnpm install` in a monorepo shouldn't exceed this
- Reuses `manageProcess` for process lifecycle management
- Returns `PhaseResult` so the phase loop can handle failure uniformly

### 3. Integrate into PhaseLoop

In `phase-loop.ts`, before the `runValidatePhase` call, insert the install step:

```typescript
if (PHASE_TO_COMMAND[phase] === null) {
  // Run dependency installation before validation
  if (config.preValidateCommand) {
    const installResult = await cliSpawner.runPreValidateInstall(
      context.checkoutPath,
      config.preValidateCommand,
      context.signal,
    );
    if (!installResult.success) {
      // Handle install failure the same as validate failure
      ...
    }
  }
  // Then run the validate command
  result = await cliSpawner.runValidatePhase(...);
}
```

## Project Structure (files to modify)

```
packages/orchestrator/src/worker/
├── config.ts                          # Add preValidateCommand field
├── cli-spawner.ts                     # Add runPreValidateInstall method
├── phase-loop.ts                      # Call install before validate
└── __tests__/
    ├── cli-spawner.test.ts            # Test new method
    └── phase-loop.test.ts             # Test pre-validate integration (if exists)
```

## Testing Strategy

1. **Unit test `runPreValidateInstall`** in `cli-spawner.test.ts`:
   - Verify it spawns `sh -c <installCommand>` with correct cwd
   - Verify it returns success/failure PhaseResult
   - Verify timeout behavior

2. **Unit test phase loop integration**:
   - Verify install runs before validate when `preValidateCommand` is set
   - Verify install is skipped when `preValidateCommand` is empty string
   - Verify install failure stops the phase loop (doesn't proceed to validate)

3. **Config schema test**:
   - Verify default value is `pnpm install`
   - Verify empty string is accepted

## Risk Assessment

- **Low risk**: The change is additive — it only affects the validate phase path
- **No breaking changes**: Default behavior adds `pnpm install` which is exactly what's needed
- **Failure mode**: If `pnpm install` fails, the validate phase fails early with a clear error instead of the current cryptic "vitest not found"
