# Research: `generacy cockpit watch` + `status`

Phase 0 research and decisions for #787. Each entry records the option considered, the choice made, and the rationale that ties back to the clarifications and the existing codebase.

## R1: Polling vs streaming for `watch`

**Decision**: Polling loop over `gh search issues --json`, interval flag with default `5000 ms`.

**Alternatives considered**:
- **GitHub webhooks** — would give push-based transitions, no poll cost. Rejected: webhook delivery requires a public endpoint and the cockpit is intended to run inside a cluster or on a contributor's laptop. The orchestrator already runs a webhook receiver for PR feedback, but that's tied to a single repo and uses an installation token; reusing it for the cockpit would couple `watch` to the orchestrator's lifecycle. The "pure sensor" framing in the spec ("no mutations") implies it can also run standalone, which a webhook approach forecloses.
- **GitHub GraphQL subscriptions** — none exist for issue/PR state. The Events API is poll-only.
- **`gh api -X GET /repos/{O}/{R}/events` long-poll** — limited to 100 events / 90 days; misses the "every transition" guarantee.

Polling at 5 s default keeps the design simple and matches what Claude Code's `Monitor` tool expects: one process producing NDJSON lines, the tool reads each line as it arrives. The `--interval` flag lets operators tune for cost vs latency (1 s is fine for short tasks; 30 s for long-running queues).

## R2: NDJSON vs JSON-array output for `watch`

**Decision**: NDJSON (one JSON object per line, `\n`-delimited).

**Rationale**: Q2 pins the field set but not the wire format. NDJSON is the standard for streaming logs and is what `Monitor` consumes natively. JSON-array would require a closing `]` that never arrives (the watch loop runs until SIGINT) — invalid JSON in any consumer. NDJSON also pipes cleanly to `jq -c` and `tee`.

Reference: `Monitor` tool documentation in `claude-code` describes the wire format as "one JSON object per line, terminated by `\n`, no trailing whitespace".

## R3: `chalk` vs custom ANSI vs no-color

**Decision**: Add `chalk` ^5 as a runtime dependency on `@generacy-ai/generacy`. Gate on `process.stdout.isTTY && !options.json`.

**Alternatives considered**:
- **Hand-rolled ANSI escapes** — five colors (red/yellow/cyan/green/dim) is small enough to do by hand. Rejected: terminal capability detection is non-trivial (Windows ConEmu, CI runners with TERM=dumb, etc.) and chalk already handles it. The added dep is ~10 KB; trivial in CLI context.
- **`kleur` / `colorette`** — both smaller than chalk, ESM-friendly. Chalk wins on familiarity and ecosystem (every codebase contributor has used it; both alternatives are niche). The size difference is irrelevant for a CLI bundle.
- **No color at all** — rejected by Q4 (option C wins).

`chalk@5` is ESM-only, which matches `@generacy-ai/generacy`'s `"type": "module"`. No additional config needed.

## R4: Pagination via `gh search issues` cursoring

**Decision**: Loop `listIssues` with the foundation's existing `limit` option, advancing via a `created:<ISO` predicate appended to the search query. Stop when a page returns fewer than the requested `limit`.

**Rationale**: `gh search issues` does not expose a true cursor — it accepts a search predicate, which can include `created:<2026-06-26T12:00:00Z`. The pagination loop:
1. Issue the query with `limit=100`.
2. If the response has 100 items, find the minimum `createdAt` and re-issue with `query + " created:<" + min(createdAt)`.
3. Continue until a page returns < 100.

`Issue` does not currently carry `createdAt`. **Sub-decision**: add `createdAt: string` to the `Issue` shape in `packages/cockpit/src/gh/wrapper.ts` (small addition, in the same cross-issue surface as the two new methods). Update the schema and parser.

**Alternative considered**: Switch to `gh api graphql` with proper cursoring. Rejected: doubles the surface area of the gh wrapper and requires `gh` to be authenticated against the GraphQL API explicitly. The `created:<` workaround is good enough for the v1 scale envelope, and Q5's safety-cap warning catches the edge cases.

## R5: Where to put `resolveIssueToPR` / `getPullRequest`

**Decision**: Add to `packages/cockpit/src/gh/wrapper.ts`. Per the spec's cross-issue note: defined once in the foundation, reused by #787 and #789, whichever PR lands first owns the addition. Re-exported from `packages/cockpit/src/index.ts`.

**Rationale**: Both methods are pure thin wrappers over `gh ... --json`. They have no consumer-specific logic and belong with the other read-only wrappers (`listIssues`, `getPullRequestCheckRuns`). Putting them on the generacy CLI side would force #789 (a separate consumer) to either duplicate or peek into another package's internals.

