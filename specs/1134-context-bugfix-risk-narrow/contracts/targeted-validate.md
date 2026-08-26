# Contract: Targeted-validate wiring (phase-loop.ts validate block)

Runs the classifier and rewrites the effective validate command BEFORE execution
(FR-009), for `speckit-bugfix` only (Q4=B).

## Preconditions

- `context.item.workflowName === 'speckit-bugfix'`. Otherwise the block is skipped
  entirely and `runValidatePhase(config.validateCommand, ...)` runs unchanged (SC-005).

## Steps

1. Resolve `baseRef` via `resolveBaseRef` / `resolveBaseBranch` → `origin/<name>`;
   strip `origin/` → bare `<base>`.
2. `changedFiles = github.getFilesChangedBetween(baseRef, 'HEAD')`.
3. `isWorkspace = fs.exists(join(checkoutPath, 'pnpm-workspace.yaml'))`.
4. `classification = classifyDiff({ changedFiles, isWorkspace })`.
5. `isBuiltInDefault = config.validateCommand === DEFAULT_VALIDATE_COMMAND`.
6. Compute effective command per the resolution table (data-model.md).
7. Log `{ event: 'targeted-validate', classification: <kind>, isBuiltInDefault, base, effectiveCommand }`.
8. Run `runValidatePhase(checkoutPath, effectiveCommand, signal)`.

## Rewrite rules (Q1=B)

- Only rewrite when `isBuiltInDefault`. A custom `validateCommand` runs verbatim
  regardless of classification (classification is still computed + logged for
  observability).
- `targeted` → `pnpm --filter "...[origin/<base>]" build && pnpm --filter "...[origin/<base>]" test`
- `docs-only-skip-tests` → build-only filtered command
- `test-only` → `pnpm vitest run <files>`
- `single-package-plain` / `full-fallback` → plain default command

## Invariants

- Non-bugfix workflow → zero behavior change (byte-identical, FR-013/SC-005).
- Custom command → never rewritten (Q1=B).
- Exactly one log line per validate entry describing the decision.

## Tests (SC-003)

- bugfix + targeted + built-in default → filtered command, log emitted.
- bugfix + custom command → custom runs verbatim; classification still logged.
- feature workflow → block skipped; default command runs.
- each guard produces its documented effective command.
