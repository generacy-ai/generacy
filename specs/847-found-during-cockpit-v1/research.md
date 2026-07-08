# Research: preValidate degrade + failure evidence block (#847)

## Problem Restatement

Two co-manifesting gaps:

**Gap A** — the default `preValidateCommand` (`pnpm install && pnpm -r --filter './packages/*' build`) hard-fails on any repo without a `packages/` directory. Every fresh single-package Next.js/Astro/Vite scaffold `failed:validate` on its first issue before `runValidatePhase` ever ran.

**Gap B** — when a phase fails, `StageCommentManager.renderStageComment` drops the failing command, exit code, and stderr. The developer sees only "validate ❌ error" on the GitHub issue and must `docker exec` into a worker container to diagnose.

Both surfaced together on `christrudelpw/sniplink#2/#3` during the cockpit v1 integration smoke test.

## Evidence

### Observed failure (Gap A)

- `sniplink#2/#3` were fresh Next.js scaffolds with no `.generacy/config.yaml` `orchestrator` block.
- On first `phase:validate`: `pnpm install` succeeded (Next.js has a `package.json`), then `pnpm -r --filter './packages/*' build` exited non-zero (zero project matches).
- `phase-loop.ts:161` recorded "Pre-validate install failed"; `runValidatePhase` (`phase-loop.ts:179`) never ran.
- Issue labeled `failed:validate` with no diagnostic content on the issue.

### Observed failure (Gap B)

- On the same `failed:validate` issues, the stage comment showed:
  ```
  | validate | ❌ error | 2026-07-08T00:12:03Z | 2026-07-08T00:12:07Z |
  **Status**: ❌ Error
  ```
- No command, no exit code, no stderr. `docker exec -it worker-N pino-pretty < /tmp/worker.log` was required to see `pnpm -r --filter './packages/*' build → ELIFECYCLE Command failed with exit code 1`.

### Source verification (2026-07-08)

- **Gap A root cause**: `packages/orchestrator/src/worker/config.ts:59` — `preValidateCommand: z.string().default("pnpm install && pnpm -r --filter './packages/*' build")`.
- **Gap A merge site (unchanged by this fix)**: `applyRepoValidateOverrides` (`config.ts:98`) correctly honors per-repo `.generacy/config.yaml` `orchestrator.preValidateCommand`. Explicit empty string is preserved (`config.ts:113`).
- **Gap B upstream data source**: `PhaseResult.error = { message, stderr, phase }` populated in `cli-spawner.ts:247`. `PhaseResult.exitCode` in `cli-spawner.ts:232`. Timeout/abort message strings in `cli-spawner.ts:240–244`.
- **Gap B render site**: `StageCommentManager.renderStageComment` (`stage-comment-manager.ts:119`) — reads only `data.status`, `data.phases`, `data.startedAt/completedAt`, `data.prUrl`. `PhaseResult.error` never reaches it.
- **Gap B call sites (3 total)** in `phase-loop.ts`:
  - Line ~168: pre-validate install failure.
  - Line ~217: unexpected spawn error (`catch` block).
  - Lines ~336 / ~373 / ~394: post-phase failure sites (main error, product-diff detection failure, empty-product-diff failure).

## Decision 1 — Gap A: how the degrade should behave when `packages/` is absent

**Chosen**: run `pnpm install` only; suppress the `-r --filter … build` half. Detection lives in the shell command itself (see Decision 3), not in the WorkerConfig loader.

**Rationale**:
- Per Q1→A: preValidate exists to make `validateCommand` runnable. `validateCommand` typically needs `node_modules`. Skipping install entirely (Q1→B) just moves the failure ("missing node_modules") one step later. `pnpm install` on non-pnpm repos behaves acceptably as a *default* (creates a `node_modules` compatible with `npm test`, uses `package.json` from the lockfile in `package-lock.json`/`yarn.lock` when present).
- Package-manager detection (Q1→C) is a larger project — see the "Out of Scope" bullet in spec.md. FR-009 (staging emits per-template config) is the precision instrument for repos that aren't pnpm-shaped.
- Q1→B was rejected because it silently degrades single-package repos twice (skip install → validate fails on missing node_modules) and hides the real fix (`pnpm install` is the *right* default for the intended flow).

**Rejected alternative**: change `applyRepoValidateOverrides` to detect and override at merge time. Rejected because it would couple config resolution to the worker's checkout filesystem — a layering violation (the config loader today doesn't know about the checkout).

