# Implementation Plan: 5.5 — Docker Compose Template for Multi-Repo Projects

**Branch**: `253-5-5-docker-compose` | **Date**: 2026-02-26

## Summary

This plan implements the 12 clarification resolutions (Q1–Q12) against the existing `@generacy-ai/templates` package. The docker-compose template, devcontainer template, schema, renderer, builders, fixtures, and tests all already exist — this work is about correcting and hardening them based on resolved clarifications.

The changes fall into 4 categories:
1. **Template fixes** — docker-compose.yml.hbs and devcontainer.json.hbs corrections
2. **Schema tightening** — Zod validation range changes + repo name collision guard
3. **Renderer fix** — `noEscape: true` for YAML/non-HTML output
4. **Test/fixture updates** — fixture values, expected errors, and snapshot regeneration

## Technical Context

| Aspect | Detail |
|--------|--------|
| **Language** | TypeScript (ESM) |
| **Package** | `@generacy-ai/templates` at `packages/templates/` |
| **Template engine** | Handlebars 4.7.8 |
| **Schema validation** | Zod |
| **Test framework** | Vitest 3.2.4 with `@vitest/coverage-v8` |
| **Coverage threshold** | 80% lines/functions/branches/statements |

## Architecture Overview

No architectural changes. The existing structure remains:

```
packages/templates/src/
  schema.ts          ← Zod schemas (workerCount, pollIntervalMs, repo collision)
  renderer.ts        ← Handlebars engine (noEscape fix)
  builders.ts        ← Context builders (default value updates)
  validators.ts      ← Post-render validation (devcontainer features check)
  multi-repo/
    docker-compose.yml.hbs  ← Template fixes (Q1,Q5,Q6,Q7,Q8,Q11)
    devcontainer.json.hbs   ← Add features block (Q1)
  single-repo/
    devcontainer.json.hbs   ← No changes
```

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| `noEscape: true` globally | All templates produce YAML/JSON, never HTML. HTML escaping corrupts output (Q12). |
| Repo collision via `.refine()` | Simplest approach — fail fast at validation time with a clear error. No workspace layout changes (Q9). |
| Features in devcontainer.json only | `features:` is invalid Docker Compose syntax. Dev Container CLI processes features from devcontainer.json (Q1). |
| Primary repo mount `..` not `../..` | `.devcontainer/` lives inside primary repo, so `..` = primary repo root (Q11). |
| Single-repo workerCount: 0 still valid | The `.min(1).max(20)` constraint only applies to multi-repo context. Single-repo uses `workerCount: 0` and never renders docker-compose. The `OrchestratorContextSchema` must remain permissive (`.nonnegative()` is too loose, but `.min(0).max(20)` works). The `.min(1)` enforcement happens at the `MultiRepoInputSchema` and builder level. |

---

## Implementation Phases

### Phase 1: Schema Changes

**Files**: `src/schema.ts`

#### 1a. Tighten `OrchestratorContextSchema` validation

```
pollIntervalMs: .positive() → .min(5000)
workerCount: .nonnegative().default(3) → .nonnegative().max(20).default(2)
```

- `pollIntervalMs` changes from `.positive()` (min 1) to `.min(5000)` per Q3.
- `workerCount` keeps `.nonnegative()` (to allow 0 for single-repo) but adds `.max(20)` and changes default from 3 to 2 per Q2.
- Update `.describe()` strings to reflect new constraints.

#### 1b. Tighten `MultiRepoInputSchema` validation

```
workerCount: .positive() → .min(1).max(20)
pollIntervalMs: .positive() → .min(5000)
```

