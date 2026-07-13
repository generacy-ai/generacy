# Research: Single-source epic discovery (G-S2)

## Decision 1 — Ref shape recognizer set

**Decision**: Accept three shapes and normalize all three to `owner/repo#N`:

1. Bare: `owner/repo#N`
2. Markdown-linked: `[owner/repo#N](…)` and `[#N](https://github.com/owner/repo/issues/N)`
3. Plain URL: `https://github.com/owner/repo/issues/N` (and `/pull/N` — GitHub cross-links issues and PRs on the same number)

**Rationale** (Q3): Real epic bodies mix all three shapes; a checkbox line containing a URL that silently vanishes from the watch set is exactly the rev-3 failure mode. Same-repo `#N` shorthand stays excluded because cross-repo epics make it ambiguous (this is the wrong-repo bug class from generacy#801).

**Alternatives considered**:

- Bare-only (strict) — rejected: silent drop of legitimate refs.
- Bare + shorthand `#N` — rejected: reintroduces the #801 wrong-repo bug.

**Ref-shaped lines the resolver can't resolve** (e.g., bare `#N` under a phase heading) → loud stderr warning naming the file, line number, and content (FR-003). Not thrown, because one malformed bullet shouldn't kill the whole epic.

## Decision 2 — Heading detection

**Decision**: Only `### ` (h3) headings count as phase headings. Level-2 (`## `) headings are treated as sectioning and ignored. Level-4+ (`#### `) headings terminate the current phase.

**Rationale**: Matches the spec wording ("grouped under `### <phase>` headings") and the current epic body convention (see the referenced tetrad-development#85 body, which uses h3 for phase headings and h2 for larger sections like "Phases" or "Notes"). Anything looser risks classifying prose sub-headings as phases.

## Decision 3 — Phase-heading match rule

**Decision**: Case-insensitive match of the first whitespace-or-punctuation-delimited token after `### ` (FR-005, Q5). Punctuation includes `—`, `-`, `:`, `,`, `.`, `/`, and standard whitespace.

**Rationale**: Real headings look like `### S2 — single-source discovery` or `### P3: implement`. Requiring the operator to type the em-dash tail is user-hostile. Ambiguous tokens (matches >1 heading) → loud exit-2 error listing the candidate headings.

## Decision 4 — Reading the epic body

**Decision**: Use `gh issue view --json body,title,state --repo <owner/repo> <N>` via the existing `GhWrapper.getIssue()` seam. Add `getIssue` only if it doesn't exist; otherwise reuse `listIssues` filtered to number.

**Rationale**: The wrapper already speaks `gh` via `nodeChildProcessRunner`, so no new runtime dep. GraphQL would give one round-trip for both body + labels, but body is all we need for resolution — the per-repo listing that follows already fetches the labels and state.

**Alternatives**: GraphQL (`gh api graphql`) — rejected: extra query complexity without payoff.

## Decision 5 — Watch loop re-resolution cadence

**Decision**: Call `resolveEpic()` once at the top of every poll tick. No caching of the previous parse.

**Rationale** (FR-008, US2): Refs added mid-epic must appear on the next tick. Caching by body hash is a micro-optimization — parsing is O(body length) and body sizes are on the order of a few KB. On resolver error (transient `gh` failure), log to stderr and skip the tick — do not exit, and do not fall back to the previous tick's ref set (would violate SC-003's fail-loud spirit and mask GitHub outages).

## Decision 6 — Interval flag semantics

**Decision**: Default 30_000 ms, floor 15_000 ms. Below-floor → stderr warn (`cockpit watch: --interval <N> below floor 15000ms; clamping.`) + clamp + continue.

**Rationale** (FR-007, Q4): `stdout` is the NDJSON stream and must not be polluted by diagnostics. Hard-reject (exit code 2) would break scripted invocations that pass through a shared config; silent clamp would hide that the flag was ignored.

## Decision 7 — What to delete

**Decision** (FR-009): Delete rather than deprecate:

- `packages/cockpit/src/manifest/**` (schema, io, scoping)
- `packages/cockpit/src/manifest/scoping.ts:resolveEpicIssues` (the label-search fallback that produced the #801 wrong-repo hits)
- `packages/generacy/src/cli/commands/cockpit/manifest.ts` and `manifest/**`
- The `repos` field on `CockpitConfigSchema`
- The `MONITORED_REPOS` env branch in `config/loader.ts`
- The `--repos` flag on `watch` and `status`

**Rationale**: Plan rev 3 principle 1 — one mechanism. Leaving deprecated code paths behind means the next engineer's response to a resolver bug will be to re-enable the fallback. Grep-check for `manifest/` and `resolveEpicIssues` under the isolation boundary must return zero hits (SC-005).

**Alternatives**: Deprecation warnings — rejected: extends the deletion timeline and leaves a fallback path that reproduces the exact bug class the plan exists to close.

## Decision 8 — Test seam layout

**Decision**: Colocate resolver unit tests under `packages/cockpit/src/resolver/__tests__/`. Reuse the existing `MockGhWrapper` pattern for `resolveEpic` (integration-shaped test that stubs `getIssue`). CLI-level tests stay under `packages/generacy/src/cli/commands/cockpit/__tests__/`.

**Rationale**: Matches how the existing manifest tests are organized. Keeps the resolver's pure-function tests fast (no gh spawn) while giving the CLI verbs one integration test each covering the fail-loud paths.

## Sources

- Epic issue body: https://github.com/generacy-ai/tetrad-development/issues/85 (source of the current phase-heading convention).
- Bug reference: generacy#801 (cross-repo epic label-search returning wrong-repo hits).
- Bug reference: generacy-ai/tetrad-development#86 (silent-drop fallback on unparseable body — the SC-003 regression target).
- Follow-up doc alignment: generacy-ai/tetrad-development#90 (label-protocol contract shorthand policy).
