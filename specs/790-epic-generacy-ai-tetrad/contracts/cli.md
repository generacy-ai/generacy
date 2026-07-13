# CLI Contract: `generacy cockpit manifest <init|sync>`

**Status**: Complete
**Date**: 2026-06-26

This document fixes the public surface of the new verb: invocation grammar, flag semantics, stdout/stderr behavior, exit codes, and the `--json` payload schema. Implementation conforms to this contract; downstream automation (cloud, watchers, `cockpit queue`) consumes it.

## Command surface

```text
generacy cockpit manifest init <epic-ref> [--slug <slug>] [--force] [--json] [--manifest-root <dir>]
generacy cockpit manifest sync             [--epic <slug>] [--json] [--manifest-root <dir>]
```

### Subcommand: `init`

**Positional**: `<epic-ref>` — required. Must match `owner/repo#n` exactly (e.g. `generacy-ai/tetrad-development#85`). Bare numbers, URLs, and short forms are rejected (different from `cockpit state <issue>`, which accepts looser forms via `parseIssueRef`).

**Flags**:
- `--slug <slug>` — override the slug derived from the epic title. Must match `[a-z0-9][a-z0-9-]*`. The target file becomes `<manifest-root>/<slug>.yaml`.
- `--force` — overwrite the target file if it already exists. Without `--force`, an existing target is a fatal error (exit 1).
- `--json` — emit a single-line JSON object on stdout in addition to (replacing) the human-readable line.
- `--manifest-root <dir>` — override the `<cwd>/.generacy/epics/` default. Hidden flag, intended for tests; documented here for completeness.

**Exit codes**:
- `0` — manifest written successfully.
- `1` — operational failure: gh call failed, file collision without `--force`, write IO error.
- `2` — input validation failure: bad `<epic-ref>` format, malformed epic body, missing `Plan:` line, no `P\d+` headings.

### Subcommand: `sync`

**Positional**: none.

**Flags**:
- `--epic <slug>` — pick the manifest at `<manifest-root>/<slug>.yaml` directly, bypassing single-manifest auto-resolution.
- `--json` — same shape as `init`'s JSON output.
- `--manifest-root <dir>` — same as `init`.

**Exit codes**:
- `0` — sync run completed. The manifest was either updated (`wrote: true`) or already in sync with the body (`wrote: false`). Both are success.
- `1` — operational failure: gh call failed, write IO error, manifest at the resolved path is malformed (Zod parse failure).
- `2` — resolution / input failure: zero matching manifests, multiple matching manifests without `--epic`, `--epic <s>` points at a missing file, parsed body has no `Plan:` line or no `P\d+` headings.

## Stdout / stderr

### Human-readable mode (default, no `--json`)

**`init` success**:

```text
wrote .generacy/epics/cockpit.yaml (3 phases, 12 issues)
```

**`sync` success — changes applied**:

```text
synced .generacy/epics/cockpit.yaml: +1 phase, -0 phases, +2 issues, -1 issue
  P3 Manifest: +1 -1 (added generacy-ai/generacy#791, removed generacy-ai/generacy#790)
  P4 Queue (new): +1 (added generacy-ai/generacy#791)
```

**`sync` success — no changes**:

```text
no changes
```

**Failure** (any code != 0): error message on stderr, nothing on stdout. Format:

```text
Error: cockpit manifest <verb>: <human-readable cause>.
```

Examples:
- `Error: cockpit manifest init: invalid epic ref "85" — expected owner/repo#n.`
- `Error: cockpit manifest init: epic body has no "Plan:" line. Add a line like 'Plan: docs/<your-plan>.md' to the epic body.`
- `Error: cockpit manifest init: .generacy/epics/cockpit.yaml already exists. Pass --force to overwrite or --slug <other> to choose a different name.`
- `Error: cockpit manifest sync: no manifest found under .generacy/epics/. Run 'cockpit manifest init <epic-ref>' first.`
- `Error: cockpit manifest sync: multiple manifests found (cockpit.yaml, observability.yaml). Pass --epic <slug>.`

### `--json` mode

Exactly one line on stdout, a JSON object matching the schema below. The human-readable line is **suppressed** when `--json` is set. stderr is still used for errors (with the same text as the non-JSON mode); the schema applies only to successful runs.

