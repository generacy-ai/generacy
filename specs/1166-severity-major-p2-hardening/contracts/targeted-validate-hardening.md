# Contract: targeted-validate wiring hardening (`phase-loop.ts`)

Covers FR-001, FR-002, FR-003, FR-011, FR-012. The pure `classifyDiff`
(`diff-classifier.ts`) is UNCHANGED — all I/O lives in the wiring layer
(`resolveTargetedValidate` / `computeEffectiveValidateCommand`), per Q3=A.

## Existence filtering (FR-001, FR-002)

**Where**: `resolveTargetedValidate`, between the `getFilesChangedBetween` call
and `classifyDiff`.

```
changedFiles = await context.github.getFilesChangedBetween(baseRef, 'HEAD');
changedFiles = changedFiles.filter((f) => existsSync(join(context.checkoutPath, f)));
isWorkspace = existsSync(join(context.checkoutPath, 'pnpm-workspace.yaml'));
classification = classifyDiff({ changedFiles, isWorkspace });
```

**Guarantees**:
- The filtered `changedFiles` is stored on
  `TargetedValidateDecision.changedFiles`, so the fail-then-pass caller
  (`changedFiles.filter(isTestFile)`) also sees only present paths.
- A diff that only deletes test file(s) → all paths filtered out → empty set →
  `classifyDiff` returns `full-fallback('empty-diff')` → full built-in default
  runs (FR-002). No `pnpm vitest run <nonexistent-file>`.
- A rename (old deleted, new added) → old path filtered out, new path retained →
  validate never references the old path.
- A test-only diff whose files all still exist → identity filter → unchanged
  behavior (runs exactly those files).

## Zero-project fallback (FR-003)

**Where**: `resolveTargetedValidate`, after `classifyDiff`, gated on
`isBuiltInDefault === true` and a classification that would emit a
`pnpm --filter "...[origin/<base>]"` command (`targeted`, `docs-only-skip-tests`).

**Behavior**:
1. Probe the selection: `pnpm --filter "...[origin/<base>]" --depth -1 --json`
   (or `pnpm ls --filter …`) in `context.checkoutPath`.
2. Empty selection → override the effective command to the full built-in default.
3. Probe error → also fall back to full (fail-safe; never emit an unverified
   targeted command).

**Guarantees**:
- A root-only, non-package source change (root `package.json`, `scripts/**`, root
  `vitest.config.ts`) that classifies `targeted` but selects zero projects does
  NOT run a vacuous `pnpm --filter … build/test`; it runs the full default.
- Custom commands and non-bugfix workflows never probe.

## Observability (FR-011)

Exactly one log line per decision, consistent with the existing
`event: 'targeted-validate'` info/warn lines:
- Normal decision: existing `#1134: targeted-validate decision` info line
  (`classification`, `isBuiltInDefault`, `base`, `effectiveCommand`).
- Diff-resolution failure: existing warn line (unchanged).
- Zero-project fallback: one info line with `reason: 'zero-project-fallback'`
  and the full command it fell back to.

## No-regression (FR-012)

- Existence filter is the identity map when every changed path exists.
- Zero-project probe + `<base>` substitution run only on the `speckit-bugfix`
  built-in-default / custom-command paths.
- `classifyDiff` byte-identical; `single-package-plain` and `full-fallback`
  classifications still return the verbatim resolved command.

## Tests (SC-001, SC-002, SC-007)

- Deletion-only test diff → full fallback, no vitest-run-of-missing-file.
- Rename → validate never references the old path.
- Test-only diff, all present → runs exactly those files.
- Root-only non-config diff, zero-project selection → full fallback.
- Zero-project probe error → full fallback.
- Existing classifier/validate suites remain green (no classifier change).
