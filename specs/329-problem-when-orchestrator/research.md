# Research: Pre-Validate Dependency Installation

## Technology Decisions

### 1. Where to add the install step

**Decision**: Phase loop, before `runValidatePhase` call

**Rationale**:
- The phase loop (`phase-loop.ts:124-131`) already has a clear branch for validate vs CLI phases
- Adding the install call before `runValidatePhase` keeps the change localized
- `CliSpawner` already has all the process management infrastructure needed

**Alternatives considered**:
- **In `RepoCheckout.ensureCheckout()`**: Would install deps on every checkout, even for CLI phases that don't need them. Wasteful and potentially slow.
- **In `ClaudeCliWorker.handle()`**: Would install deps even when not reaching validate phase. Also wrong abstraction level.
- **Prepend to `validateCommand`**: Quick hack but breaks separation of concerns — installation vs validation are different operations with different failure semantics.

### 2. Separate method vs inline

**Decision**: New `runPreValidateInstall` method on `CliSpawner`

**Rationale**:
- Gives the install step its own timeout (5 min vs 10 min for validate)
- Clear logging with distinct context (`pre-validate install` vs `validation command`)
- Reuses `manageProcess` for clean process lifecycle management
- Could be extended later (e.g., caching, lock file detection)

**Alternative**: Could reuse `runValidatePhase` directly with the install command. But this conflates the logging/timeout semantics. The 10-minute validate timeout is excessive for `pnpm install`.

### 3. Configuration approach

**Decision**: Add `preValidateCommand` field to `WorkerConfigSchema`

**Rationale**:
- Follows existing pattern — `validateCommand` is already configurable
- Default `pnpm install` matches the project's package manager
- Empty string allows disabling (for CI environments where deps are pre-installed)
- Zod schema validation ensures type safety

### 4. Install timeout

**Decision**: 5 minutes (300,000ms) hardcoded constant

**Rationale**:
- `pnpm install` in a monorepo with lockfile typically takes 30-120 seconds
- 5 minutes provides generous headroom for slow networks/cold caches
- Not worth making configurable — if install takes >5 min, something is wrong
- Follows same pattern as `DEFAULT_VALIDATE_TIMEOUT_MS` constant

## Implementation Patterns

### Existing patterns followed:
1. **Zod schema defaults** (`config.ts`): All config fields have sensible defaults via `.default()`
2. **Process lifecycle** (`cli-spawner.ts`): `manageProcess` handles SIGTERM/SIGKILL, timeout, abort, and stdout/stderr capture
3. **Phase result propagation** (`phase-loop.ts`): Failed steps return early with `completed: false`
4. **Logging context** (`cli-spawner.ts`): All process spawns log phase, cwd, command, and timeout

## Key Sources

- Root cause: `cli-spawner.ts:86-105` — `runValidatePhase` runs `sh -c` without prior dependency installation
- Worker lifecycle: `claude-cli-worker.ts:109-446` — full queue item processing flow
- Phase branching: `phase-loop.ts:124-131` — validate vs CLI phase dispatch
- Config schema: `config.ts:19-43` — worker configuration with Zod validation
