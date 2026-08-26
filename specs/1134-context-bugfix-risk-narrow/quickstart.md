# Quickstart: #1134 Bugfix profiles

## What this delivers

Behavior for the per-workflow config keys shipped in #1122/#1124:

- **Verification review charter** — bugfix review asks four targeted questions.
- **Targeted validate** — `speckit-bugfix` runs build/test scoped to changed
  packages + dependents on pnpm monorepos, with safety guards.
- **`failThenPass`** — opt-in proof that a regression test fails on base and passes
  on the branch.
- **Cheaper bugfix review agent** — via existing per-workflow agents keying.

## Enabling the verification charter

Per-workflow config (already schema-valid from #1122):

```yaml
workflows:
  speckit-bugfix:
    review:
      profile: verification      # asks the four bugfix questions
      blockingSeverity: critical # default for bugfix
    maxRemediations: 2           # default for bugfix
```

## Targeted validate

Automatic for `speckit-bugfix` when `validateCommand` is the **built-in default**
(`pnpm test && pnpm build`). The engine classifies the diff and rewrites the command:

| Diff shape | Effective command |
|-----------|-------------------|
| changed package source | `pnpm --filter "...[origin/<base>]" build && pnpm --filter "...[origin/<base>]" test` |
| docs only | filtered build, no tests |
| tests only | `pnpm vitest run <changed test files>` |
| lockfile / root tsconfig / `pnpm-workspace.yaml` / CI workflow touched | full default command |
| non-workspace repo | plain default command |

A **custom** `validateCommand` is always run verbatim (the engine only rewrites the
default). Non-bugfix workflows always run the plain resolved command.

Look for the log line to see the decision:

```
{ "event": "targeted-validate", "classification": "targeted", "isBuiltInDefault": true, "base": "develop", "effectiveCommand": "pnpm --filter ..." }
```

## Enabling failThenPass

```yaml
workflows:
  speckit-bugfix:
    review:
      failThenPass: true   # off by default
```

When on, the engine runs the new/changed test files against the base ref (in a
detached worktree) and against the branch. Validate fails unless the tests **fail on
base** and **pass on branch**. No new/changed test files → non-blocking no-op.

## Running the tests

```bash
pnpm --filter @generacy-ai/orchestrator test diff-classifier
pnpm --filter @generacy-ai/orchestrator test review-charter
pnpm --filter @generacy-ai/orchestrator test fail-then-pass
pnpm --filter @generacy-ai/orchestrator test phase-loop.targeted-validate
```

## Safety

With no new config on a non-bugfix workflow, validate and charter behavior are
byte-identical to pre-change (FR-013 / SC-005).
