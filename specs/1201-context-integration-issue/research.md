# Research: P1 route plumbing end-to-end verification

## Decision 1 — Golden test level: launcher, not builder

**Decision**: The golden byte-identity test composes the real `ClaudeCodeLaunchPlugin`, the
real credentials interceptor, and spy `ProcessFactory` instances, driving
`AgentLauncher.launch` end-to-end and capturing the final `{command, args, env}` at
`factory.spawn`.

**Rationale**: The epic's flag-free guarantee is about the *bytes handed to the OS*, not
about any single layer. A builder-level snapshot would miss the 3-layer env merge
(`agent-launcher.ts:105-114`) and the `sh -c` credentials wrapper
(`credentials-interceptor.ts:36-47`) — two of the three places #1198/#1199 could
accidentally perturb subscription launches.

**Alternatives considered**:
- Builder-level snapshot of each `buildXxxLaunch` output — rejected: misses the merge and
  wrapper layers entirely.
- Real-process spawn for all six kinds — rejected: slow, non-deterministic (PIDs, tmp
  paths), and unnecessary — the spy already sees the exact spawn triple. A real spawn is
  reserved for the FR-003 wrapper proof (Decision 4).

**Sources**: `multi-provider.test.ts` (direct `new AgentLauncher(new Map([...]))` + mock
factory precedent), `agent-launcher.ts:147-166` (factory selection + spawn call).

## Decision 2 — Fixture provenance & capture procedure (Q1=C)

**Decision**: Capture the fixture exactly once from the pre-P1 merge-base commit (the
`develop` commit immediately before #1198's merge) via a capture harness executed in a git
worktree; record the SHA in `fixtures/README.md`; thereafter treat the fixture as a
forward-stability pin regenerated only via `GOLDEN_UPDATE=1` with PR-description
justification.

**Capture procedure** (executed at implement time, after siblings merge):

1. Identify the merge-base: `git log --first-parent develop --merges` — the commit
   immediately preceding #1198's merge commit. Call it `<PRE_P1_SHA>`.
2. `git worktree add ../generacy-pre-p1 <PRE_P1_SHA>`
3. In the worktree: `pnpm install && pnpm -r build` (the harness imports built seams).
4. Run the capture harness (the golden test file itself with `GOLDEN_UPDATE=1`):
   `GOLDEN_UPDATE=1 pnpm --filter @generacy-ai/orchestrator vitest run golden` — but
   pointed at the worktree's built packages. Since the test file only exists on this
   branch, copy `golden-subscription-spawns.test.ts` + the fixture directory into the
   worktree's `__tests__/` before running (the harness depends only on exports that exist
   at `<PRE_P1_SHA>`: `AgentLauncher`, `ClaudeCodeLaunchPlugin`, `applyCredentials`).
5. Copy the generated `fixtures/subscription-baseline.json` back to this branch; write
   `<PRE_P1_SHA>` + date + procedure into `fixtures/README.md`.
6. `git worktree remove ../generacy-pre-p1`.

**Rationale**: Option B (capture from post-P1 code) is circular — it would prove only that
the post-P1 code equals itself. Option A alone goes stale on the first legitimate spawn
change. C proves parity once and then keeps earning its place as a regression pin.

**Harness portability check (verified this session)**: the harness's only imports —
`AgentLauncher` (constructor takes `Map<string, ProcessFactory>` + optional
`CredhelperClient`), `ClaudeCodeLaunchPlugin`, `applyCredentials` — all exist with the
same shapes at the current merge-base candidates. No #1198+ API is needed to *capture*.

## Decision 3 — Determinism mechanism (Q2=A)

**Decision**: The golden test replaces `process.env` wholesale with a fixed minimal map in
`beforeEach` (saving and restoring the original in `afterEach`), injects a stub
`CredhelperClient` returning a fixed session (`sessionDir: '/fixed/session'`, fixed env
map), and uses a fixed `cwd`. Comparison is `JSON.stringify` with sorted keys against the
fixture — a plain byte compare.

**Rationale**: The `process.env` spread at `agent-launcher.ts:106-111` is hardcoded — there
is no injectable seam for the base env. Stubbing `process.env` itself is the only way to
make the *complete* triple deterministic by construction (Q2=A), and it is what makes the
comparison a maintenance-free byte compare rather than a normalization list (option C) or a
delta compare that silently stops covering removed-var regressions (option B).

