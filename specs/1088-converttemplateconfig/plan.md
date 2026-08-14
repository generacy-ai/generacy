# Implementation Plan: Remove the hardcoded `develop` workspace branch — no-preference branch resolution

**Feature**: `convertTemplateConfig` hardcodes `branch: 'develop'`, so `generacy setup workspace` force-switches every repo onto `develop`; fix by making branch fully optional end-to-end and teaching setup to leave checkouts alone when no branch is configured
**Branch**: `1088-converttemplateconfig` | **Date**: 2026-08-14 | **Spec**: [spec.md](./spec.md)
**Status**: Complete
**Input**: Feature specification from `/specs/1088-converttemplateconfig/spec.md` + clarifications (Q1=A, Q2=A, Q3=A, Q4=A, Q5=A)

## Summary

Three hardcoded `'develop'` literals conspire to force every workspace repo onto `develop`:

1. `packages/config/src/convert-template.ts:26` — `convertTemplateConfig` always emits `branch: 'develop'` (root cause; occupies the config slot in the resolution chain so "no preference" is unrepresentable for template-format configs).
2. `packages/config/src/workspace-schema.ts:12` — `WorkspaceConfigSchema.branch` applies Zod `.default('develop')` (same failure via the workspace-format path; in scope per Q1=A).
3. `packages/generacy/src/cli/commands/setup/workspace.ts:111` — the final `?? 'develop'` fallback in the resolution chain (removed per FR-007, Q4=A).

The fix makes `branch` optional with no default in both schemas, adds an optional top-level `branch:` key to the template format (Q3=A), and rewrites `cloneOrUpdateRepo` to distinguish two modes:

- **Explicit branch** (flag → `REPO_BRANCH` → `DEFAULT_BRANCH` → config): behavior unchanged — switch existing checkouts, clone with `--branch`.
- **No preference** (nothing resolved): never switch an existing checkout — update it on its current branch; clone new repos without `--branch` (lands on the remote default). Non-standard states (detached HEAD, branch with no `origin/<branch>`) get fetch-only + `warn` + success (Q5=A). No GitHub API lookup (Q2=A).

The "Configuration" log line gains the resolved branch decision (value + source, or "repo default / current branch") per FR-006.

## Technical Context

**Language/Version**: TypeScript 5.x, ESM, Node >=22 (CLI package gate)
**Primary Dependencies**: `zod` (schemas in `@generacy-ai/config`), `commander` (CLI), `pino` (logging via `getLogger()`), `node:child_process` via `exec`/`execSafe` helpers
**Storage**: N/A — reads `.generacy/config.yaml`, mutates git working trees only
**Testing**: Vitest. Unit tests with `execSafe` mocks (existing pattern in `packages/generacy/src/cli/commands/setup/__tests__/workspace.test.ts`); one real-git integration test for the finetooth regression (SC-001)
**Target Platform**: Linux containers (cluster post-activation) + local dev
**Project Type**: pnpm monorepo — changes span `packages/config` and `packages/generacy`
**Performance Goals**: N/A (no new network calls; Q2=A explicitly avoids adding any)
**Constraints**: No GitHub API / `git ls-remote` lookups; setup must never mutate a checkout it has no opinion about; explicit-source behavior byte-identical (US3)
**Scale/Scope**: 2 schema files, 1 conversion function, 1 CLI command file, ~6 test files touched, 1 changeset

## Constitution Check

`.specify/memory/constitution.md` does not exist in this repository — no constitution gates apply. House rules from `CLAUDE.md` that do apply:

- **Changeset gate**: non-test files under `packages/config/src/` and `packages/generacy/src/` change → a new `.changeset/*.md` must be added in this PR. See [research.md § D6](./research.md).
- No new dependencies, no new packages, no backwards-compatibility shims.

## Project Structure

### Documentation (this feature)

```text
specs/1088-converttemplateconfig/
├── spec.md              # Input (read-only)
├── clarifications.md    # Q1–Q5 answered 2026-08-14
├── plan.md              # This file
├── research.md          # Decisions D1–D6 with alternatives
├── data-model.md        # Schema/type changes
├── quickstart.md        # Config examples + troubleshooting
└── contracts/
    └── branch-resolution.md   # Resolution chain + cloneOrUpdateRepo decision matrix
```

### Source Code (repository root)