The "whichever lands first owns the addition" framing in the spec is a coordination mechanism — once landed, the second PR (787 or 789, whichever is later) drops the duplicated declaration from its own diff. No code change is needed in the second PR; it just imports from the foundation.

## R6: Orchestrator footer — soft-fail or hard-fail?

**Decision**: Soft-fail. Footer always renders; unavailable orchestrators show `"(unavailable — <reason>)"`.

**Rationale**: The cockpit is a read-only observability tool. Operators run `status` to see the state of the world — including "the orchestrator is down". Failing the entire `status` command because the orchestrator's `/health` 503'd would be exactly the wrong behavior; it converts a meaningful signal into an opaque CLI error.

D7 in #786's plan already commits the foundation's `OrchestratorClient` to never-throw semantics. This decision is the consumer-side enforcement of that contract: the footer wrapper catches its own timeout and degrades.

Default timeout: `1500 ms`. Picked to match the existing `executeCommand` timeout convention in `cli/utils/exec.ts`; long enough for a slow local socket round-trip, short enough that operators don't think `status` hung.

## R7: Status output format — single table vs grouped tables

**Decision**: With `--epic`, single table grouped by phase (if the manifest declares phases) or flat by issue number (if not). Without `--epic`, grouped by repo with a header row per repo.

**Rationale**: Q1 says "grouped in `status` output; not used as a filter in `watch`". Q4 specifies `padEnd` + chalk but doesn't pin the grouping. The phase grouping in epic mode aligns with how operators think about epic progress ("plan is done, implementation is active, manual-validation is waiting") — and the foundation already exposes `EpicManifest.phases[]` for that grouping. Repo grouping in repos-mode matches how cluster operators monitor multi-repo activity.

The grouping logic lives in `status/group.ts` (pure function from `StatusRow[]` + scope kind to grouped rows). Testable in isolation.

## R8: How `watch` distinguishes issues from PRs

**Decision**: Inspect `issue.url`: contains `/pull/` → PR; contains `/issues/` → issue. Fallback to `issue.labels` containing `type:pr` if URL is malformed (defense in depth).

**Rationale**: `gh search issues` returns both issues and PRs (PRs are issues in GitHub's data model). The cheapest discriminator is the URL — every PR's `url` is `https://github.com/{O}/{R}/pull/{N}`, every issue's is `/issues/{N}`. No extra API call required.

The label check is a backstop: if for some reason a PR were returned with a malformed URL, the `type:pr` label (added by the workflow engine's label sync) would still identify it. Both paths produce `kind: 'pr'` in the snapshot.

## R9: Should `watch` emit on first poll?

**Decision**: **No**. The first poll establishes the baseline; no transitions are emitted because there's no `prev` to compare against.

**Rationale**: This matches operator expectations. When you start `watch`, you're saying "tell me what changes from now on", not "dump the current state". The `status` verb is the right tool for current-state snapshot.

Sub-decision: the watch loop logs a single stderr line on startup (`"cockpit: watching N issues, M PRs across K repos; emitting on transition"`) so the operator knows it's working. This is not on stdout (which is reserved for NDJSON events).

## R10: Test fixtures for SC-002 (10-step phase walk)

**Decision**: `__tests__/fixtures/phase-walk.json` containing 10 sequential poll-response payloads from a scripted `GhWrapper`. The test asserts:
- Each poll produces exactly the expected `events[]` (event count + per-field equality).
- The 10 transitions sum to the full phase progression: `pending → plan → waiting-for:plan-review → implement → waiting-for:implementation-review → ... → terminal`.

This is the SC-002 acceptance test ("100% of transitions in a 10-step manual phase walk"). The fixture is the single source of truth for what "transition" means at the wire level.

## Sources

- **Spec.md**: feature description, Q1–Q5 answers, cross-issue note about `resolveIssueToPR`/`getPullRequest`.
- **Clarifications.md**: detailed rationale for each clarification answer.
- **#786 plan.md and data-model.md**: foundation surface (classifier, config loader, gh wrapper, orchestrator client). Adopted unchanged.
- **`packages/generacy/src/cli/commands/status/index.ts`**: existing `--json` + plain-text rendering precedent for the cluster status command. The cockpit status verb mirrors its structure.
- **`packages/generacy/src/cli/commands/launch/index.ts`**: existing pattern for a multi-file command directory with `index.ts` + helpers. The cockpit verbs adopt the same layout.
- **`packages/cockpit/src/gh/wrapper.ts`**: existing gh wrapper. New methods follow the same `executeCommand` + zod-validate pattern.
- **Claude Code Monitor tool**: NDJSON wire format ("one JSON object per line, terminated by `\n`").
