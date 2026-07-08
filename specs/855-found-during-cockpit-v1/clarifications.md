# Clarifications

## Batch 1 — 2026-07-08

### Q1: CheckRunSummary shape
**Context**: FR-002 says the Zod schema MUST replace `conclusion` with `bucket`. Today `CheckRunSummary` (interface in `wrapper.ts:18`) already carries a normalized `state` (`SUCCESS | FAILURE | PENDING | NEUTRAL | SKIPPED | CANCELLED`) — the `conclusion?` field is not read by rollup/classify, only by `review-context-json.ts:56` which passes it through opaquely. The choice is whether `bucket` becomes a passthrough field on the summary or is fully absorbed into `state`.
**Question**: Should the `CheckRunSummary` interface expose `bucket` as a passthrough field replacing `conclusion`, or drop the passthrough entirely and rely solely on the normalized `state` (with `review-context-json` emitting `state` alone)?
**Options**:
- A: Rename field — `CheckRunSummary` gains `bucket?: 'pass'|'fail'|'pending'|'skipping'|'cancel'` in place of `conclusion?: string`. `review-context-json` emits `bucket` alongside `state`.
- B: Drop passthrough — `CheckRunSummary` loses the raw field entirely. `review-context-json` emits only `state`. Simpler surface, but reviewers lose the un-normalized gh signal.
- C: Keep both — `CheckRunSummary` gains `bucket` AND retains a compatibility shim for existing `conclusion` consumers.

**Answer**: *Pending*

### Q2: Warn-log emission point for silent-swallow paths
**Context**: FR-005 requires a `warn`-level log where the wrapper's error is currently swallowed. The swallow sites are consumer-side (`status.ts:125-127` bare `catch { checks = 'none' }`, plus equivalent paths in `watch/poll-loop.ts` and `context.ts`). Logging inside the wrapper would fire once per failure regardless of caller; logging at each consumer catch block requires touching every callsite but lets each site add its own context (phase, epic ref).
**Question**: Should the warn log live inside the wrapper (single site, structured error thrown with metadata) or at each consumer catch block (per-callsite with local context)?
**Options**:
- A: Wrapper-level — `getPullRequestCheckRuns` logs `warn` on failure (structured: `{ repo, prNumber, ghStderr }`) via an injected logger, then rethrows. Consumers keep their bare catches.
- B: Consumer-level — each swallow site (status, watch, context) grows a `catch (err) { logger.warn(...); checks = 'none' }`. Wrapper stays log-free.
- C: Both — wrapper logs `debug`, consumer logs `warn` on catch.

**Answer**: *Pending*

### Q3: CI drift test location and gh availability
**Context**: FR-006 requires a CI-tier test invoking the real pinned `gh` binary. Existing cockpit tests are vitest under `packages/cockpit/src/__tests__/` running with `pnpm test`. `gh` is not currently declared as a test-time dependency in the package. Placement/framework choice affects how the test opts out gracefully on developer machines without `gh`.
**Question**: Where should the drift test live and how should it handle `gh` availability?
**Options**:
- A: Vitest in `packages/cockpit/src/gh/__tests__/json-field-drift.test.ts`, using `describe.runIf(hasGhBinary)` — skipped locally when `gh` is missing, run in CI where the workflow ensures `gh` is present. Simple and colocated with the wrapper.
- B: Separate CI-only job in `.github/workflows/`: bash script that greps `--json` sites and invokes `gh` directly. Fully outside the vitest suite; no local run.
- C: Vitest test that fails hard if `gh` is missing (no runIf gate). CI already ships gh 2.x on ubuntu-latest runners; forces devs to install it locally too.

**Answer**: *Pending*

### Q4: Static extraction technique for `--json` field lists
**Context**: FR-007 says extraction MUST be static (grep or AST scan) so new wrapper methods are auto-covered. Today's 13 sites all use literal string args (e.g., `'name,state,bucket,link'` on a line following `'--json',`). Grep of a `--json`-adjacent string is trivial. AST would future-proof against dynamic composition (e.g., `--json ${fields.join(',')}`), but that pattern doesn't exist today.
**Question**: Should extraction use a literal-string grep (fast, no build-time deps) or an AST walk over `wrapper.ts` (handles future dynamic field lists but adds `ts-morph` or equivalent)?
**Options**:
- A: Grep — regex over `wrapper.ts` for the `'--json',\n\s+'<literal>'` pattern. Fail the test on any non-literal follow-up (forces authors to keep field lists literal).
- B: AST — parse `wrapper.ts` with `ts-morph`, walk `CallExpression` args to `runner.run('gh', [...])`, collect literal string args following `'--json'`. Handles concatenation, `.join(',')`.
- C: Grep now, upgrade to AST if a dynamic case ever appears.

**Answer**: *Pending*

### Q5: `CheckRunSummary.url` field rename
**Context**: FR-004 says consumers "MUST reference `link` (not `detailsUrl`)". Today `CheckRunSummary` exposes the field as `url` (interface in `wrapper.ts:22`), and `parseCheckRuns` maps `raw.detailsUrl ?? raw.link` → `url`. Consumers in `context.ts`, `required-checks.ts`, and `review-context-json.ts` all read `.url`. If we interpret FR-004 literally, `CheckRunSummary.url` becomes `CheckRunSummary.link` — a rename touching every consumer. If we interpret it as "wrapper-level mapping from `link`", the outward field name stays `url`.
**Question**: Should `CheckRunSummary`'s outward field name change from `url` to `link` (rename all consumers), or stay `url` with the wrapper mapping from raw `link`?
**Options**:
- A: Keep `url` — outward field stays `url`; wrapper maps from raw `link`. Minimal churn; matches existing consumer code.
- B: Rename to `link` — outward field becomes `link`; every consumer updates. Matches FR-004's literal wording.

**Answer**: *Pending*