**Implementation notes**:
- `const saved = process.env; process.env = { PATH: '/usr/bin', HOME: '/home/fixed' };`
  in `beforeEach`; `process.env = saved;` in `afterEach`. Node permits whole-object
  replacement of `process.env`.
- Sorted-key serialization: a small `stableStringify` helper (recursive key sort) so env
  insertion order can never flip the bytes.
- The stub `CredhelperClient` implements `beginSession`/`endSession` only; session env is
  a fixed literal (e.g. `GENERACY_SESSION_DIR=/fixed/session`, `GIT_CONFIG_GLOBAL=...`).

## Decision 4 — FR-003 wrapper proof: real spawn (spawn-e2e precedent)

**Decision**: In addition to arg-shape assertions, spawn the actual wrapper —
`sh -c '. "$GENERACY_SESSION_DIR/env" && exec "$@"' _ /usr/bin/env` — with a temp
session-dir env file and `CLAUDE_CONFIG_DIR=<sentinel>` in the parent env; assert stdout
contains `CLAUDE_CONFIG_DIR=<sentinel>`.

**Rationale**: The requirement is "the wrapper must not strip inherited env" — a property
of *shell semantics*, not of our arg construction. Arg-shape inspection proves we built
the wrapper we intended; only a real spawn proves the shell behaves as assumed (e.g. that
`.`-sourcing the session env file doesn't clobber or sanitize the inherited var).
`spawn-e2e.test.ts` is the existing precedent for real-process spawns in this suite.

**Alternatives considered**: arg-shape-only assertion — rejected as testing our mental
model of `sh` rather than `sh`.

## Decision 5 — `--settings` guard design (Q4=A)

**Decision**: A committed test performing a recursive `readdirSync` walk of
`packages/orchestrator/src/launcher/**` and
`packages/generacy-plugin-claude-code/src/launch/**`, filtering to non-test `.ts` files
(excluding `__tests__/` dirs and `*.test.ts`), asserting zero `--settings` occurrences.

**Rationale**: A one-time PR grep protects only this PR (option B). The named scope is
exactly the launch-builder surface a future routing PR is most likely to regress, tight
enough to avoid false positives. `source-grep.test.ts` provides the readFileSync +
`.includes()` precedent. The guard file itself contains the literal, hence the test-file
exclusion.

## Decision 6 — Phase-loop test binding deferred to implement (D-6)

**Decision**: The route-transition test pins *behavior*, not API: a three-phase sequence
whose resolved per-phase agents alternate subscription → gateway → subscription must
produce exactly 2 session drops (the session id is NOT passed as `resumeSessionId` across
either crossing) and one `agent.route.transition` log line per crossing, observed via the
injected recording logger. The exact hook location and log-call shape bind at implement
time against #1199's merged code.

**Rationale**: #1199 is open; its final shape (where the route comparison lives, whether a
drop helper exists, the log call signature) is unknowable pre-merge. Q3=A already gates
implement on the siblings being merged, so implement-time binding is guaranteed to have
real code to bind against. Pinning behavior now keeps the plan stable across sibling API
drift.

**Verified session-state seams (current code)**: `currentSessionId` local at
`phase-loop.ts:331`, captured from `result.sessionId`, threaded via
`CliSpawnOptions.resumeSessionId` → `buildPhaseLaunch` `--resume`. No generic drop helper
exists today — #1199 adds it.

## Decision 7 — Docs link target (Q5=A)

**Decision**: The "Model routing" note in `docs/docs/getting-started/configuration.md`
links to the epic (generacy-ai/generacy#1197) and the P2 issue (generacy#1203), and is
explicitly marked "requires a gateway-enabled cluster."

**Rationale**: The tetrad-development design doc is in another repo and marked
`Status: planned` — neither stable nor guaranteed at that path (option C rejected). No
link at all (option B) leaves readers with no way to discover when the gateway ships.
External GitHub URLs are not checked by Docusaurus `onBrokenLinks: 'throw'`, so the build
stays green; swap for a docs link when P2 ships.

## Decision 8 — Changeset shape (FR-011)

**Decision**: `.changeset/1201-p1-route-verification.md` created via
`pnpm changeset --empty` unless a seam fix lands under `packages/*/src/`, in which case
bump the touched package **patch**.

**Rationale**: The expected diff is tests + fixtures + docs only — the gate's test-only
exemption would skip it, but FR-011 requires a changeset regardless (CI gate on generacy
PRs). Empty changesets are the documented mechanism for "no release needed."