```text
packages/config/src/
├── workspace-schema.ts          # MODIFIED: branch → z.string().min(1).optional(), no default (FR-001a)
├── template-schema.ts           # MODIFIED: TemplateConfigSchema gains top-level branch: optional (FR-002, Q3=A)
├── convert-template.ts          # MODIFIED: emit template.branch (may be undefined) — no 'develop' literal (FR-001)
└── __tests__/
    ├── workspace-schema.test.ts # MODIFIED: "defaults to develop" → "undefined when omitted"; empty-string rejection kept
    ├── template-schema.test.ts  # MODIFIED: new branch-field cases (valid / empty rejected / absent → undefined)
    ├── convert-template.test.ts # MODIFIED: "always sets develop" → unset-when-absent + pass-through-when-declared
    └── loader.test.ts           # AUDIT: fixtures use explicit `branch: develop` YAML — expected to pass unchanged

packages/generacy/src/
├── cli/commands/setup/
│   ├── workspace.ts             # MODIFIED: resolution chain (no final ?? 'develop'), branchSource tracking,
│   │                            #   cloneOrUpdateRepo no-preference mode, FR-006 log line
│   └── __tests__/
│       ├── workspace.test.ts    # MODIFIED: new no-preference + precedence + non-standard-state cases (SC-002/003)
│       └── workspace.integration.test.ts  # NEW: real-git finetooth regression (SC-001)
├── __tests__/setup/workspace.test.ts      # AUDIT: second (execSync-mock) suite — update any 'develop' assertions
└── config/__tests__/schema.test.ts        # AUDIT: :630/:665 assert workspace?.branch === 'develop' — update if fixture omits branch

.changeset/1088-branch-no-preference.md    # NEW: @generacy-ai/config minor + @generacy-ai/generacy patch
```

**Structure Decision**: All production changes live in the two packages already owning the behavior. No new modules beyond a small private helper inside `workspace.ts` (`updateExistingRepo` split out of `cloneOrUpdateRepo` is optional — see contracts; the decision matrix can also be implemented inline).

## Design

### 1. `packages/config` — make branch a genuine no-opinion field

- `WorkspaceConfigSchema.branch`: `z.string().min(1).default('develop')` → `z.string().min(1).optional()`. Inferred type becomes `branch?: string | undefined`. Empty string still rejected (`.min(1)` applies when present).
- `TemplateConfigSchema` gains top-level `branch: z.string().min(1).optional()` (Q3=A — mirrors workspace format).
- `convertTemplateConfig` returns `{ org: primary.owner, branch: template.branch, repos }`. With `exactOptionalPropertyTypes` off in this repo, assigning `undefined` to the optional property is fine; the literal disappears entirely (SC-004).

**Consumer audit** (spec Assumptions requirement — performed, results):

| Consumer | Reads `.branch`? | Impact |
|----------|------------------|--------|
| `packages/generacy/src/cli/commands/setup/workspace.ts` | Yes (`:94`, `:107-112`, `cloneOrUpdateRepo`, `:297` log) | The change site — see § 2 |
| `packages/config/src/repos.ts` (`resolveSiblingWorkdirs`, `getRepoNames`) | No | None |
| `packages/orchestrator` (claude-cli-worker, config loader) | No (loads config for `repos` only) | None |
| `packages/cockpit/src/config/loader.ts` | No (`findWorkspaceConfigPath` only) | None |
| `packages/workflow-engine` | No (comment reference only) | None |
| `packages/generacy/src/config/schema.ts` (`GeneracyConfigSchema.workspace`) | Embeds `WorkspaceConfigSchema` — runtime code never reads `workspace.branch`; only tests assert the old default | Test updates only |

### 2. `workspace.ts` — resolution + no-preference update/clone

Local `WorkspaceConfig` interface:

```ts
interface WorkspaceConfig {
  repos: string[];
  branch: string | undefined;              // was: string
  branchSource: BranchSource;              // NEW — FR-006
  workdir: string;
  clean: boolean;
  githubOrg: string;
  repoSource: 'CLI flag' | 'REPOS env var' | 'config file';
}
type BranchSource = 'CLI flag' | 'REPO_BRANCH env' | 'DEFAULT_BRANCH env' | 'config file' | 'none';
```

Resolution (replaces `:107-112`):

```ts
// first defined wins; no final literal (FR-005, FR-007)
cliArgs.branch ?? process.env['REPO_BRANCH'] ?? process.env['DEFAULT_BRANCH'] ?? configBranch
```

`branchSource` is derived alongside (which tier supplied the value, or `'none'`).

FR-006 "Configuration" log line (`:297`):

