# Research: `gh pr checks` field-list fix + `--json` drift guard (#855)

## Problem Restatement

`getPullRequestCheckRuns` at `packages/cockpit/src/gh/wrapper.ts:597–610` invokes `gh pr checks --json name,state,conclusion,detailsUrl`. Two of those field names (`conclusion` and `detailsUrl`) have never existed on `gh pr checks --json`. `gh` validates the field list **client-side, before any network hop**, so the call fails on every gh version, every invocation — regardless of auth, network, or repo permissions.

`gh 2.96.0` `--json` help lists exactly these fields on `pr checks`: `bucket, completedAt, description, event, link, name, startedAt, state, workflow`. `conclusion` is REST / `gh run` vocabulary. The URL field is `link`.

Blast radius (verified via grep of `getPullRequestCheckRuns` call sites):

- `packages/generacy/src/cli/commands/cockpit/merge.ts:139` — bubbles (hard fail; blocks every merge).
- `packages/generacy/src/cli/commands/cockpit/status.ts:123` — bare `catch { checks = 'none' }` (silent — this is the week-old blank-column observation).
- `packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts:98` — bare `catch { checks = [] }` (silent).
- `packages/generacy/src/cli/commands/cockpit/context.ts:285` — `try { … }` around the `Promise.all` bubbles to `throw new CockpitExit(1, …)` (semi-hard — user sees `gh pr detail: …` even though the failing call is `pr checks`).

Why tests never caught it: `packages/cockpit/src/__tests__/gh-wrapper.test.ts:196–210` — the positive fixture answers with `{ name, state, conclusion, detailsUrl }`. The `CommandRunner` mock never invokes the real `gh` binary, so gh's client-side rejection is invisible. Same pattern as #800/#826/#836/#853, but with `gh`'s interface as the drifted contract.