```json
{
  "verb": "init",
  "path": ".generacy/epics/cockpit.yaml",
  "epic": "generacy-ai/tetrad-development#85",
  "wrote": true,
  "changes": {
    "phasesAdded": ["P0: Foundation", "P3: Manifest", "P4: Queue"],
    "phasesRemoved": [],
    "phasesRenamed": [],
    "issuesAdded": {"P0": ["generacy-ai/generacy#786"], "P3": ["generacy-ai/generacy#790"]},
    "issuesRemoved": {}
  }
}
```

```json
{
  "verb": "sync",
  "path": ".generacy/epics/cockpit.yaml",
  "epic": "generacy-ai/tetrad-development#85",
  "wrote": false,
  "changes": {
    "phasesAdded": [],
    "phasesRemoved": [],
    "phasesRenamed": [],
    "issuesAdded": {},
    "issuesRemoved": {}
  }
}
```

```json
{
  "verb": "sync",
  "path": ".generacy/epics/cockpit.yaml",
  "epic": "generacy-ai/tetrad-development#85",
  "wrote": true,
  "changes": {
    "phasesAdded": ["P4: Queue"],
    "phasesRemoved": ["P5: Reporting"],
    "phasesRenamed": [{"from": "P3 Manifest", "to": "P3 — Manifest"}],
    "issuesAdded": {"P3": ["generacy-ai/generacy#791"], "P4": ["generacy-ai/generacy#792"]},
    "issuesRemoved": {"P3": ["generacy-ai/generacy#789"]},
    "planChanged": {"from": "docs/old-plan.md", "to": "docs/epic-cockpit-plan.md"}
  }
}
```

#### JSON schema (draft 2020-12)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "CockpitManifestVerbResult",
  "type": "object",
  "required": ["verb", "path", "epic", "wrote", "changes"],
  "additionalProperties": false,
  "properties": {
    "verb": { "enum": ["init", "sync"] },
    "path": { "type": "string", "minLength": 1 },
    "epic": { "type": "string", "pattern": "^[^/]+/[^/]+#\\d+$" },
    "wrote": { "type": "boolean" },
    "changes": {
      "type": "object",
      "required": ["phasesAdded", "phasesRemoved", "phasesRenamed", "issuesAdded", "issuesRemoved"],
      "additionalProperties": false,
      "properties": {
        "phasesAdded": {
          "type": "array",
          "items": { "type": "string", "minLength": 1 }
        },
        "phasesRemoved": {
          "type": "array",
          "items": { "type": "string", "minLength": 1 }
        },
        "phasesRenamed": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["from", "to"],
            "additionalProperties": false,
            "properties": {
              "from": { "type": "string", "minLength": 1 },
              "to":   { "type": "string", "minLength": 1 }
            }
          }
        },
        "issuesAdded": {
          "type": "object",
          "additionalProperties": {
            "type": "array",
            "items": { "type": "string", "pattern": "^[^/]+/[^/]+#\\d+$" }
          }
        },
        "issuesRemoved": {
          "type": "object",
          "additionalProperties": {
            "type": "array",
            "items": { "type": "string", "pattern": "^[^/]+/[^/]+#\\d+$" }
          }
        },
        "planChanged": {
          "type": "object",
          "required": ["from", "to"],
          "additionalProperties": false,
          "properties": {
            "from": { "type": "string", "minLength": 1 },
            "to":   { "type": "string", "minLength": 1 }
          }
        }
      }
    }
  }
}
```

**Notes on the schema**:
- `phasesAdded` for `init` lists all phases — every one is "new". For `sync`, only the ones absent from the manifest.
- `phasesRemoved` lists the prior `name` strings from the manifest (the body has no record of them).
- `issuesAdded` / `issuesRemoved` keys are `P<n>` strings — the index, not the display name — to give consumers a stable key across renames.
- `planChanged` is **omitted** (not `null`) when the plan line did not change between body and manifest. This keeps the common case ("nothing about the plan changed") quiet.
- `wrote: false` always implies all `changes.*` arrays/objects are empty.

## Epic body parser contract

The parser is part of the verb's public contract because the body format determines what manifests look like. See `data-model.md` (`ParsedEpicBody`) and `research.md` (R3, R4) for full semantics. Summary of the grammar locked by [clarifications.md](../clarifications.md):

```text
EpicBody       := (Anything | PlanLine | PhaseSection)*
PlanLine       := "Plan:" S+ Path (S+ "in" S+ Word)? S* ("(" Anything ")")? EOL
Path           := <any non-whitespace path, ≥1 char>
PhaseSection   := PhaseHeading PhaseBody
PhaseHeading   := ("##" | "###" | "####") S+ PhaseTitle EOL
PhaseTitle     := <any string containing P\d+ token and optional → vN tier marker>
PhaseBody      := (PhaseBullet | Anything)*  ; bullets and prose interleave; ends at next heading
PhaseBullet    := S* "-" S* ("[" S* ("x" | "X" | " ") S* "]" S+)? IssueRef ( S+ ("—" | "-") S+ Title )? EOL
IssueRef       := OwnerRepo "#" Number
OwnerRepo      := [A-Za-z0-9._-]+ "/" [A-Za-z0-9._-]+
Number         := [0-9]+
```

Issue refs inside `PhaseBody` are collected into `phase.issues`, preserving body order and deduplicating exact duplicates. Anything between bullets is silently skipped.

## Foundation API surface used

The verb imports the following symbols from `@generacy-ai/cockpit`. The names are part of the contract — if any rename, this feature breaks.

```ts
import {
  EpicManifestSchema,
  type EpicManifest,
  type EpicEntry,
  type PhaseEntry,
  readManifest,
  writeManifest,
  GhCliWrapper,
  type GhWrapper,
  type Issue,
  nodeChildProcessRunner,
  type CommandRunner,
} from '@generacy-ai/cockpit';
```

## Stability promise

- **Stable**: subcommand names (`init`, `sync`), positional argument shape (`owner/repo#n`), flag names (`--slug`, `--force`, `--epic`, `--json`), JSON output schema (keys, types, value formats), exit codes (0/1/2 with the meanings above).
- **Unstable / internal**: human-readable stdout text (may improve over time — scripts should consume `--json`), `--manifest-root` flag (testing affordance, may be hidden or removed), exact error message wording (the prefix `Error: cockpit manifest <verb>:` is stable; the cause text is not).