## Decision 2 — Gap A: where the fs detection lives

**Chosen**: inline the detection in the default shell command string (see Decision 3 for exact shape).

**Rationale**:
- Keeps the fix localized to one line of `config.ts` — no changes to `CliSpawner.runPreValidateInstall`, no new spawner code path, no new fs-utility import in `worker/`.
- The detection runs on the *worker's checkout*, which is exactly where the answer lives — the same shell layer that runs `pnpm install` also runs the `test -f` / `ls` checks against the checked-out repo, atomically.
- Alternative (JS-level detection): add a `preValidateDetect(checkoutPath)` function that resolves the command string per-invocation. Rejected because it introduces two failure surfaces (the JS check + the shell command) where today there is one, and the JS check has to duplicate the shell's glob semantics.

## Decision 3 — Gap A: the exact detection condition (Q3→D resolved)

**Chosen**: BOTH `pnpm-workspace.yaml` at the checkout root AND at least one `packages/*/package.json` must exist for the `pnpm -r --filter` half to fire.

**Command string**:
```sh
pnpm install && if [ -f pnpm-workspace.yaml ] && ls packages/*/package.json >/dev/null 2>&1; then pnpm -r --filter './packages/*' build; fi
```

**Rationale**:
- Directory-presence alone (`fs.existsSync('packages')`, Q3→A) misses the "empty-`packages/`" transition case a scaffold or a mid-refactor repo hits.
- `packages/*/package.json` alone (Q3→B) still lets `pnpm -r` die on a repo whose `pnpm-workspace.yaml` is absent (which is required for `pnpm -r` to enumerate at all).
- `pnpm-workspace.yaml` alone (Q3→C) misses the case where the file exists but the `packages/` directory is empty — the filter still matches zero projects and pnpm exits non-zero.
- Both together answer the actual question: "will `pnpm -r --filter './packages/*' build` match at least one project?" Yes iff both conditions hold.

**Shell details**:
- `[ -f pnpm-workspace.yaml ]` is POSIX and works in `dash`, `bash`, `sh`.
- `ls packages/*/package.json >/dev/null 2>&1` — the glob is expanded by the shell; if zero files match, `ls` errors and exits non-zero, which the `if` catches. `2>&1` suppresses the "No such file" complaint on the terminal.
- The `if … fi` swallows the failure signal — even if the build half fails for a *legitimate* reason inside a real monorepo, that's already covered by the (unchanged) existing behavior: the outer `pnpm install && …` chain fails and `installResult.success === false` triggers the FR-003 evidence block.

**Alternative rejected**: use `test -e packages/*/package.json`. Rejected because `test -e` with a shell glob resolves to `-e` on the first match (or the literal `packages/*/package.json` when unmatched), which is behavior-dependent on shell nullglob settings. `ls` + redirect is portable and unambiguous.

## Decision 4 — Gap B: where the evidence lives on the GitHub issue (Q2→A resolved)

**Chosen**: append to the existing stage comment (the one `StageCommentManager` already edits).

**Rationale**:
- Cockpit `failed:*` classification (`packages/cockpit/…`) reads the stage comment. Adding text inside the comment it already reads is free.
- A sibling comment (Q2→B) with an HTML marker `<!-- generacy-stage:failure -->` accumulates across retries — the "trail of failures" would be unbounded, and cleaning it would need a new deletion pass.
- The hybrid (Q2→C) is two surfaces + a synchronization rule — more mechanism than the problem warrants.
- GitHub preserves comment edit history. If archaeology is needed for a repeatedly-failing issue, the API returns prior revisions.

## Decision 5 — Gap B: stderr-tail bounding order and marker text (Q4→A + B's marker resolved)

**Chosen**: take last 30 lines → if >4 KiB truncate from the *start* → prepend marker.

**Command flow**:
1. `lines = raw.split('\n')` → `last30 = lines.slice(-30).join('\n')`.
2. If `Buffer.byteLength(last30) ≤ 4096` → return `last30` as-is (no marker).
3. Else: keep the last 4096 bytes of `last30` (truncate-from-start), prepend `… truncated (kept last <N> lines / 4096 bytes) …\n`.

**Rationale (Q4→A)**:
- Newest bytes at the bottom matches terminal-reading habits — a developer scrolling the failed comment reads "recent" downward.
- Truncation-from-start (keep last N bytes of last 30 lines) preserves the freshest failure output, which is where the actionable signal lives (typically the last 1-3 lines of a build failure name the stuck step).
- The alternative ordering (Q4→B, "last 4 KiB then last 30 lines") produces a different tail when lines are long: e.g., a 1 KiB single-line stack trace + 29 short lines might get *fully* included under B but partially truncated under A. A's ordering is more consistent — 30 lines is always the outer bound.