Live repro (spec Assumption #2, verified 2026-07-08): `gh pr checks 999 --repo octocat/hello-world --json conclusion` → exit 1, stderr `Unknown JSON field: "conclusion"`, no network hop.

## Evidence

### Root-cause site (source-verified 2026-07-08)

- `packages/cockpit/src/gh/wrapper.ts:605` — `'name,state,conclusion,detailsUrl'`. This is the whole bug.
- `packages/cockpit/src/gh/wrapper.ts:162–164` — Zod raw schema still tolerates `conclusion?` and `detailsUrl?`, because the parser was written to consume what gh was assumed to return.
- `packages/cockpit/src/gh/wrapper.ts:487–492` — `parseCheckRuns` maps `raw.conclusion ?? undefined` and `raw.detailsUrl ?? raw.link`, defensive-coding a field that gh has never surfaced.
- `packages/cockpit/src/gh/wrapper.ts:303–327` — `normalizeCheckState` handles the vocabulary set `SUCCESS|PASS|FAIL|FAILURE|PENDING|IN_PROGRESS|QUEUED|NEUTRAL|SKIPPED|SKIPPING|CANCELLED|CANCELED`. Missing: `CANCEL` (which is exactly what `bucket` returns for cancelled runs, per gh 2.96.0). Trivial one-liner add.

### `gh` schema surface (verified against 2.96.0)

Direct verification: `gh pr checks --help | grep -A20 '\-\-json'`. Output (edited to the relevant snippet):

```
Specify one or more comma-separated fields for `--json`:
  bucket
  completedAt
  description
  event
  link
  name
  startedAt
  state
  workflow
```

`state` values: `SUCCESS`, `FAILURE`, `PENDING`, `SKIPPING`, `CANCELLED` (per gh source).
`bucket` values: `pass`, `fail`, `pending`, `skipping`, `cancel` (per gh source — coarser rollup of `state`).

Both are on-the-wire-safe for our rollup semantics. `bucket` is preferred for the merge / rollup path because its vocabulary is purpose-built for exactly this decision.

### Downstream consumer surface

- `packages/generacy/src/cli/commands/cockpit/shared/required-checks.ts:52,62` — reads `.url`. No `.conclusion` read.
- `packages/generacy/src/cli/commands/cockpit/shared/review-context-json.ts:53–58` — emits `conclusion` opaquely (dead-on-arrival: nothing has ever populated it). Also emits `url`. Deleting `conclusion` from the emit is source-compatible.
- `packages/generacy/src/cli/commands/cockpit/watch/check-rollup.ts:9–24` — reads only `.state`. Unaffected.
- All test files under `packages/generacy/src/cli/commands/cockpit/__tests__/` — use only `state` in assertions. Some fixture builders include `conclusion` in the return shape (`helpers/fake-gh.ts`, `merge.test.ts` `getPullRequestCheckRuns` fixture arrays) — these are audited and cleaned in the same PR, but no assertion changes.

Grep verifies (2026-07-08): the only production read of `.conclusion` is in `review-context-json.ts` (spec Assumption #3 confirmed).

## Decision 1 — `CheckRunSummary` outward shape (Q1)

**Chosen**: **B** — drop the `conclusion` passthrough entirely.

**Rationale**:
- The `conclusion` field was dead-on-arrival: gh has never populated it (client-side rejection), so no consumer has ever seen a non-`undefined` value. Preserving surface nobody has used is not backwards-compat, it's cargo-cult.
- Replacing `conclusion?: string` with `bucket?: 'pass'|'fail'|'pending'|'skipping'|'cancel'` (option A) would add a new passthrough that carries the same signal as the normalized `state`, forcing every consumer to either ignore it or write conditional logic mixing two overlapping vocabularies. `bucket` inside the wrapper is a purpose-built rollup input to `normalizeCheckState`; outside the wrapper, `state` is the semantic name.
- Option C (keep both, add a compatibility shim) writes migration code for consumers of a field that has never had a value. Rejected on absurdity.
- `bucket` stays inside `parseCheckRuns` as a `normalizeCheckState` input. The outward interface is `{ name, state, url? }`.

**Alternative rejected**: A (rename `conclusion` to `bucket` on the outward interface) — see above. C (keep both) — see above.

## Decision 2 — Where the `warn` log fires (Q2)

**Chosen**: **A** — wrapper-level warn with structured fields, injected logger, rethrow.

**Rationale**:
- Consumer-level (option B) requires touching every current and future silent-swallow site. Wrapper-level requires touching one site.
- The exact fields an operator needs on the "checks column blank" incident are: which repo, which PR, and gh's error text. All three are known to the wrapper without any consumer help. Threading them from three consumers via three separate catch blocks is churn for zero information gain.
- Silent consumer catches stay in place. Their visible symptom (`- / none`) is unchanged — but the wrapper log line is now the operator's leading indicator. `watch` warns once per poll per PR when gh is broken: honest noise about a real ongoing failure, which is precisely what this smoke test lacked.
- Rethrow (not swallow) preserves `merge`'s hard-fail behavior. The wrapper is transparent to callers about the exception; it only adds a log side effect before rethrowing.
- Option C (wrapper `debug`, consumer `warn`) requires the consumer touch anyway, and hides the wrapper log at the default log level — losing the smoke-test signal.

**Chosen shape**:

```ts
this.logger.warn(
  { repo, prNumber, ghStderr: result.stderr.trim() },
  'gh pr checks failed',
);
throw new Error(`gh pr checks failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
```

The injected logger interface is minimal (`{ warn(obj, msg): void }`) to avoid a hard `pino` dependency at the wrapper layer. Default is a `console.warn` shim.

## Decision 3 — Drift test placement (Q3)

**Chosen**: **A** — colocated vitest at `packages/cockpit/src/gh/__tests__/json-field-drift.test.ts`, gated by `describe.runIf(hasGhBinary)`.

**Rationale**:
- Placement colocated with `wrapper.ts` (option A) means the guard travels with the code it guards. A future contributor renaming or restructuring the wrapper will see the neighbor test; a workflow file (option B) would not travel.
- `describe.runIf(hasGhBinary)` gate lets the suite skip visibly on dev machines without `gh` (an idiomatic vitest pattern) and run in CI where the workflow provisions `gh`. No forced-hard-fail (option C), no maintenance of a separate workflow file (option B).
- The pinned vitest version in `packages/cockpit` is ≥1.6, which supports `.runIf`. Fallback: `describe.skipIf(!hasGhBinary)` — semantically identical.
- `hasGhBinary` = `spawnSync('gh', ['--version']).status === 0`, evaluated once at module load. Any thrown error from `spawnSync` (ENOENT) is treated as "gh absent" and the suite skips.
- The new `__tests__/` directory under `packages/cockpit/src/gh/` is picked up by `vitest.config.ts`'s default `**/*.test.ts` glob — verified.

**Alternative rejected**: B (bash script in `.github/workflows/`) splits the guard from the code and stops running under the local `pnpm test` entry point. C (unconditional gh dependency) forces dev-machine friction for one test.

## Decision 4 — Static extraction technique (Q4)

**Chosen**: **A** — literal-string grep with hard failure on non-literal `--json` follow-ups.

**Rationale**:
- All 13 current call sites use literal string args. Grep is one regex; AST (option B) is a `ts-morph` (or equivalent) dependency for a case that doesn't exist.
- The failure mode on a non-literal is a feature, not a limitation: a dynamic field list can't be statically validated at all, so making the drift suite fail on it doubles as a lint keeping the field lists in the statically-checkable form forever. Option C ("grep now, upgrade to AST if needed") loses the enforcement half and permits the dynamic form silently.
- Regex form: `/'--json',\s*\n\s*'([^']+)'/g`. Every current call site matches. If a future call site formats differently (single-line, template literal, `.join`), the extractor's `matchesFound < 'foundLiteralJsonKeywords'` check fires with the exact line, forcing a reformat or extractor tweak. Both are cheap.
- The extractor also validates: every `'--json',` occurrence in the file must have a matching capture. Any unmatched `'--json',` fails a synthetic test with the offending line number.

**Alternative rejected**: B (AST) — new dep for hypothetical use case. C (grep-then-upgrade) — no enforcement.

## Decision 5 — `CheckRunSummary.url` field name (Q5)

**Chosen**: **A** — outward field name stays `url`; wrapper maps `raw.link` → `url`.

**Rationale**:
- `url` is our domain vocabulary; `link` is gh's quirk. The wrapper's job is to translate the quirk into the domain vocabulary.
- FR-004's literal wording ("consumers must reference `link` not `detailsUrl`") is a wrapper-boundary concern about the raw-schema field name, not the outward interface field name.
- Option B (rename to `link`) forces `required-checks.ts`, `context.ts`, `review-context-json.ts`, and every fixture to update for zero information gain.

**Alternative rejected**: B (rename) — churn without benefit.

## Decision 6 — `normalizeCheckState` extension for `bucket`

**Chosen**: extend `normalizeCheckState`'s switch with `case 'CANCEL': return 'CANCELLED'`.

**Rationale**:
- gh's `bucket` vocabulary is `pass`, `fail`, `pending`, `skipping`, `cancel`. Upper-cased, four already match existing switch cases (`PASS → SUCCESS`, `FAIL → FAILURE`, `PENDING → PENDING`, `SKIPPING → SKIPPED`). Only `CANCEL` is missing.
- Alternative: pre-map `bucket` values to gh's `state` vocabulary in the raw parse (`bucket === 'cancel' → 'CANCELLED'`) before calling `normalizeCheckState`. Rejected as one extra layer of translation for one value. Adding the case to the existing switch is one line.
- `normalizeCheckState` already reads `raw.state ?? raw.bucket ?? raw.status`. When `state` is present (as it is with the fixed field list), the state vocabulary wins and `bucket` never enters the switch. The `CANCEL` case only fires in the edge case where gh's `state` is absent but `bucket` is present. Defensive but zero-cost.

## Decision 7 — Where NOT to fix

- **Consumer degrade behavior in `status.ts` / `watch/poll-loop.ts` / `context.ts`** — kept. Refactoring these to warn or error at the consumer level is Out-of-Scope per spec. The wrapper log line is now the operator's leading indicator; consumer catches remain the fallback UX.
- **`resolver.ts` / `queue.ts` wrapper instantiations** — kept without logger threading. Follow-up out-of-scope; the default `console.warn` shim gives fail-loud behavior everywhere until proper logger injection lands.
- **AST / `ts-morph` for extraction** — declined (Q4→A). Grep + enforcement is the correct forward-compat stance.
- **Field-name rename `url` → `link`** — declined (Q5→A). Wrapper-boundary vocabulary translation.
- **Removing `raw.detailsUrl` from the Zod schema tolerance** — actually part of the fix (the passthrough-tolerant `.passthrough()` on `CheckRunRawSchema` covers it either way; we drop the explicit `detailsUrl` / `conclusion` field declarations too, since keeping them in the schema signals intent to consume them). This is a source cleanup, not a behavior change.

## Decision 8 — What the drift suite tests (not just extracts)

The drift suite's assertion is a single `regex` check per field list:

```
!/unknown json field/i.test(spawnSyncResult.stderr)
```

**Rationale**:
- gh's client-side validator emits exactly `Unknown JSON field: "foo"` on rejection. That's the failure mode #855 is about.
- We deliberately do NOT assert exit code 0 — a valid field list can still exit non-zero for auth / network / not-found reasons (which is what a dummy PR number produces). We only care that gh didn't reject the field list itself.
- We deliberately do NOT assert on stdout content — the point of the test is contract validation, not data validation. Fixtures cover data shape.
- Each spawn has a 5s timeout as a defensive backstop. Client-side validation returns in ~30ms in practice.

## References

- Spec: `specs/855-found-during-cockpit-v1/spec.md`
- Clarifications: `specs/855-found-during-cockpit-v1/clarifications.md`
- Sibling regressions (tests-encode-the-bug pattern): #800, #826, #836, #853
- gh CLI `--json` docs (authoritative): `gh pr checks --help` output on gh 2.96.0
- gh CLI source (bucket vocabulary): [github.com/cli/cli — pkg/cmd/pr/checks/checks.go](https://github.com/cli/cli/blob/trunk/pkg/cmd/pr/checks/checks.go)
- Related incident logs: `generacy-ai/tetrad-development#88` (cockpit v1 smoke test, finding #20)
- Live repro (auth-free): `gh pr checks 999 --repo octocat/hello-world --json conclusion` → `Unknown JSON field: "conclusion"`
