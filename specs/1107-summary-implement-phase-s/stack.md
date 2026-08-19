# Stack notes: Implement-phase product-diff guard (#1107)

Per-feature technology / dependency / integration notes (see CLAUDE.md — `/plan` does
not update CLAUDE.md, per #899).

## Packages & dependencies
- `@generacy-ai/orchestrator` (bugfix, patch): `worker/product-diff.ts`,
  `worker/phase-loop.ts`, `worker/types.ts`, `worker/claude-cli-worker.ts`,
  `services/phase-tracker-service.ts`, `server.ts`.
- `@generacy-ai/workflow-engine` (new public capability, minor):
  `actions/github/client/interface.ts` + `gh-cli.ts` — `getCurrentCommitSha`,
  `getFilesChangedByOwnCommits`.
- No new npm dependencies. Uses `ioredis` (already a worker dependency) and local `git`
  via the existing `executeCommand('git', …, { cwd })` path in `gh-cli.ts`.

## Integrations
- **Redis** (mandatory for workers, `server.ts:271-293`): persists the phase-start ref
  under `phase-start-ref:<owner>:<repo>:<issue>:<phase>` (TTL 7d) via
  `PhaseTrackerService` raw string get/set.
- **Base-merge subsystem** (#864/#914): start ref captured *after* the pre-implement base
  merge; `git log --first-parent --no-merges` excludes merge-introduced files.
- **Escalation / classifier**: reuses `no-product-code-changes` and `product-diff-error`
  reasons from #820; no new failure surface.

## Constraints
- Exclusion sets are module-level constants (no YAML / WorkerConfig; #820 Q1).
- `resolveBaseRef` shared with `base-merge.ts` — untouched (FR-005).
- Root-only exact-path exclusion (Q3 → A); FR-006 zero-tasks net deferred (Q2 → A).