## Test coverage matrix (mapped to FR-010)

| Test category | Fixture | Asserts |
|---------------|---------|---------|
| Body-parse happy path | `fixtures/epic-cockpit-body.md` | `parseEpicBody` returns 5 phases with expected indices, names, issue lists. |
| Body-parse with checkboxes mixed | inline body strings | `- [ ]`, `- [x]`, `-` all produce identical refs. |
| Body-parse with prose interleaving | inline | Prose paragraphs between bullets are skipped; bullet list resumes correctly. |
| Slug derivation | inline titles | `"Epic: Cockpit"` → `cockpit`; punctuation-only title → `epic-<n>`; collision math (`--slug` override). |
| Slug collision: `--force` allows overwrite | tmp dir fixture | Pre-existing file is replaced; new manifest validates. |
| Slug collision: no flag → exit 1 | tmp dir fixture | `CockpitExit(1, /already exists/)` thrown; original file untouched. |
| Sync add/remove diff | tmp dir + fixture body | `ChangeSet.phasesAdded`, `phasesRemoved`, `issuesAdded`, `issuesRemoved` populated as expected; `autonomy` preserved across the write. |
| Sync idempotency | tmp dir + fixture body | Two consecutive `sync` runs: first updates, second `wrote: false`. |
| Sync resolution: missing manifest | empty `.generacy/epics/` | `CockpitExit(2, /no manifest found/)`. |
| Sync resolution: ambiguous | two manifests in dir | `CockpitExit(2, /multiple manifests found/)`. |
| Plan: line stripping | inline bodies | `Plan: docs/x.md in tetrad-development (P3 / G3.1)` → `docs/x.md`. |
| Missing Plan: line | inline body | `CockpitExit(2, /no "Plan:" line/)`. |
| `--json` output shape | tmp dir + fixture | Successful runs emit valid JSON matching the schema above. |
