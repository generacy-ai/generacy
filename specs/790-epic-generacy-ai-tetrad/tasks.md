# Tasks: cockpit manifest init/sync verb

**Input**: Design documents from `/specs/790-epic-generacy-ai-tetrad/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/cli.md, quickstart.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = init, US2 = sync, US3 = fail-loud)

Isolation contract (FR-003, SC-005): every NEW file lives under `packages/generacy/src/cli/commands/cockpit/manifest.ts` or its sibling `manifest/` helpers folder, plus tests under `__tests__/`. The only edit outside that path is a one-line `addCommand` in `cockpit/index.ts`.

---

## Phase 1: Setup

- [X] T001 Confirm foundation API surface is available by reading `packages/cockpit/src/manifest/schema.ts`, `packages/cockpit/src/manifest/io.ts`, and `packages/cockpit/src/gh/wrapper.ts`. Verify `EpicManifestSchema`, `readManifest`, `writeManifest`, `GhCliWrapper`, `nodeChildProcessRunner`, and `Issue` are re-exported from `@generacy-ai/cockpit`. If any are missing, surface as a blocker before writing code.
- [X] T002 [P] Read sibling verb patterns to mirror: `packages/generacy/src/cli/commands/cockpit/state.ts` (--json + CockpitExit), `advance.ts` (Commander subcommand structure), `exit.ts` (CockpitExit class), `gh-ext.ts` (`createCockpitGh(runner)`), and `__tests__/fake-gh.ts` (runner stub). Catalog the import paths and the `CockpitExit` constructor signature for reuse.

---

## Phase 2: Fixtures (US1 golden test inputs)

- [X] T003 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/__tests__/fixtures/epic-cockpit-body.md` containing a representative Epic Cockpit body: a `Plan: docs/epic-cockpit-plan.md in tetrad-development (P3 / G3.1)` line, plus `### P0 — Foundation → v1`, `### P3 — Manifest → v2`, `### P4 — Hardening → v3` sections with mixed `- [ ]` / `- [x]` / `-` bullets and prose paragraphs interleaved. Covers SC-002 hand-verified diff input.
- [X] T004 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/__tests__/fixtures/epic-cockpit-expected.yaml`: the golden YAML output of `init` over `epic-cockpit-body.md`, matching the shape in `quickstart.md` lines 54–81 (epic.repo/issue/slug/plan, autonomy `{}`, three phases with tier + issues). Used by SC-002 + the init integration test.

---

## Phase 3: Pure-function helpers (parser + slug + plan extractor)

These are independent files; all `[P]`.

- [X] T005 [P] [US1] Implement `packages/generacy/src/cli/commands/cockpit/manifest/parse-epic-body.ts` — exports `parseEpicBody(body: string): ParsedEpicBody` per `data-model.md` "ParsedEpicBody" + `research.md` R3. Line-oriented walker tracking `currentPhase`; heading regex `^(##|###|####)\s+(.*)$` + inline `P\d+` (case-insensitive) + `→ vN` / `-> vN` tier matcher; bullet regex `^\s*-\s*(?:\[[ xX]\]\s*)?([A-Za-z0-9._-]+/[A-Za-z0-9._-]+#\d+)(?:\s*[—-]\s*.+)?$`; dedupe issues per phase preserving first occurrence; duplicate phase index → keep first + log warn to stderr; zero phases → throw `CockpitExit(2, ...)`. Embed `extractPlan(body)` call so the same module produces both `plan` and `phases`. No I/O, no `child_process`.
- [X] T006 [P] [US1] Implement `packages/generacy/src/cli/commands/cockpit/manifest/extract-plan.ts` — exports `extractPlan(body: string): string` per `research.md` R4 + `data-model.md` Validation rules. Regex `^Plan:\s*(.+)$` per line, strip trailing `\s+in\s+\S+`, strip trailing `\s*\(.+\)\s*$`, trim. Missing line → throw `CockpitExit(2, "Error: cockpit manifest init: epic body has no \"Plan:\" line. Add a line like 'Plan: docs/<your-plan>.md' to the epic body.")`. (Parser in T005 imports this rather than re-implementing.)
- [X] T007 [P] [US1] Implement `packages/generacy/src/cli/commands/cockpit/manifest/derive-slug.ts` — exports `deriveSlug(title: string, epicNumber: number): string` and `resolveTargetPath(opts: { manifestRoot, slug?, derivedFromTitle }): SlugDerivation` per `data-model.md` "SlugDerivation" + `research.md` R5. Algorithm: strip leading `^(Epic|EPIC):\s*`, lowercase, replace `[^a-z0-9]+` → `-`, trim `-`, collapse repeated `-`; fallback `epic-<number>` on empty. `resolveTargetPath` honors `--slug` override and returns `{ source, slug, path }`. Collision detection (file exists) is performed by the caller in T015, not here.
- [X] T008 [P] [US2] Implement `packages/generacy/src/cli/commands/cockpit/manifest/resolve-manifest-path.ts` — exports `resolveManifestPath(opts: { manifestRoot: string; epic?: string }): Promise<ManifestPathResolution>` per `data-model.md` "ManifestPathResolution" + `research.md` R9. With `epic` flag → `<root>/<epic>.yaml` (return `{ kind: 'ok', path }` if exists, `{ kind: 'not-found' }` otherwise). Without flag → `fs.readdir` for `*.yaml`; exactly one → `ok`; zero → `not-found`; multiple → `ambiguous` with sorted matches list. Pure async I/O; no `child_process`.
- [X] T009 [P] [US2] Implement `packages/generacy/src/cli/commands/cockpit/manifest/diff-phases.ts` — exports `diffPhases(parsed: ParsedEpicBody, manifest: EpicManifest): ChangeSet`, `isEmpty(c: ChangeSet): boolean`, and `applyChangeSet(manifest: EpicManifest, c: ChangeSet, parsed: ParsedEpicBody): EpicManifest` per `data-model.md` "ChangeSet" Diff + Application sections. Index extraction regex `/\bP(\d+)\b/i` for manifest phase names (fallback to display-name equality per R6 implementation note). `applyChangeSet` mutates name in place, set-diffs `issues[]` (preserve original order, append additions), inserts added phases (with `tier`, `repos: []`, `issues: []` then populated, no `autonomy`), removes vanished phases, updates `epic.plan` when changed. Never touches `autonomy` or unknown top-level keys.

---

## Phase 4: Unit tests for helpers (TDD-aligned; can land alongside or just after the helpers)

These mirror the FR-010 / contracts/cli.md test matrix.

- [X] T010 [P] [US1] Vitest at `packages/generacy/src/cli/commands/cockpit/__tests__/parse-epic-body.test.ts`: happy path (5 phases over the `epic-cockpit-body.md` fixture from T003 — assert indices, names, tier, issues); mixed checkbox forms (`- [ ]` / `- [x]` / `-`) produce identical refs; prose paragraphs between bullets are skipped; duplicate refs deduped; heading without `P\d+` skipped; zero `P\d+` headings → `CockpitExit(2, /no 'P\\d\+' phase headings/)`.
- [X] T011 [P] [US1] Vitest at `packages/generacy/src/cli/commands/cockpit/__tests__/extract-plan.test.ts`: `Plan: docs/x.md in tetrad-development (P3 / G3.1)` → `docs/x.md`; `Plan: docs/x.md` → `docs/x.md`; missing `Plan:` line → `CockpitExit(2, /no "Plan:" line/)`; multiple `Plan:` lines → first one wins.
- [X] T012 [P] [US1] Vitest at `packages/generacy/src/cli/commands/cockpit/__tests__/derive-slug.test.ts`: `"Epic: Cockpit"` → `cockpit`; `"EPIC: Foo Bar!"` → `foo-bar`; `"%%%"` with epicNumber=85 → `epic-85`; repeated separators collapsed; `resolveTargetPath` with `--slug epic-cockpit` returns `{ source: 'flag', slug: 'epic-cockpit', path: '<root>/epic-cockpit.yaml' }`.
- [X] T013 [P] [US2] Vitest at `packages/generacy/src/cli/commands/cockpit/__tests__/resolve-manifest-path.test.ts` using `fs.mkdtemp` tmp dirs: empty dir → `not-found`; one `cockpit.yaml` → `ok`; two `*.yaml` → `ambiguous` with both names; explicit `--epic cockpit` against missing file → `not-found`; explicit `--epic cockpit` with file present → `ok`.
- [X] T014 [P] [US2] Vitest at `packages/generacy/src/cli/commands/cockpit/__tests__/diff-phases.test.ts`: matched phase with renamed name + added/removed issues populates `phasesRenamed` + `issuesAdded`/`issuesRemoved` correctly; added phase appears in `phasesAdded` with parsed tier + issues, removed phase in `phasesRemoved`; `planChanged` populated when body plan differs; `isEmpty` true on identity diff; `applyChangeSet` preserves `autonomy` and unknown top-level keys (use a manifest with `autonomy: { gate: 'human' }` + an unknown key; assert both survive); added phase's `repos` defaults to `[]`.

---

## Phase 5: Commander integration (`manifest.ts` + one-line wire-up)

- [X] T015 [US1] Implement `init` in `packages/generacy/src/cli/commands/cockpit/manifest.ts`: register Commander subcommand `manifest` with child `init <epic-ref>` carrying flags `--slug <slug>`, `--force`, `--json`, `--manifest-root <dir>`. Action handler:
  1. Parse `<epic-ref>` against `^([\w.-]+)\/([\w.-]+)#(\d+)$` → `EpicRef`; reject with `CockpitExit(2, "Error: cockpit manifest init: invalid epic ref \"<x>\" — expected owner/repo#n.")`.
  2. Build `gh` via `createCockpitGh(runner)` (runner injectable for tests).
  3. Call `gh.listIssues({ owner, repo, query: `is:issue ${number}` })` (or the existing matching helper from `gh-ext.ts`); take the single result. No matches → `CockpitExit(1, ...)`.
  4. `parseEpicBody(issue.body)` → `ParsedEpicBody`; `deriveSlug(issue.title, issue.number)` → slug; `resolveTargetPath({ manifestRoot, slug: opts.slug, derivedFromTitle: slug })` → `SlugDerivation`.
  5. If `fs.existsSync(path)` and not `--force` → `CockpitExit(1, "Error: cockpit manifest init: <path> already exists. Pass --force to overwrite or --slug <other> to choose a different name.")`.
  6. Construct `EpicManifest` (`epic.repo: owner/repo`, `epic.issue: number`, `epic.slug`, `epic.plan: parsed.plan`, `autonomy: {}`, `phases`: parsed.phases mapped to `{ name, tier?, repos: [], issues }`).
  7. Call `writeManifest(path, manifest)` (atomic via foundation).
  8. Stdout: `wrote <path> (<n> phases, <m> issues)` OR (when `--json`) single-line JSON per contracts/cli.md (US1 init shape: `phasesAdded` = all phases, others empty).
  All errors must be thrown as `CockpitExit` so the command's outer catch maps to the proper exit code; nothing is written before all parsing succeeds.
- [X] T016 [US2] Implement `sync` in the same `manifest.ts`: register `sync` subcommand with flags `--epic <slug>`, `--json`, `--manifest-root <dir>`. Action handler:
  1. `resolveManifestPath({ manifestRoot, epic: opts.epic })`. `not-found` → `CockpitExit(2, "Error: cockpit manifest sync: no manifest found under <root>. Run 'cockpit manifest init <epic-ref>' first.")`. `ambiguous` → `CockpitExit(2, "Error: cockpit manifest sync: multiple manifests found (<a>, <b>). Pass --epic <slug>.")`.
  2. `readManifest(path)` → existing `EpicManifest`; null → operational `CockpitExit(1, ...)`. Build `gh`, derive `epic-ref` from manifest's `epic.repo` + `epic.issue`, fetch issue.
  3. `parseEpicBody(issue.body)` → ParsedEpicBody.
  4. `diffPhases(parsed, manifest)` → ChangeSet. `isEmpty` → print `no changes` (or `--json` with `wrote: false`); exit 0 without writing.
  5. Otherwise `applyChangeSet(manifest, changes, parsed)` → mutated manifest, `writeManifest(path, mutated)`. Print summary (per quickstart `synced <path>: ...` text) or single-line JSON (`wrote: true`, full `changes` payload including optional `planChanged`).
  6. `autonomy` and unknown keys must round-trip untouched (verified via `applyChangeSet` and foundation IO preserving them — `data-model.md` "Application rule" step 6).
- [X] T017 Add a single line to `packages/generacy/src/cli/commands/cockpit/index.ts`: `import { manifestCommand } from './manifest.js';` (or matching extension) and `cockpit.addCommand(manifestCommand());` next to the existing `addCommand` calls. This is the only edit allowed outside the owned path per FR-003 / SC-005.

---

## Phase 6: Integration tests for the Commander surface

All live in `packages/generacy/src/cli/commands/cockpit/__tests__/manifest.test.ts` and use the `fake-gh.ts` runner pattern + `fs.mkdtemp` tmp dirs (per FR-010 + R10).

- [X] T018 [US1] init happy path: fake gh returns `epic-cockpit-body.md` as the issue body and `"Epic: Cockpit"` as the title; run `init generacy-ai/tetrad-development#85 --manifest-root <tmp>`; assert exit 0, stdout `/wrote .*cockpit\.yaml \(\d+ phases?, \d+ issues?\)/`, and that `readManifest(path)` round-trips a value structurally equal to `epic-cockpit-expected.yaml` (SC-001 + SC-002).
- [X] T019 [US1] init slug collision: pre-create `<tmp>/cockpit.yaml` with placeholder content. First run (no `--force`) → `CockpitExit(1, /already exists/)`, original file byte-equal preserved. Second run with `--force` → exit 0, file replaced with valid manifest. Third run with `--slug other` (no collision) → exit 0, writes `<tmp>/other.yaml`, original `cockpit.yaml` untouched.
- [X] T020 [US1] init missing Plan: fake gh returns a body with `P\d+` headings but no `Plan:` line → `CockpitExit(2, /no "Plan:" line/)`, no file written.
- [X] T020a [US1] init invalid epic ref: `init 85 --manifest-root <tmp>` (bare number) → `CockpitExit(2, /invalid epic ref/)`; no gh call attempted, no file written.
- [X] T021 [US2] sync idempotency + diff (SC-003): seed `<tmp>/cockpit.yaml` from `epic-cockpit-expected.yaml`, then fake gh returns a body with one extra issue ref appended to P3 and a renamed P3 display name. First sync run → exit 0, stdout matches `/synced .* \+0 phases, -0 phases, \+1 issue, -0 issues/`, on-disk manifest has the new ref + renamed name + `autonomy: { gate: 'human' }` preserved (seed with this value). Immediately re-run `sync` → exit 0, stdout `no changes`, file mtime unchanged (or content byte-equal — whichever is easier to assert; SC-003).
- [X] T022 [US2] sync resolution failures: empty `<tmp>` → `CockpitExit(2, /no manifest found/)`. Two manifests (`a.yaml`, `b.yaml`) in `<tmp>` → `CockpitExit(2, /multiple manifests found.*a\.yaml.*b\.yaml/)`. `--epic missing` against `<tmp>` with no such file → `CockpitExit(2, /no manifest found/)` (or the `--epic`-specific variant, depending on T008's wording).
- [X] T023 [US3] `--json` output schema (FR-009): run `init --json` and `sync --json` (mutating + idempotent) and assert each prints exactly one line on stdout, that the line parses as JSON, has the required keys (`verb`, `path`, `epic`, `wrote`, `changes`), conforms to the draft 2020-12 schema in `contracts/cli.md` (validate inline with a small `ajv` import or hand-rolled key check), and that `planChanged` is **omitted** (not `null`) when the plan didn't change.
- [X] T024 [US1] Golden test (SC-002): assert `readManifest(<tmp>/cockpit.yaml)` after `init` deep-equals the value loaded from `epic-cockpit-expected.yaml` (load both via foundation's `readManifest` or `yaml.parse` + `EpicManifestSchema.parse`).

---

## Phase 7: Polish + isolation contract verification

- [X] T025 Commit reference manifest at `.generacy/epics/epic-cockpit.yaml` matching the structure produced by running `init` against the live Epic Cockpit issue (per Assumption in spec.md line 99). This file lives outside the package source tree and is the reference output for SC-001.
- [X] T026 Run `git diff --stat develop...HEAD` and confirm only the paths below appear (SC-005):
  - `packages/generacy/src/cli/commands/cockpit/index.ts` (one-line edit)
  - `packages/generacy/src/cli/commands/cockpit/manifest.ts` (new)
  - `packages/generacy/src/cli/commands/cockpit/manifest/*.ts` (new helpers)
  - `packages/generacy/src/cli/commands/cockpit/__tests__/*.test.ts` (new tests)
  - `packages/generacy/src/cli/commands/cockpit/__tests__/fixtures/*` (new fixtures)
  - `.generacy/epics/epic-cockpit.yaml` (reference manifest from T025)
  - `specs/790-epic-generacy-ai-tetrad/*` (the speckit docs)
  Anything else is an isolation-contract violation; investigate before merge.
- [X] T027 Run `pnpm -F @generacy-ai/generacy test` (vitest) and `pnpm -F @generacy-ai/generacy build` (tsc). All FR-010 categories green; no type errors. If `pnpm -F @generacy-ai/generacy lint` exists, run it; resolve any new lints in owned files only.

---

## Dependencies & Execution Order

**Sequential gates** (must complete in this order):

1. **Phase 1 (T001–T002)** → unblocks everything (knowing the foundation API + sibling patterns is prerequisite to writing matching code).
2. **Phase 2 (T003–T004)** → unblocks T010 (parser unit test fixture) and T018/T024 (integration golden test).
3. **Phase 3 (T005–T009)** → unblocks Phase 4 unit tests (T010–T014) AND Phase 5 integration (T015–T016). Helpers themselves are mutually independent (all `[P]`), except T005 imports T006 — implement T006 first or in the same commit.
4. **Phase 4 + Phase 5** can run in parallel once Phase 3 is done — Phase 4 only depends on the helper file existing; Phase 5 only depends on the helper file existing.
5. **T017 (wire-up)** must land before Phase 6 integration tests can drive the Commander command end-to-end.
6. **Phase 6 (T018–T024)** → can start once T015/T016/T017 land; tests inside this phase are mutually independent (each uses its own tmp dir).
7. **Phase 7 (T025–T027)** is the polish/verification gate; T026 is the explicit isolation-contract check from SC-005.

**Parallel opportunities** (within a phase, all `[P]`-tagged tasks can run on separate workers):

- T003 ‖ T004 (fixtures are independent files).
- T005 ‖ T006 ‖ T007 ‖ T008 ‖ T009 (each helper is its own file — note T005 imports T006 internally, so commit T006 first or together).
- T010 ‖ T011 ‖ T012 ‖ T013 ‖ T014 (separate test files).
- T015 + T016 share `manifest.ts` and must be implemented sequentially (or in one PR) — they are NOT `[P]`.
- T018–T024 share `manifest.test.ts` so they should land as one PR / commit; individual `it()` blocks can be authored in parallel.

**Critical path** (longest serial chain):
T001 → T005 (which imports T006) → T015 → T017 → T018 → T026 → T027.

**Story rollout** (when grouping into child issues via `epic-grouping:per-story` or `per-phase`):
- US1 (init): T003, T004, T005, T006, T007, T010, T011, T012, T015, T017, T018, T019, T020, T020a, T024.
- US2 (sync): T008, T009, T013, T014, T016, T021, T022.
- US3 (fail-loud): assertions baked into T018–T022; T023 verifies the `--json` shape end-to-end. No standalone tasks — fail-loud is a cross-cutting expectation already covered by per-story tests.

---

## Suggested Next Step

`/speckit:implement` — execute the tasks above against the codebase. Start with T001 + T002 (read-only exploration) before generating any code, since the foundation API surface and `CockpitExit` constructor signature determine the imports in every later file.
