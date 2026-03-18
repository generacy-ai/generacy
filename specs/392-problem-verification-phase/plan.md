# Implementation Plan: Discovery-Based Workflow Verification

**Feature**: Replace hardcoded `pnpm run test`/`pnpm run lint` verification steps with `build.validate` tool
**Branch**: `392-problem-verification-phase`
**Status**: Complete

## Summary

This is a minimal YAML-only change to two workflow files. Each file's verification phase currently uses individual `verification.check` steps with hardcoded `pnpm` commands. We replace those with a single `build.validate` step that auto-detects the package manager and discovers all available validation scripts.

The `build.validate` tool (from generacy-ai/agency#323) handles all detection, discovery, and execution internally — the workflow files just need to invoke it.

## Technical Context

- **Language**: YAML (workflow definitions only — no application code changes)
- **Framework**: Speckit workflow engine (`.generacy/*.yaml`)
- **Key dependency**: `build.validate` tool from generacy-ai/agency#323 (must be deployed first)
- **Package manager**: pnpm (but the point is to stop hardcoding this)

## Project Structure

```
.generacy/
├── speckit-feature.yaml   # Phase 7 verification — MODIFY
└── speckit-bugfix.yaml    # Phase 6 verification — MODIFY
```

No other files are affected.

## Changes

### 1. `speckit-feature.yaml` — Phase 7 (verification)

**Before** (lines 197–208):
```yaml
- name: run-tests
  uses: verification.check
  with:
    command: 'if [ -f pnpm-workspace.yaml ]; then pnpm -r run --if-present test; elif [ -f package.json ]; then pnpm run --if-present test; else echo "No package.json found, skipping tests"; fi'
  continueOnError: true

- name: run-lint
  uses: verification.check
  with:
    command: 'if [ -f pnpm-workspace.yaml ]; then pnpm -r run --if-present lint; elif [ -f package.json ]; then pnpm run --if-present lint; else echo "No package.json found, skipping lint"; fi'
  continueOnError: true
```

**After**:
```yaml
- name: validate
  uses: build.validate
  continueOnError: true
```

### 2. `speckit-bugfix.yaml` — Phase 6 (verification)

**Before** (lines 166–176):
```yaml
- name: run-tests
  uses: verification.check
  with:
    command: pnpm run test
  continueOnError: true

- name: run-lint
  uses: verification.check
  with:
    command: pnpm run lint
  continueOnError: true
```

**After**:
```yaml
- name: validate
  uses: build.validate
  continueOnError: true
```

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Single `build.validate` step (no `with:` params) | The tool auto-detects everything; no configuration needed |
| Keep `continueOnError: true` | FR-004: partial failures must not halt the workflow |
| Remove phase-level comments about `--if-present` and monorepo detection | `build.validate` handles this internally; comments would be misleading |
| Update phase comment to reflect new behavior | Accuracy of inline documentation |

## Verification Checklist

- [ ] No `pnpm` references remain in verification phases (SC-001)
- [ ] Each workflow has exactly 1 verification step using `build.validate` (SC-002)
- [ ] `continueOnError: true` preserved on the `build.validate` step (FR-004)
- [ ] No changes to any phase other than verification (Out of Scope constraint)

## Risks & Assumptions

| Risk | Mitigation |
|------|------------|
| `build.validate` not yet deployed (agency#323) | This is a stated prerequisite — changes are safe to merge only after #323 lands |
| `build.validate` exit codes incompatible with `continueOnError` | Assumption in spec; verify during implementation |

## Constitution Check

No `.specify/memory/constitution.md` found — no governance constraints to verify against.