```ts
logger.info(
  {
    org: config.githubOrg,
    branch: config.branch ?? '(repo default / current branch)',
    branchSource: config.branchSource,
    repos: config.repos.length,
    source: config.repoSource,
  },
  'Configuration',
);
```

`cloneOrUpdateRepo` decision matrix — full contract in [contracts/branch-resolution.md](./contracts/branch-resolution.md):

| State | Explicit branch | No preference |
|-------|-----------------|---------------|
| Existing checkout, current == target | fetch + pull (unchanged) | n/a (no target) |
| Existing checkout, current != target | fetch, switch, pull (unchanged) | **fetch + pull current branch; never switch** (FR-003) |
| Existing checkout, detached HEAD | switch to target (unchanged) | **fetch only, `warn`, success** (Q5=A) |
| Existing checkout, no `origin/<current>` | switch to target (unchanged) | **fetch only, `warn`, success** (Q5=A) |
| New repo | `clone --branch <t>`, fallback plain clone (unchanged) | **plain clone directly** — no `--branch` attempt (FR-004) |

Detection for the no-preference existing-checkout path (after `git fetch origin`):
- `git branch --show-current` → empty stdout ⇒ detached HEAD.
- `git rev-parse --verify --quiet refs/remotes/origin/<current>` → non-zero ⇒ no matching remote branch. Local check against just-fetched refs — no network, no API (Q2=A).
- Otherwise: `git pull origin <current>` (best-effort, as today — pull result is not treated as failure).

The clone log line (`:221`) logs `branch: config.branch ?? '(repo default)'`.

### 3. Tests

- **Unit (config)**: rewrite the three `'develop'`-default assertions; add template `branch:` pass-through + validation cases. Empty-string rejection tests stay green.
- **Unit (workspace.ts)**: existing precedence tests keep passing (their config mocks declare explicit branches). New cases:
  - No-preference: config without `branch` → no `git checkout` call, pull targets the current branch, clone commands contain no `--branch` (SC-001 unit-level, SC-004).
  - Detached HEAD / missing `origin/<branch>` → no pull, one `warn`, repo counted successful (Q5=A).
  - `DEFAULT_BRANCH` tier covered explicitly (chain currently only has flag/`REPO_BRANCH` tests) (SC-003).
  - FR-006: Configuration log line carries `branchSource` and the placeholder value in the no-preference case.
- **Integration (SC-001, finetooth regression)**: NEW `workspace.integration.test.ts` with real git in a temp dir: bare fixture repo initialized with default branch `main` containing `.generacy/config.yaml` (template format, no branch key) → clone into `<tmp>/workspaces/<repo>` → run `setup workspace --workdir <tmp>/workspaces --config <checkout>/.generacy/config.yaml` twice. Assert: still on `main`, no "Switching branch" log, config file present, second run exits 0. Harness detail: point `HOME`/`GIT_CONFIG_GLOBAL` at the temp dir so `git config --global` calls in the command are isolated. Only the *update* path is exercised (clone URLs are hardcoded to github.com, so the fresh-clone path stays unit-tested with mocks).
- **Audit**: `packages/generacy/src/__tests__/setup/workspace.test.ts` (execSync-mock suite) and `packages/generacy/src/config/__tests__/schema.test.ts:630,:665` for `'develop'` assertions whose fixtures omit `branch` — update to `toBeUndefined()` where applicable.
- **SC-004 grep gate**: `grep -rn "'develop'" packages/config/src/convert-template.ts packages/config/src/workspace-schema.ts` → 0; no `?? 'develop'` in `workspace.ts` branch resolution.

### 4. Changeset

`.changeset/1088-branch-no-preference.md`:
- `@generacy-ai/config` — **minor**: new public template-config `branch:` key + `WorkspaceConfig.branch` type widened to optional (new capability + API surface change).
- `@generacy-ai/generacy` — **patch**: defect fix in `setup workspace` behavior; no new exports.

## Risks & Mitigations

- **External `REPOS`-env users silently relying on the `'develop'` literal** (FR-007): accepted per Q4=A — the FR-006 log line is the signal; existing generacy-ai clusters' repos actually default to `develop`, so their observable behavior is unchanged (clone lands on the same branch).
- **Type break for out-of-tree `WorkspaceConfig` consumers**: `branch` becomes `string | undefined`. In-repo audit found zero runtime readers outside `workspace.ts`; the minor bump on `@generacy-ai/config` flags it for any external consumer.
- **`git branch --show-current` requires git ≥2.22**: already relied on by the existing code path (`:201`); no new requirement.

## Complexity Tracking

No constitution violations; no added complexity requiring justification.
