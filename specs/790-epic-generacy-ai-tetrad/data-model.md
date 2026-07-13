# Data Model: cockpit manifest init/sync verb (#790)

**Status**: Complete
**Date**: 2026-06-26

This document enumerates the data structures that flow through `generacy cockpit manifest <init|sync>`. It distinguishes reused types (from `@generacy-ai/cockpit`) from new internal types (defined inside `manifest.ts` and its helpers). No new persisted schema is introduced — the on-disk YAML format is unchanged.

## Reused entities (from `@generacy-ai/cockpit`)

These are imported as-is. The feature does not redefine or extend them.

### `EpicManifest`

```ts
type EpicManifest = {
  epic: EpicEntry;
  autonomy: Record<string, unknown>;  // .default({})
  phases: PhaseEntry[];                // .default([])
};
```

**Source**: `packages/cockpit/src/manifest/schema.ts:20-24`.

**Validation**: `EpicManifestSchema.parse(value)` throws on:
- Missing `epic` block.
- `epic.repo` not matching `owner/repo`.
- `epic.issue` not a positive integer.
- Any `phases[].issues[]` entry not matching `owner/repo#n`.

`autonomy` and unknown top-level keys are tolerated (`autonomy: z.record(z.unknown())` and `EpicManifestSchema` itself does not `.strict()`).

### `EpicEntry`

```ts
type EpicEntry = {
  repo: string;         // owner/repo
  issue: number;        // positive int
  slug: string;         // ≥1 char
  plan: string;         // ≥1 char (repo-relative path after init)
};
```

**Source**: `packages/cockpit/src/manifest/schema.ts:6-11`.

### `PhaseEntry`

```ts
type PhaseEntry = {
  name: string;                 // ≥1 char (includes "P3 — Manifest" style)
  tier?: string;                // optional, ≥1 char if present
  repos: string[];              // .default([]), each owner/repo
  issues: string[];             // .default([]), each owner/repo#n
};
```

**Source**: `packages/cockpit/src/manifest/schema.ts:13-18`.

### `Issue` (from `GhWrapper`)

```ts
type Issue = {
  number: number;
  title: string;
  body: string;               // empty string when GitHub returned null
  labels: string[];
  url: string;
  state: 'OPEN' | 'CLOSED';
  author?: { login: string };
  createdAt: string;
};
```

**Source**: `packages/cockpit/src/gh/wrapper.ts:7-16`.

Only `number`, `title`, and `body` are consumed by `manifest.ts`. `labels` could be used to detect "this is actually an epic issue" in a future hardening pass; not used in v1.

### `CommandRunner`

```ts
type CommandRunner = (
  cmd: string,
  args: string[],
  options?: CommandRunnerOptions,
) => Promise<CommandResult>;

type CommandResult = { stdout: string; stderr: string; exitCode: number };
```

**Source**: `packages/cockpit/src/gh/command-runner.ts` (re-exported via `@generacy-ai/cockpit`).

Used as the test injection seam — production code passes `nodeChildProcessRunner`, tests pass `fake-gh.ts` stubs.

## New internal entities

These live inside `manifest.ts` (or the optional `cockpit/manifest/` helpers folder). They are not exported from any package.

### `EpicRef`

Input parameter for `init`. Parsed from the CLI argument `<epic-ref>`.

```ts
interface EpicRef {
  owner: string;          // e.g. "generacy-ai"
  repo: string;           // e.g. "tetrad-development"
  number: number;         // e.g. 85
  nwo: string;            // "<owner>/<repo>" for convenience
}
```

**Parser**: regex `^([\w.-]+)\/([\w.-]+)#(\d+)$`. Reject anything else with `CockpitExit(2, ...)`.

### `ParsedEpicBody`

Output of the body parser. Pure-function transformation of `Issue.body`.

