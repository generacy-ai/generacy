# Research: Bugfix targeted-validate and fail-then-pass hardening

Decisions backing `plan.md`. Each cites the FR(s) it satisfies and the
clarification answer that constrains it.

## Decision 1 — Where existence filtering and the zero-project guard live

**Decision**: In the targeted-validate wiring layer (`resolveTargetedValidate`
in `phase-loop.ts`), not inside `classifyDiff`. (FR-001, FR-003; Q3=A)

**Rationale**: `classifyDiff` is contractually pure/no-I/O/never-throws
(#1134 `contracts/diff-classifier.md`). Its unit-testability and determinism
depend on that. Existence filtering needs `fs`, and the zero-project probe needs
to shell out to `pnpm` — both are I/O. Injecting an `exists`/project-probe
callback into the classifier (the rejected Q3 option B) would break the contract
for no benefit: the wiring layer already does the base-ref resolution and diff
computation, so it is the natural home for two more probes.

**Implementation**: In `resolveTargetedValidate`, after
`changedFiles = await context.github.getFilesChangedBetween(baseRef, 'HEAD')`
and before `classifyDiff`, map to an existence-filtered set:
`changedFiles.filter((f) => existsSync(join(context.checkoutPath, f)))`. Pass the
filtered set to `classifyDiff` and store it on
`TargetedValidateDecision.changedFiles` (so fail-then-pass's
`changedFiles.filter(isTestFile)` also sees only present paths — mirrors the
ENOENT overlay handling in `overlayTestFiles`).

**Alternatives considered**: (B) callback-injected I/O in the classifier —
rejected, breaks the purity contract. (C) filter inside
`computeEffectiveValidateCommand` — rejected, that function is pure by design and
runs after classification, too late to affect the `test-only`/`targeted` split.

## Decision 2 — FR-002 needs no new branch (empty filtered set → full)

**Decision**: Rely on the existing `classifyDiff` empty-diff path. (FR-002)

**Rationale**: `classifyDiff({ changedFiles: [], … })` already returns
`{ kind: 'full-fallback', reason: 'empty-diff' }`, which
`computeEffectiveValidateCommand` maps to the verbatim default command. A
deletion-only diff whose paths are all filtered out therefore falls back to the
full validate automatically. Adding a bespoke "empty after filtering" branch
would be redundant. The single `targeted-validate` info log already records
`classification: 'full-fallback'`, satisfying FR-011 for this path.

## Decision 3 — Zero-project targeted selection → full fallback

**Decision**: Before returning a `targeted` (or `docs-only-skip-tests`)
classification whose effective command uses `pnpm --filter "...[origin/<base>]"`,
probe the selection; if it resolves zero projects (or the probe errors), fall
back to the full built-in default. (FR-003; Q3=A wiring placement)

**Rationale**: Root `package.json`, `scripts/**`, and a root `vitest.config.ts`
currently classify as `targeted`, but `--filter "...[origin/<base>]"` selects no
package project for a root-only change, so `pnpm --filter … build/test` builds and
tests nothing and *passes* — a vacuous green (US2). The wiring already knows
`base` and whether the command is the built-in default; a `pnpm --filter
"...[origin/<base>]" --depth -1 --json` (or `pnpm ls --filter …`) probe reveals an
empty selection. Empty → return the full-fallback command instead.

**Fail-safe**: A probe error (pnpm not resolvable, unexpected output) must also
fall back to full — never emit a targeted command we could not validate as
non-empty. Better a full run than a vacuous targeted one.

**Scope guard**: The probe only runs on the `speckit-bugfix` built-in-default
path (`isBuiltInDefault === true`) and only for classifications that would emit a
`--filter` command. Custom commands and non-bugfix workflows never probe (FR-012).

**Log line**: On zero-project fallback, emit one `event: 'targeted-validate'`
info line with a `reason: 'zero-project-fallback'` discriminator (FR-011).

**Testability**: The probe shells out through the same `execFile` the existing
fail-then-pass tests mock; phase-loop tests route it through the shared handler.
No new production DI surface.

## Decision 4 — Conservative infra-failure signature at the base ref

**Decision**: Add an `isInfraFailure(output)` predicate; a base-ref (or
branch) test run that fails an infra signature check becomes a non-blocking
`skip` with a logged reason instead of a `base-passed`/`branch-failed` finding.
(FR-004, FR-005; Q1=A no build step, Q2=A pre-collection only)

**Rationale**: The current flow reports any non-zero base run as a test outcome:
an unbuilt `dist` makes the base run fail for infrastructure reasons, the branch
run then also fails the same way, and the proof degenerates to a spurious
`branch-failed`. Likewise a repo with no root vitest yields a false
`branch-failed` (FR-005). Q1=A rules out adding a base build step; instead we
detect the infra signature and skip.

**Signature (conservative, Q2=A)**: Only a *pre-collection* failure counts as
infra — vitest exiting having collected/run **zero** tests. High-confidence
markers:
- `No test files found` (vitest emits this when the path set resolves to nothing).
- A module/dist resolution error surfacing before any test executes
  (`Cannot find module`, `Failed to resolve import`, `Failed to load url`, ERR_MODULE_NOT_FOUND)
  with no evidence of a collected test having run.

Any output showing a test was collected and then failed (`FAIL`, `✓`/`×` test
lines, `Tests  N failed`) is a **genuine** outcome and must NOT be masked. When
ambiguous, bias to genuine. Substring-only matching that ignores whether tests
ran (the rejected Q2 option B) risks masking a real failure and is not used.

**Where applied**: After the base run (`baseOutcome`) — if `!passed &&
isInfraFailure(output)` → `skip`. After the branch run (`branchOutcome`) — same,
so FR-005's no-root-vitest case (branch also collects zero tests) skips rather
than reporting `branch-failed`.

## Decision 5 — Dedicated per-run wall-clock cap for test runs

**Decision**: New `BASE_TEST_TIMEOUT_MS` constant, applied as a per-run
`timeout` on each `runTests` call. (FR-006; Q5=A)

**Rationale**: `installDeps` already uses `BASE_INSTALL_TIMEOUT_MS`; the test
runs have no cap, so a hung base or branch run stalls validate up to the
cli-spawner phase cap. Q5=A endorses a dedicated per-run constant mirroring the
install one, independent of the install budget — the smallest, most consistent
change. Deriving a single shared budget split across install+base+branch (the
rejected Q5 option B) couples three independent operations and is harder to
reason about.

**Value**: Chosen to sit comfortably under the cli-spawner phase cap so a hang
aborts inside fail-then-pass rather than at the outer spawn. A test timeout is an
infrastructure condition → non-blocking `skip` with reason (never a
`branch-failed`). Distinguish a `timeout` kill (`err.killed` / `code === 'ETIMEDOUT'`)
from an `AbortError` (caller aborted the whole phase — propagate/clean up, do not
convert to a spurious finding).

**Implementation note**: `runTests` gains a `timedOut` signal on its outcome (or
a distinct return) so the main flow can map a timed-out base/branch run to `skip`
rather than to the `base-passed`/`branch-failed` decision.

## Decision 6 — mkdtemp parent cleanup + signal-free cleanup + prune

**Decision**: Capture the `mkdtemp` parent directory; in `finally`, run the
worktree removal WITHOUT the abort signal, then `git worktree prune`, then remove
the `mkdtemp` parent. (FR-007, FR-008)

**Rationale**:
- **FR-007**: today `worktreePath = join(await mkdtemp(...), 'wt')` — only the
  inner `wt` worktree is removed; the `mkdtemp` parent (`gen-ftp-XXXX`) leaks. Fix:
  `const tmpParent = await mkdtemp(join(tmpdir(), 'gen-ftp-'))`, `worktreePath =
  join(tmpParent, 'wt')`, and `rm(tmpParent, { recursive: true, force: true })` in
  `finally`.
- **FR-008**: the cleanup `git worktree remove --force` currently passes the same
  `signal`. If the phase was aborted, the signal is already aborted, so the
  cleanup exec rejects immediately and the worktree registration is orphaned. Fix:
  run cleanup without the signal (best-effort, `.catch`), then run `git worktree
  prune` (also best-effort, no signal) to reconcile any orphaned registration.

**Ordering in `finally`**: (1) `git worktree remove --force <worktreePath>`
best-effort no-signal; (2) `git worktree prune` best-effort no-signal; (3)
`rm(tmpParent, { recursive: true, force: true })` best-effort. Each guarded so
one failure does not skip the next.

## Decision 7 — `git worktree add` failure → non-blocking skip

**Decision**: Wrap the `git worktree add` in try/catch; on failure return
`{ kind: 'skip', reason }`. (FR-009)

**Rationale**: A `git worktree add` failure is an infrastructure condition
consistent with the documented infra-failure posture (install failure, deleted
paths, timeouts all skip). Today the throw propagates out of `runFailThenPass`
and hard-fails the validate phase on wrong evidence. The `finally` still runs
(best-effort cleanup + prune handle a partially-created worktree), and the caller
`runFailThenPassCheck` already treats `skip` as "proceed to normal validate".

## Decision 8 — `<base>` placeholder substitution for custom commands

**Decision**: In `computeEffectiveValidateCommand`, when the command is NOT the
built-in default, substitute `<base>` with the bare base branch before returning.
Update `bugfix-profile-config.md` to use `origin/<base>`. (FR-010; Q4=A)

**Rationale**: Custom `validateCommand`s run verbatim today, so a doc example
hardcoding `origin/develop` silently filters against a non-existent ref on a
`main`-based repo. A direct precedent exists — the merge-conflict remedy in
`phase-loop.ts` already does
`.replace(/<branch>/g, branchName).replace(/<base>/g, bareBase)` with
`bareBase = baseRef.replace(/^origin\//, '')`. Reusing that shape makes the
documented targeted filter resolve against the resolved base on both `develop`-
and `main`-based repos.

**Diff-resolution-failure path**: The early-return fallback in
`resolveTargetedValidate` (when base-ref/diff resolution throws) returns the
resolved command with `base: ''`. To keep `<base>` substitution working even
there, resolve `base` (bare base branch) before the diff computation, or apply the
substitution on the resolved command in the fallback branch too. The plan resolves
`base` first so the substitution is always available; a custom command with
`<base>` is never emitted with the literal placeholder unsubstituted.

**Doc-only vs code**: Q4=A chose the code substitution over a doc-only warning
because custom commands are returned verbatim today — only a real substitution
fixes `main`-based repos. The doc change alone would leave the placeholder inert.

## Cross-cutting — FR-011 logging and FR-012 no-regression

- **FR-011**: Every new fall-back/skip/infra decision emits exactly one log line
  consistent with the existing `event: 'targeted-validate'` / `event:
  'fail-then-pass'` shapes: zero-project fallback (`reason:
  'zero-project-fallback'`), infra skip (`outcome: 'skip', reason: 'infra:<sig>'`),
  timeout skip (`outcome: 'skip', reason: 'timeout'`), worktree-add skip
  (`outcome: 'skip', reason: 'worktree-add-failed'`).
- **FR-012**: The existence filter is the identity map when all changed paths
  exist. The zero-project probe and `<base>` substitution only run on the
  `speckit-bugfix` built-in-default / custom-command paths. Non-bugfix workflows
  never enter `resolveTargetedValidate`. fail-then-pass is off by default. So
  non-bugfix and non-triggering bugfix validate behavior is byte-identical.
