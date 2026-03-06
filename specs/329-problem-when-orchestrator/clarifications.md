# Clarifications: #329 — Validate phase fails because pnpm install is not run after checkout

## Batch 1 — 2026-03-06

### Q1: Empty Environment in Validate Phase
**Context**: Code analysis reveals that `runValidatePhase()` in `cli-spawner.ts:99` passes `env: {} as Record<string, string>`, meaning the validate command runs with a completely empty environment (no PATH, HOME, etc.). Even after installing dependencies, commands may fail without PATH. This appears to be a separate but related bug.
**Question**: Should this bug fix also address the empty `env: {}` in `runValidatePhase()`, or should that be tracked as a separate issue?
**Options**:
- A: Fix both in this PR (empty env + missing deps)
- B: Separate issue for empty env, this PR only fixes dependency installation

**Answer**: *Pending*

### Q2: Solution Approach — Option 1 vs Option 3
**Context**: The spec recommends Option 3 (post-checkout hook in `claude-cli-worker.ts`) over Option 1 (pre-validate install in `cli-spawner.ts`). Option 3 benefits all phases but is more complex. However, Claude CLI phases may already handle their own dependencies internally, making Option 1 (simpler, targeted) potentially sufficient.
**Question**: Should we implement Option 3 (post-checkout hook benefiting all phases) or Option 1 (pre-validate install, simpler and targeted to the actual bug)?
**Options**:
- A: Option 3 — Post-checkout hook (recommended in spec)
- B: Option 1 — Pre-validate install step (simpler, targeted fix)

**Answer**: *Pending*

### Q3: Retry Behavior on Install Failure
**Context**: FR-003 requires reporting installation failures clearly, but doesn't specify what happens next. If `pnpm install` fails (e.g., network issue, corrupt lockfile), should the validate phase be skipped/failed, or should installation be retried?
**Question**: When dependency installation fails, should the worker immediately fail the validate phase, or attempt a retry?
**Options**:
- A: Fail immediately with clear error (keep it simple)
- B: Retry once, then fail if still unsuccessful

**Answer**: *Pending*

### Q4: Stale node_modules Detection
**Context**: FR-004 (P3) mentions "Installation should only run when node_modules is missing or stale." Detecting staleness is non-trivial — it could mean comparing lockfile timestamps, checking a hash, or simply always reinstalling on fresh checkouts.
**Question**: For FR-004, should we defer staleness detection and simply check for the existence of `node_modules/` (install if missing, skip if present), or implement lockfile-based staleness checking?
**Options**:
- A: Simple existence check only (install if node_modules missing)
- B: Lockfile timestamp comparison
- C: Defer FR-004 entirely (always install, optimize later)

**Answer**: *Pending*
