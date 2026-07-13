# Stack: #909 marker-based exclusion in clarification answer-scanner

## Language & runtime

- TypeScript, strict mode, ESM.
- Node ≥22 (existing package constraint; no change).
- No new tooling.

## Packages

- `@generacy-ai/orchestrator` — modified.
  - New file: `src/worker/clarification-markers.ts`.
  - Modified file: `src/worker/clarification-poster.ts`.
- No other packages touched. `@generacy-ai/workflow-engine` is imported (unchanged consumer of `isTrustedCommentAuthor`).

## Dependencies

- **No new dependencies** (npm or otherwise).
- The new module uses only `String.prototype.split` and `String.prototype.startsWith` — no `node:` intrinsics needed.
- The modified `clarification-poster.ts` continues to depend on:
  - `node:fs` (readdirSync/readFileSync/writeFileSync — unchanged).
  - `node:path` (join — unchanged).
  - `@generacy-ai/workflow-engine` (isTrustedCommentAuthor, tryLoadCommentTrustConfig, TrustComment, CommentTrustContext — unchanged imports).

## External integrations

- GitHub REST (via existing `github.getIssueComments`, `github.addIssueComment` on `WorkerContext`). No API surface change.
- Pino-style logger interface (`packages/orchestrator/src/worker/types.ts` `Logger`). Adds one new event name: `'clarification-answer-scanner-marker-excluded'` (FR-107) at `debug` level.

## Testing

- Vitest (existing project runner).
- Mock strategy: `vi.mock('node:fs', ...)` and `vi.mock('@generacy-ai/workflow-engine', ...)` patterns already established at `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts:15–33`.
- New file: `packages/orchestrator/src/worker/__tests__/clarification-markers.test.ts` — predicate unit tests (~80–120 LOC).
- Extended file: `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts` — new describes for the integration-seam wiring and explainer copy (~200–300 LOC).

## Configuration

- No new config, no new env vars, no new schema, no migration.
- No feature flag — this is a bug fix.

## Rollout

- Ships in a normal orchestrator release. FR-105 orders this PR **before** generacy-ai/generacy#910 (App-identity trusted on answer-scanner surface). Coordinate merge/release order at the PR level.
- No cluster-image or cluster-base companion PR needed.

## Observability

- One new debug log event: `clarification-answer-scanner-marker-excluded` with fields `commentId`, `author`, `markerPrefix`, `issueNumber`.
- Steady-state emission: ~1 line per polled clarify gate per poll interval. Debug level chosen because info would flood on healthy clusters (clarify Q5→B).
- Structured JSON — grep-friendly via `jq` or `grep clarification-answer-scanner`.

## Cross-references

- **Consumer (planned, not part of this PR)**: generacy-ai/generacy#910 clarify-resume surface will import `commentCarriesQuestionMarker` from `packages/orchestrator/src/worker/clarification-markers.ts`.
- **Related patterns**:
  - `packages/orchestrator/src/worker/types.ts:90` — `STAGE_MARKERS` (separate posting-marker family, unchanged).
  - `packages/orchestrator/src/worker/clarification-poster.ts:163` — `MARKER_PREFIX` (separate posting-marker constant, unchanged).
  - `packages/orchestrator/src/worker/clarification-poster.ts:58` — `logCommentSkipped` (existing structured-log pattern that FR-107 mirrors at debug level).
