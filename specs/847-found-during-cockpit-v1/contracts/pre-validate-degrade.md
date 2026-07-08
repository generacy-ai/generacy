# Contract: `preValidateCommand` degrade on single-package repos

**Scope**: FR-001, FR-002. Behavior of `WorkerConfig.preValidateCommand` default and its interaction with `applyRepoValidateOverrides`.

## Default command (post-fix)

`WorkerConfigSchema.preValidateCommand.default` (`packages/orchestrator/src/worker/config.ts:59`) MUST resolve to the following shell string, byte-exact:

```sh
pnpm install && if [ -f pnpm-workspace.yaml ] && ls packages/*/package.json >/dev/null 2>&1; then pnpm -r --filter './packages/*' build; fi
```

- Whitespace inside the string is a single-space between tokens; the shell parser is tolerant, but the test fixture asserts on this exact form to catch accidental double-space / newline drift.
- The command is passed to `CliSpawner.runPreValidateInstall` as `installCommand`, which wraps it in `ShellIntent { kind: 'shell', command }` and dispatches to `sh -c` via the launcher. No shell-quoting layer intervenes.

## Execution semantics

Executed in the worker's `checkoutPath` (the repo checkout root). Given the working directory at execution time:

| State of checkout | Expected behavior | Exit signal to phase-loop |
|-------------------|-------------------|---------------------------|
| No `pnpm-workspace.yaml`, no `packages/` dir | `pnpm install` runs; build half skipped by `if` guard | 0 (success) if install succeeds; N (fail) if install fails |
| `pnpm-workspace.yaml` present, `packages/` empty or contains only non-package subdirs | `pnpm install` runs; `ls packages/*/package.json` returns non-zero → build half skipped | 0 (success) if install succeeds |
| `pnpm-workspace.yaml` present + ≥ 1 `packages/*/package.json` | Both halves run — full monorepo behavior (unchanged from pre-fix) | 0 on both succeeding; non-zero if either fails |
| No `pnpm-workspace.yaml`, `packages/` has projects | `pnpm install` runs; `[ -f pnpm-workspace.yaml ]` false → build half skipped | 0 if install succeeds. (Edge case: a monorepo without a workspace file is malformed; the degrade skips the build half rather than trying and failing.) |
| `pnpm install` itself fails (network error, corrupt lockfile, etc.) | Outer `&&` short-circuits; build half never attempted | non-zero → FR-003 evidence block on the stage comment |

## Portability constraints

- `[ -f <path> ]`: POSIX test-primary. Portable across `dash`, `bash`, `sh`. MUST NOT be replaced with `[[ ]]` (bash-only).
- `ls packages/*/package.json >/dev/null 2>&1`: relies on the shell's default glob expansion (no `nullglob`). On zero matches, `ls` receives the literal argument `packages/*/package.json` (or nothing under some shells), errors, and exits non-zero. Both outcomes are consumed by the `if`.
- The redirect `>/dev/null 2>&1` MUST be present — without it, users see stderr noise from `ls: cannot access …: No such file or directory` in worker logs.

## Interaction with `applyRepoValidateOverrides` (FR-002 regression guard)

The merge function at `config.ts:98` is unchanged. Its contract remains:

- If `.generacy/config.yaml` sets `orchestrator.preValidateCommand: "<custom>"`, the returned config has `preValidateCommand === "<custom>"`. The default (with degrade logic) is discarded wholesale.
- If `.generacy/config.yaml` sets `orchestrator.preValidateCommand: ""` (explicit empty string), the returned config has `preValidateCommand === ""`. `phase-loop.ts:155` checks `if (config.preValidateCommand)` — the empty string is falsy, install is skipped entirely.
- If `.generacy/config.yaml` has no `orchestrator` block or omits `preValidateCommand`, the default (with degrade logic) is retained.

**Regression tests** (`config.test.ts`):
1. `WorkerConfigSchema.parse({}).preValidateCommand === "<exact default string>"` (SC-005 signal).
2. Override with a custom string → returned config has the custom string, not the default.
3. Override with `""` → returned config has `""` (preserved as "skip install").
4. Combination: override with only `validateCommand` set → `preValidateCommand` retains the (new) default.

## Non-goals

- No package-manager detection (npm/yarn/bun). If the repo uses a non-pnpm manager, the author authors a per-repo override or waits for FR-009 (staging emits template-appropriate config).
- No detection of alternative monorepo layouts (`apps/*`, `libs/*`, nested workspaces). The `packages/*` shape is what the default targets; other layouts already require an override.
- No JS-level introspection of the checkout before running the shell command. All detection is inside `sh -c`.