- Multi-repo input enforces `workerCount >= 1` (can't have 0 workers in orchestrator/worker architecture) per Q2.
- Multi-repo input enforces `pollIntervalMs >= 5000` per Q3.

#### 1c. Add repo name collision validation

Add a `.refine()` to `ReposContextSchema` that checks all repos (primary, dev[], clone[]) resolve to unique `repoName` values. Per Q9:

```typescript
.refine((repos) => {
  const allRepos = [repos.primary, ...repos.dev, ...repos.clone];
  const names = allRepos.map(r => r.split('/')[1]);
  const unique = new Set(names);
  return unique.size === names.length;
}, {
  message: "Multiple repos resolve to the same mount path..."
})
```

The error message should identify which repos collide (use `.superRefine()` for a dynamic message).

---

### Phase 2: Template Fixes

#### 2a. `multi-repo/docker-compose.yml.hbs`

| Line(s) | Change | Clarification |
|----------|--------|---------------|
| 9 | Remove `version: "3.8"` and blank line | Q6 |
| 19–20 | Remove `ports:` section from redis service | Q5 |
| 36–38 | Remove `features:` block from orchestrator | Q1 |
| 61 | Change `../..` to `..` for primary repo mount | Q11 |
| 78–79 | Keep `generacy-state` and `vscode-server` on orchestrator | — |
| 106–108 | Remove `features:` block from worker | Q1 |
| 128 | Change `../..` to `..` for primary repo mount in worker | Q11 |
| 144–145 | Remove `vscode-server` volume mount from worker | Q8 |
| After worker `depends_on` | Add health check to worker (mirror orchestrator's) | Q7 |

**Resulting worker health check** (added after `command: sleep infinity`):
```yaml
    healthcheck:
      test: ["CMD", "test", "-f", "/home/vscode/.generacy/ready"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 30s
```

#### 2b. `multi-repo/devcontainer.json.hbs`

Add `features` block per Q1. The single-repo template already has this pattern:
```json
  "features": {
    "ghcr.io/generacy-ai/features/generacy{{devcontainer.featureTag}}": {}
  },
```

Add this between `"service"` and `"workspaceFolder"` (or after `"workspaceFolders"`, before `"customizations"` — consistent with the single-repo template which places features before customizations).

---

### Phase 3: Renderer Fix

**File**: `src/renderer.ts`

#### 3a. Change `noEscape` to `true`

At line 261, change:
```typescript
noEscape: false, // Allow HTML escaping (safer default)
```
to:
```typescript
noEscape: true, // Templates produce YAML/JSON, not HTML
```

Per Q12: HTML escaping corrupts YAML output (e.g., `&amp;` instead of `&`).

---

### Phase 4: Builder Updates

**File**: `src/builders.ts`

#### 4a. Update multi-repo builder default

At line 197, change:
```typescript
const workerCount = validated.workerCount ?? 3;
```
to:
```typescript
const workerCount = validated.workerCount ?? 2;
```

Per Q2: default workerCount is 2, not 3.

---

### Phase 5: Validator Updates

**File**: `src/validators.ts`

#### 5a. Update devcontainer.json validation for multi-repo

The `validateRenderedDevContainer` function (line 250–261) currently requires either `features` or `customizations`. After Q1, multi-repo devcontainer.json will have **both** `features` AND `customizations`, so this check still passes.

However, the Generacy feature validation (lines 264–275) only checks `if (hasFeatures)`. This now needs to fire for multi-repo devcontainer.json too. Verify this path is exercised — it should be, since we're adding `features` to the multi-repo template.

#### 5b. Update docker-compose validation

The `validateRenderedDockerCompose` function should also check for `worker` service (not just `redis` and `orchestrator`). Add `'worker'` to `requiredServices` array at line 314:
```typescript
const requiredServices = ['redis', 'orchestrator', 'worker'];
```

---

### Phase 6: Fixture Updates

#### 6a. `tests/fixtures/multi-repo-context.json`

- `orchestrator.pollIntervalMs`: `3000` → `5000`
- `orchestrator.workerCount`: `3` → `2`

#### 6b. `tests/fixtures/large-multi-repo-context.json`

- `orchestrator.pollIntervalMs`: `2000` → `5000`

#### 6c. `tests/fixtures/invalid-contexts.json`

- `negativeWorkerCount.expectedError`: `"Number must be greater than or equal to 0"` → `"Number must be greater than or equal to 1"` (but note: the context schema allows 0 for single-repo; the fixture's `isMultiRepo: true` with `workerCount: -1` should still fail with the `.nonnegative()` check, just with updated message from `.min(0)`)

Actually, re-evaluating: The `OrchestratorContextSchema` uses `.nonnegative()` (allows 0) to support single-repo's `workerCount: 0`. A `workerCount: -1` still fails. The error message for `.nonnegative()` is `"Number must be greater than or equal to 0"`. If we change to `.min(0).max(20)`, the error for -1 becomes `"Number must be greater than or equal to 0"` — same message. So the fixture error message stays the same for the `-1` case.

BUT: we should add a new invalid context for the `MultiRepoInputSchema` — where `workerCount: 0` in multi-repo input fails with `.min(1)`. And a new case for `pollIntervalMs: 1000` failing with `.min(5000)`.

- `zeroPollInterval.context.orchestrator.pollIntervalMs`: keep at `0`, update `expectedError` from `"Number must be greater than 0"` to `"Number must be greater than or equal to 5000"`

#### 6d. `tests/fixtures/single-repo-context.json`

- `orchestrator.workerCount`: currently `0` — this is correct and should remain valid under the updated schema (`.nonnegative().max(20)`)

---

### Phase 7: Test Updates

#### 7a. Update snapshot tests

Run `pnpm test -- --update` in the templates package to regenerate snapshots after template changes. The snapshots will reflect:
- No `version: "3.8"` in docker-compose
- No `ports:` on redis
- No `features:` in docker-compose services
- `features` block added to multi-repo devcontainer.json
- Primary mount `..` instead of `../..`
- Worker health check added
- No `vscode-server` volume on worker
- Updated workerCount defaults (2 instead of 3)
- Updated pollIntervalMs values in fixtures

#### 7b. Update unit tests

- **`renderer.test.ts`**: Any tests asserting HTML escaping behavior need updating (the `noEscape` change means `&` stays as `&`, not `&amp;`). Tests that verify template rendering with special characters should be updated.
- **`validators.test.ts`**: Update expected error messages for schema changes. Add tests for repo name collision validation. Update docker-compose validation to expect `worker` service.
- **`builders.test.ts`**: Update default workerCount expectations from 3 to 2.

#### 7c. Update integration tests

- **`render-project.test.ts`**: Update any assertions about docker-compose content (version field, features, port mapping, mount paths).
- **`fixture-validation.test.ts`**: Fixtures should pass validation after updates.

---

## Change Summary

| File | Changes |
|------|---------|
| `src/schema.ts` | pollIntervalMs `.min(5000)`, workerCount `.max(20)` default 2, MultiRepoInput constraints, repo name collision `.superRefine()` |
| `src/renderer.ts` | `noEscape: true` (line 261) |
| `src/builders.ts` | Default workerCount `3` → `2` (line 197) |
| `src/validators.ts` | Add `worker` to required docker-compose services |
| `src/multi-repo/docker-compose.yml.hbs` | Remove version, remove redis ports, remove features blocks, fix mount paths, remove worker vscode-server, add worker health check |
| `src/multi-repo/devcontainer.json.hbs` | Add `features` block with Generacy dev container feature |
| `tests/fixtures/multi-repo-context.json` | pollIntervalMs 3000→5000, workerCount 3→2 |
| `tests/fixtures/large-multi-repo-context.json` | pollIntervalMs 2000→5000 |
| `tests/fixtures/invalid-contexts.json` | Update zeroPollInterval expectedError |
| `tests/integration/__snapshots__/snapshots.test.ts.snap` | Regenerate all snapshots |
| Various test files | Update assertions to match new schema/template behavior |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Snapshot churn | Regenerate snapshots as final step after all template/schema changes are complete. Review diff carefully. |
| Single-repo workerCount: 0 regression | Keep `OrchestratorContextSchema` permissive (`.nonnegative()`). Only enforce `.min(1)` at `MultiRepoInputSchema` level. Verify single-repo fixture still passes. |
| Template YAML syntax errors after edits | Run `validateRenderedDockerCompose()` on rendered output in tests. Manually verify YAML parses correctly. |
| `noEscape` change breaks existing renders | Audit all template variables for characters that were previously HTML-escaped (`&`, `<`, `>`, `"`). Project names and repo names use `[\w.-]+` regex, so no HTML-sensitive characters are possible in those fields. The change is safe. |
| Repo collision refine on existing fixtures | Verify all existing fixtures have unique repo names. They do — all use same org with distinct repo names. |

## Execution Order

1. Schema changes (Phase 1) — foundation for everything else
2. Template fixes (Phase 2) — depends on schema for context shape understanding
3. Renderer fix (Phase 3) — independent, small change
4. Builder updates (Phase 4) — depends on schema defaults
5. Validator updates (Phase 5) — depends on template structure
6. Fixture updates (Phase 6) — must match new schema constraints
7. Test updates (Phase 7) — final step, validates everything
8. Run full test suite: `pnpm test` in `packages/templates/`