```ts
interface ParsedEpicBody {
  plan: string;                  // bare repo-relative path; "" never appears — parser errors instead
  phases: ParsedPhase[];         // in body order
}

interface ParsedPhase {
  index: number;                 // the N in P\d+, used as identity for sync
  name: string;                  // full display name from the heading line, post-separator
  tier?: string;                 // captured from "→ vN" if present, else undefined
  issues: string[];              // owner/repo#n refs, in body order, deduplicated
}
```

**Validation rules** (parser-internal):
- Two phases with the same `index` → take the first, drop subsequent (and log a warning to stderr).
- A bullet ref that doesn't match `owner/repo#n` → silently skipped (it's "prose").
- A heading without a `P\d+` token → silently skipped (it's a section header for unrelated content).
- Duplicate issue refs inside one phase → deduplicate, preserve first occurrence.
- Issue refs that appear under multiple phases → keep in each phase (the body is the source of truth; cross-phase duplicates may be intentional).

**Failure modes** (parser exits non-zero, raises `CockpitExit(2, ...)`):
- No `Plan:` line found → "epic body has no 'Plan:' line".
- Zero phases parsed → "epic body has no 'P\\d+' phase headings — body may be malformed".

### `SlugDerivation`

```ts
interface SlugDerivation {
  source: 'flag' | 'derived';      // which path produced the slug
  slug: string;                    // the kebab-case identifier
  path: string;                    // absolute path to <root>/<slug>.yaml
}
```

**Derivation rule**:
1. If `--slug <s>` was passed, `source: 'flag'`, `slug: s`.
2. Else, `source: 'derived'`, `slug: deriveSlug(epicIssue.title)`.

**`deriveSlug(title)` algorithm**:
1. Strip leading `^(Epic|EPIC):\s*` if present.
2. Lowercase.
3. Replace `[^a-z0-9]+` with `-`.
4. Trim leading/trailing `-`.
5. Collapse repeated `-`.
6. If the result is empty (title was punctuation-only): fall back to `epic-<number>`.

### `ChangeSet`

Output of the sync diff function. Drives both the human-readable summary and `--json`.

```ts
interface ChangeSet {
  phasesAdded: ParsedPhase[];               // new in body
  phasesRemoved: PhaseEntry[];              // gone from body
  phasesRenamed: Array<{                    // matched by index, different name
    index: number;
    from: string;
    to: string;
  }>;
  issuesAdded: Record<string, string[]>;    // key: "P<n>", value: refs to add
  issuesRemoved: Record<string, string[]>;  // key: "P<n>", value: refs to drop
  planChanged: { from: string; to: string } | null;  // sync may also update epic.plan if body changed
}

function isEmpty(c: ChangeSet): boolean;    // true ⇒ idempotent run, sync skips the write
```

**Diff algorithm** (pseudocode):

```text
1. Build index maps:
   - parsedByIndex: Map<number, ParsedPhase>  from ParsedEpicBody.phases.
   - manifestByIndex: Map<number, PhaseEntry> from manifest.phases (extract index via regex).
2. phasesAdded = parsedByIndex.values() where index not in manifestByIndex.
3. phasesRemoved = manifestByIndex.values() where index not in parsedByIndex.
4. For each index in both:
   parsed = parsedByIndex[index]; existing = manifestByIndex[index].
   - If parsed.name !== existing.name: phasesRenamed += { index, from: existing.name, to: parsed.name }.
   - issuesAdded[`P${index}`] = parsed.issues - existing.issues (set diff, preserve parsed order).
   - issuesRemoved[`P${index}`] = existing.issues - parsed.issues.
5. planChanged = parsedBody.plan !== manifest.epic.plan ? { from: ..., to: ... } : null.
```

**Application rule** (sync only writes when `!isEmpty(c)`):

```text
1. Apply phasesRenamed first (mutate matched phase's name in place).
2. Apply issuesAdded/Removed inside each matched phase (preserve original order, append new refs to end).
3. Append phasesAdded to manifest.phases in body order (after the last existing phase, since the parser produces them in body order and the body order = canonical order).
4. Remove phasesRemoved from manifest.phases.
5. If planChanged is non-null, update manifest.epic.plan.
6. autonomy and any unknown keys: never touched.
7. writeManifest(path, mutated).
```

### `ManifestPathResolution`

Output of `resolveManifestPath()` for `sync`.

```ts
type ManifestPathResolution =
  | { kind: 'ok'; path: string }
  | { kind: 'not-found'; root: string }
  | { kind: 'ambiguous'; root: string; matches: string[] };
```

The action handler maps `not-found` and `ambiguous` to `CockpitExit(2, ...)` with the messages from R9.

### `JsonOutput`

Stable shape of the `--json` line. (Documented in detail in `contracts/cli.md`.)

```ts
interface JsonOutput {
  verb: 'init' | 'sync';
  path: string;                                // absolute or repo-relative target
  epic: string;                                // owner/repo#n
  wrote: boolean;                              // false on idempotent sync
  changes: {
    phasesAdded: string[];                     // ["P4: Hardening", ...]
    phasesRemoved: string[];                   // by original name
    phasesRenamed: Array<{ from: string; to: string }>;
    issuesAdded: Record<string, string[]>;     // "P3": ["owner/repo#n", ...]
    issuesRemoved: Record<string, string[]>;
    planChanged?: { from: string; to: string };  // omitted when null
  };
}
```

## Relationships

```text
CLI args (epic-ref string | --epic slug | --slug s | --force)
  → EpicRef                              (init only, via regex parser)
  → SlugDerivation                       (init only, after fetching title)
  → ManifestPathResolution               (sync only)

GhWrapper.listIssues(query)
  → Issue                                (one record, narrowed by repo+number)
  → ParsedEpicBody                       (via parseEpicBody, deterministic)

ParsedEpicBody
  + (init) → EpicManifest                (new manifest, no diff)
  + (sync) + existing manifest → ChangeSet → mutated EpicManifest

EpicManifest
  → writeManifest(path, manifest)        (atomic tmp+rename)
  → JsonOutput                           (when --json passed)
```

## Validation rules summary

| Layer | Rule | Failure mode |
|-------|------|--------------|
| CLI parse | `<epic-ref>` matches `owner/repo#n` | `CockpitExit(2, "Error: cockpit manifest init: invalid epic ref ...")` |
| gh fetch | `listIssues` finds exactly one issue | `CockpitExit(1, "... gh issue not found: ...")` |
| Body parse | `Plan:` line present | `CockpitExit(2, "... epic body has no 'Plan:' line ...")` |
| Body parse | ≥1 `P\d+` heading present | `CockpitExit(2, "... epic body has no 'P\\d+' phase headings ...")` |
| Slug | derived slug non-empty (fallback `epic-<n>` covers degenerate titles) | n/a (always non-empty) |
| File collision | target file does not exist, OR `--force` passed | `CockpitExit(1, "Error: cockpit manifest init: <path> already exists. Pass --force ...")` |
| Manifest write | `EpicManifestSchema.parse()` succeeds | thrown by `writeManifest()`; bubbled up |
| Sync resolution | exactly one manifest matches (or `--epic` flag) | `CockpitExit(2, "... no manifest found ..." or "... multiple manifests found ...")` |

All error paths surface as `CockpitExit` — the verb's Commander action catches it, writes to stderr, calls `process.exit(code)`. No partial writes are possible because `writeManifest()` is the only place state mutates and it's atomic.

## Out of scope (deferred)

- Cross-repo phase scoping (`phases[*].repos` is populated implicitly from issue refs but never explicitly diffed or validated). Tracked under spec's "Out of scope".
- `autonomy` block diffing — locked to "never touched" in Q3/A.
- Migration from a hypothetical older manifest schema — none exists.