**Rationale (marker text — B's richer wording)**:
- `… truncated (kept last N lines / M bytes) …` is self-describing. A developer skimming the block knows immediately what's above and how much was cut.
- Q4→A's plain `… truncated …` is too terse — the counts are trivially cheap and materially help debugging.
- Marker-at-top means the reader knows they're seeing a tail *before* they start reading — better than trailing markers.

## Decision 6 — Gap B: timeout/abort evidence (Q5→A resolved)

**Chosen**: uniform full evidence block for all failure modes, with a synthesized `exitDescriptor`:
- Numeric exit: `exit <N>`
- Timeout: `killed (SIGTERM) after <Nms>`
- Abort: `aborted`

Empty stderr renders as the literal `(stderr empty)`.

**Rationale**:
- Timeouts are *hangs*, and the stderr tail is often the single most diagnostic artifact for a hang — the last line names the stuck step (`Compiling…` / `Running suite X…`). Q5→B (top-line only) throws that away.
- Aborts (operator SIGTERM) may have benign stderr, but the block is harmless and occasionally useful ("what was in flight when the operator pulled the cord?"). Q5→C's split-by-cause is two renderers for one block.
- The synthesized descriptor lets the block have a stable shape — the reader always sees `**Exit**: <descriptor>` on one line, no conditional "if this is a timeout, look for a different field."
- Detection uses `PhaseResult.error.message` (already `Phase "…" timed out after Nms` / `Phase "…" was aborted` from `cli-spawner.ts:240–244`) — no new `PhaseResult` fields.

## Decision 7 — do NOT add new fields to `PhaseResult`

**Chosen**: `PhaseResult` interface (`types.ts:122`) is unchanged.

**Rationale**:
- Everything the evidence block needs is already in `PhaseResult.error.{message, stderr}` and `PhaseResult.exitCode`.
- Adding a `timedOut: boolean` / `aborted: boolean` flag would duplicate what's already parseable from `error.message`.
- Widening `PhaseResult` widens the blast radius of the change — every reader (result-reporter, WorkflowState store, telemetry) would need to know about the new fields. The evidence block is a rendering concern; it lives in the renderer's input type (`StageCommentData`), not in the domain result type.

**Alternative rejected**: add `command: string` to `PhaseResult`. Rejected because the command string is available at the phase-loop callsite (`config.validateCommand`, `config.preValidateCommand`, the CLI phase name) — no need to duplicate it into the result.

## Decision 8 — evidence-block rendering placement

**Chosen**: render the block *after* the existing `**PR**` line (or after `**Completed**` when no PR), inside the same stage comment, gated by `data.status === 'error'` + presence of `data.errorEvidence`.

**Rationale**:
- Placing it *after* the summary metadata keeps the progress table visible above the fold and pushes the (verbose) evidence below.
- Wrapping stderr in `<details><summary>` collapses the tail in the GitHub UI while keeping it copyable — a good compromise for the ~4 KiB block.
- Fenced code block (```` ```text ```` ) preserves whitespace and prevents markdown re-parsing of stack-trace characters (`_`, `*`, `#`).

## References

- Spec: `specs/847-found-during-cockpit-v1/spec.md`
- Clarifications: `specs/847-found-during-cockpit-v1/clarifications.md`
- Cockpit v1 smoke test finding #15 (source of this issue).
- Sibling completed epics with similar shape:
  - `#822` — evidence-into-stage-comment pattern for another failure surface.
  - `#841` — pure-function bounding + fuzz test structure (reference implementation).
  - `#845` — CLI-side fix conforming to an existing orchestrator invariant.
- Source files (verified 2026-07-08):
  - `packages/orchestrator/src/worker/config.ts:59, :98–116` — default + override merge.
  - `packages/orchestrator/src/worker/phase-loop.ts:154–176, :210–224, :304–342, :355–411` — 3 error sites.
  - `packages/orchestrator/src/worker/stage-comment-manager.ts:119–157` — renderer.
  - `packages/orchestrator/src/worker/cli-spawner.ts:220–252` — `PhaseResult.error` construction.
  - `packages/orchestrator/src/worker/types.ts:122–148, :187–205` — `PhaseResult` + `StageCommentData`.
