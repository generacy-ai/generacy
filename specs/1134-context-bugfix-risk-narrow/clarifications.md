# Clarifications

## Batch 1 — 2026-08-20

### Q1: Targeted validate mechanism
**Context**: Validate currently runs the resolved `config.validateCommand`
(workflow → repo → cluster default `pnpm test && pnpm build`) as a shell command
via `cli-spawner.ts:runValidatePhase`. FR-009 wires diff classification *before*
validate. Whether the engine rewrites the resolved command, only rewrites the
default, or only substitutes on opt-in determines the whole targeting mechanism
and its precedence against an operator-set custom `validateCommand`.
**Question**: When diff classification says "targeted", what does the engine do to
the resolved validate command?
**Options**:
- A: Rewrite any resolved command — transform whatever resolved (built-in default
  OR an operator-set custom `validateCommand`) into the pnpm `...[origin/<base>]`
  filter form; guards override to full/plain/skip/test-scoped. Rewrite is a
  transform on the resolved base string.
- B: Rewrite the built-in default command only; leave a custom `validateCommand`
  fully untouched.
- C: Opt-in substitution only — never rewrite; targeting happens only when a
  sentinel/flag or explicit targeted command is configured.

**Answer**: B — Rewrite the built-in default validate command only into the pnpm
`...[origin/<base>]` filter form; leave an operator-set custom `validateCommand`
fully untouched. Guards may override to full/plain/skip/test-scoped.

### Q2: Targeted-validate workflow scope
**Context**: Determines blast radius. Defaults must stay byte-identical when the
diff can't be narrowed (FR-013). Affects whether `speckit-feature` runs also get
targeted validate.
**Question**: Which workflows get targeted validate + diff classification by
default?
**Options**:
- A: All workflows (speckit-feature and speckit-bugfix); guards keep behavior
  identical when the diff can't be narrowed.
- B: `speckit-bugfix` only; other workflows keep the plain resolved command unless
  explicitly configured.

**Answer**: B — `speckit-bugfix` only; other workflows keep the plain resolved
command unless explicitly configured.

### Q3: Guard file globs
**Context**: FR-004/006/007 need exact globs for the classifier. Classification is
a pure function (FR-003), so the glob set is a fixed input contract.
**Question**: What exact file globs define the guard categories (root-config /
docs-only / test-only)?
**Options**:
- A: Standard set — Root-config (force full): `pnpm-lock.yaml`,
  `package-lock.json`, `yarn.lock`, `pnpm-workspace.yaml`, root `tsconfig*.json`,
  `.github/workflows/**`. Docs-only: `**/*.md` + `docs/**`. Test-only:
  `**/*.{test,spec}.{ts,tsx,js,jsx}` + `**/__tests__/**`.
- B: Standard minus root-tsconfig — same as A but a root tsconfig change does NOT
  force full (only lockfiles, `pnpm-workspace.yaml`, and CI workflows do).
- C: Broader docs/CI — Standard plus docs `**/*.mdx` + `*.txt`; root-config also
  `.changeset/config.json`, `turbo.json`, root-level `*.config.{ts,js}`.

**Answer**: A — Standard guard set: root-config (force full) = `pnpm-lock.yaml`,
`package-lock.json`, `yarn.lock`, `pnpm-workspace.yaml`, root `tsconfig*.json`,
`.github/workflows/**`; docs-only = `**/*.md` + `docs/**`; test-only =
`**/*.{test,spec}.{ts,tsx,js,jsx}` + `**/__tests__/**`.

### Q4: `failThenPass` base-ref execution + empty-set behavior
**Context**: FR-011. Spec explicitly defers the empty-set behavior to /clarify.
Also needs the base-ref execution mechanism (worktree vs same-tree) and how
"new/changed test files" are identified.
**Question**: How should the engine run new/changed test files against the base
ref, and what happens when there are NO new/changed test files?
**Options**:
- A: Worktree + empty no-op — run base-ref tests in a detached git worktree at the
  base ref (branch checkout untouched); new/changed test files = diff set filtered
  to test globs; empty set → no-op that does NOT block validate.
- B: Same-tree + empty no-op — check out/stash the base ref in the same working
  tree, run, restore; empty set → no-op, non-blocking.
- C: Worktree + empty fails — worktree at base; empty new/changed-test set is
  treated as a validate failure (a bugfix must include a regression test).
- D: Worktree + empty warns — worktree at base; empty set → warn but do NOT block
  validate.

**Answer**: A — Run base-ref tests in a detached git worktree at the base ref
(branch checkout untouched); new/changed test files = diff set filtered to test
globs; empty set → non-blocking no-op.

### Q5: Per-workflow agents keying for bugfix review
**Context**: FR-012 states "no new agent-resolution code path introduced here."
`resolveAgentForPhase(config, workflowName, phase)` at
`packages/orchestrator/src/worker/config.ts:362` already implements the full
precedence chain (workflow.phases[phase] → workflow.default → agents.default →
defaultsAgent → built-in provider), delivered by #1095/#1122.
**Question**: Is per-workflow agents keying for bugfix review fully delivered by
#1122/#1095 and only *exercised* by this issue (no new resolution path)?
**Options**:
- A: Yes — fully delivered upstream; this issue only adds a harness run
  demonstrating a workflow-scoped agent override picking up on bugfix review.
- B: No — a new/adjusted resolution path is required here.

**Answer**: A — Resolved from context. `resolveAgentForPhase` already provides the
full per-workflow → phase → default precedence (config.ts:362-381); FR-012
mandates no new resolution path. This issue only exercises it via the SC-003/US4
harness run. (Confirm if you disagree.)
