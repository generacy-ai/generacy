# Contract: Epic manifest read/write/resolve

## On-disk shape

Path: `.generacy/epics/<slug>.yaml` in the epic-parent's repo.

```yaml
epic:
  repo: generacy-ai/generacy
  issue: 786
  slug: epic-cockpit
  plan: docs/epic-cockpit-plan.md

autonomy: {}                           # reserved for v1.x; empty for v1

phases:
  - name: foundation
    tier: P0
    repos:
      - generacy-ai/generacy
    issues:
      - generacy-ai/generacy#786
  - name: ui
    tier: P1
    repos:
      - generacy-ai/generacy-extension
    issues:
      - generacy-ai/generacy-extension#42
```

## `readManifest(path)`

```ts
function readManifest(path: string): Promise<EpicManifest | null>;
```

- Returns `null` if `path` does not exist.
- Reads UTF-8 YAML. Parse errors throw with the underlying `YAMLParseError`.
- Validates with `EpicManifestSchema`. Schema errors throw the Zod issue.
- Returns the parsed + validated manifest on success.

## `writeManifest(path, manifest)`

```ts
function writeManifest(path: string, manifest: EpicManifest): Promise<void>;
```

- Validates input with `EpicManifestSchema.parse()` first (refuses to write malformed data).
- Serializes to YAML via the `yaml` package's default options (2-space indent, sorted keys preserved).
- Writes atomically via `<path>.tmp` + `fs.rename(tmp, path)`.
- Creates parent directories as needed (`mkdir({ recursive: true })`).

## `appendChildIssue(path, phaseName, issueRef)`

```ts
function appendChildIssue(path: string, phaseName: string, issueRef: string): Promise<void>;
```

- `issueRef` must match `/^[^/]+\/[^/]+#\d+$/` (e.g. `'generacy-ai/generacy#787'`). Otherwise throws.
- Reads the manifest; throws if missing.
- Finds the phase with `name === phaseName`. If absent, throws `Error('phase not found: <name>')`.
- Idempotent: if `issueRef` is already in the phase's `issues` array, returns without writing.
- Otherwise appends to `phases[i].issues` and calls `writeManifest()` to persist atomically.
- Touches only the target phase — other phases' entries and `autonomy` are preserved verbatim.

## `resolveEpicIssues(epic, owner, repo, options?)`

```ts
function resolveEpicIssues(
  epic: number,
  owner: string,
  repo: string,
  options?: {
    manifestRoot?: string;         // default: `${cwd}/.generacy/epics`
    gh?: GhWrapper;                // injected for fallback path; default: new GhCliWrapper()
    cwd?: string;                  // default: process.cwd()
  },
): Promise<number[]>;
```

### Resolution order

1. **Manifest branch**:
   - List `.generacy/epics/*.yaml` under `manifestRoot`.
   - For each file, parse + validate via `EpicManifestSchema`. Files that fail validation are skipped with a logged warning (not fatal — one bad manifest shouldn't block the rest).
   - If any manifest's `epic.issue === epic` and `epic.repo === '<owner>/<repo>'`, return the union of all `phases[*].issues` where the entry matches `<owner>/<repo>#<n>`, converted to numbers. Dedupe.
2. **Label fallback** (only if no manifest matched):
   - Query `gh.listIssues('repo:<owner>/<repo> is:issue label:epic-child #<epic>')` to find issues labeled `epic-child` referencing the epic.
   - Query `gh.listIssues('repo:<owner>/<repo> is:issue <owner>/<repo>#<epic> in:body')` to find body-references.
   - Merge + dedupe the issue numbers; return.

### Error modes

| Failure                                              | Behavior                                                    |
|------------------------------------------------------|-------------------------------------------------------------|
| `manifestRoot` does not exist                         | Skip to fallback path (not an error).                       |
| A `.yaml` file fails Zod validation                  | Skip that file, log via options.logger?.warn (if provided). |
| Both manifest and `gh` fallback return zero issues   | Return `[]`. Not an error.                                  |
| `gh` invocation throws (e.g. binary missing)         | Propagate the error to the caller.                          |

## Test scenarios (SC-004)

1. **Manifest hit** — fixture in `manifestRoot` matches epic 786 → returns the union of issue numbers from matching `phases[*].issues`.
2. **No matching manifest, label fallback hits** — stubbed `gh.listIssues` returns canned results → resolver returns the merged number set.
3. **Both empty** — no fixtures, stubbed `gh.listIssues` returns `[]` for both queries → resolver returns `[]`.
4. **Malformed manifest** — one fixture file has invalid YAML; valid sibling matches the epic → resolver returns the valid file's issues, logs the parse failure.
