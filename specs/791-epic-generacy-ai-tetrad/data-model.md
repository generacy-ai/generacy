# Data Model: `cockpit queue <phase>`

All types are TypeScript ESM definitions internal to `packages/generacy/src/cli/commands/cockpit/queue.ts` unless noted. No new types are added to `@generacy-ai/cockpit`'s public surface.

## 1. `QueueOptions` — Commander options

Parsed by the Commander action handler from CLI flags.

```ts
export interface QueueOptions {
  /** `--repo <owner/repo>` — required only when the phase spans multiple repos. */
  repo?: string;
  /** `--assignee <login>` — overrides the default (`gh api user --jq .login`). */
  assignee?: string;
  /** `--yes` — skip the interactive confirmation prompt. */
  yes?: boolean;
}
```

**Validation** (at CLI boundary, before any I/O):
- `repo`, if present, must match `/^[^/]+\/[^/]+$/` — otherwise exit 2 with `Error: cockpit queue: invalid --repo "<value>" (expected owner/repo)`.
- `assignee`, if present, must match `/^[A-Za-z0-9-]+$/` and be non-empty — otherwise exit 2.

## 2. `ResolvedPhase` — output of phase matching

Produced by the pure helper `resolvePhase(manifests, phaseArg)`.

```ts
export interface ResolvedPhase {
  /** The matched `phases[X].name` value. */
  name: string;
  /** The matched `phases[X].tier` value (e.g. `P3`); undefined if the phase lacks a tier. */
  tier: string | undefined;
  /** The phase's full `issues` list verbatim (each entry is `owner/repo#n`). */
  issueRefs: string[];
  /** Path of the manifest the phase came from (for diagnostic output). */
  manifestPath: string;
}

export type ResolvePhaseError =
  | { kind: 'no-manifests'; manifestRoot: string }
  | { kind: 'not-found'; phaseArg: string; manifestRoot: string }
  | { kind: 'ambiguous'; phaseArg: string; matches: Array<{ manifestPath: string; name: string; tier: string | undefined }> };
```

**Match rule**: a phase matches `phaseArg` iff `phase.tier === phaseArg` OR `phase.name === phaseArg` (exact, case-sensitive). Walks every `*.yaml` in the manifest root in sorted order.

**Cardinality**:
- 0 matches → `not-found`.
- 1 match → `ResolvedPhase`.
- N > 1 matches across distinct manifests → `ambiguous` (v1 errors; future `--manifest` flag would disambiguate).

## 3. `ParsedIssueRef` — sentry between manifest strings and gh calls

```ts
export interface ParsedIssueRef {
  /** "owner/repo". */
  repo: string;
  /** Issue number (positive integer). */
  number: number;
}
```

**Parser**: `parseRef('generacy-ai/generacy#791') → { repo: 'generacy-ai/generacy', number: 791 }`. Reuses the regex from `EpicManifestSchema`'s `ISSUE_REF_REGEX` (`/^[^/]+\/[^/]+#\d+$/`), but does NOT import it — a one-line literal is the right cost.

## 4. `QueueRow` — one row per phase issue

The verb materialises a `QueueRow[]` (one per phase issue ref) after fetching state from `gh`. This is the single shape used for the preview render, the mutation loop, and the per-issue summary.

```ts
export type EligibilityStatus =
  | { kind: 'eligible'; workflowLabel: 'process:speckit-feature' | 'process:speckit-bugfix' }
  | { kind: 'skip'; reason: 'closed' | 'cross-repo' | 'no-phase' | 'not-found' };

export interface QueueRow {
  ref: ParsedIssueRef;
  /** Title from `gh issue view`. Empty string for `not-found`. */
  title: string;
  /** Issue's current labels at preview time. Empty for `not-found`. */
  labels: string[];
  /** Issue's current assignees at preview time. Empty for `not-found`. */
  assignees: string[];
  /** Eligibility classification. */
  eligibility: EligibilityStatus;
  /** Per-row mutation outcomes; populated only after the mutation loop runs. */
  assignResult?: MutationOutcome;
  labelResult?: MutationOutcome;
}

export type MutationOutcome =
  | { kind: 'ok' }
  | { kind: 'already' }
  | { kind: 'error'; reason: string };
```

**Invariants**:
- `assignResult` and `labelResult` are populated iff `eligibility.kind === 'eligible'` AND the operator confirmed (or passed `--yes`).
- Decline path → both fields remain undefined. SC-002 assertion: any populated mutation outcome means a `gh` write call happened.
- `kind: 'already'` is computed pre-mutation by comparing against `assignees` / `labels`; no `gh` write call is issued.

## 5. `QueueResult` — verb return / test assertion shape

```ts
export interface QueueResult {
  resolvedPhase: ResolvedPhase;
  targetRepo: string;
  assignee: string;
  rows: QueueRow[];
  /** Whether the operator (or --yes) authorised mutations. */
  confirmed: boolean;
  /** Final exit code per R9 in research.md. */
  exitCode: 0 | 1 | 2;
}
```

`runQueue()` returns this shape so unit tests can assert against fields directly without parsing stdout (matches the `runAdvance` test-style — though `runAdvance` returns void; queue returns a result envelope because the test surface is larger).

## 6. `QueueCommandDeps` — DI seam for tests

```ts
export interface QueueCommandDeps {
  runner?: CommandRunner;                          // default: nodeChildProcessRunner
  gh?: CockpitGh;                                  // default: createCockpitGh(runner)
  loadConfig?: typeof loadCockpitConfig;           // default: loadCockpitConfig
  prompt?: (message: string) => Promise<boolean>;  // default: thin wrapper over @clack/prompts p.confirm
  stdout?: (line: string) => void;                 // default: process.stdout.write(line + '\n')
  stderr?: (line: string) => void;                 // default: process.stderr.write(line + '\n')
  manifestRoot?: string;                           // default: path.join(process.cwd(), '.generacy', 'epics')
}
```

**Test pattern**: every test constructs a `deps` object with stubbed `runner` + inline `loadConfig` + tmpdir `manifestRoot` + capturing `stdout`/`stderr`. The Commander factory remains zero-arg (`queueCommand()`); the test calls `runQueue(phase, opts, deps)` directly.

## 7. Extension to `CockpitGh`

Two adapter-level additions (`gh-ext.ts`):

```ts
export interface IssueStateResult {
  state: 'OPEN' | 'CLOSED';
  closedAt: string | null;
  labels: string[];
  assignees: string[];   // NEW — added for queue's idempotency check
  title: string;         // NEW — added for queue's preview render
}

// New method:
export interface CockpitGh {
  // ...existing methods...
  addAssignees(repo: string, number: number, logins: string[]): Promise<void>;
}
```

**Migration**: existing callers of `fetchIssueState` (`advance.ts`, `state.ts`) read `state`, `closedAt`, `labels` selectively. The new fields are additive and zero-impact. Tests in `__tests__/advance.test.ts` and `__tests__/state.test.ts` do NOT assert exhaustive object shape (verified by reading the test files); no existing test needs to change for this extension.

**JSON shape change**: `fetchIssueState` issues `gh issue view <n> --repo <repo> --json state,closedAt,labels,assignees,title`. The Zod schema in `gh-ext.ts` gains:

```ts
const IssueStateSchema = z.object({
  state: z.string(),
  closedAt: z.string().nullable().optional(),
  labels: z.array(LabelSchema).default([]),
  assignees: z.array(z.object({ login: z.string() }).passthrough()).default([]),
  title: z.string().default(''),
});
```

The mapper normalises assignees to `string[]` (logins).

## 8. Persistence

None. The verb mutates GitHub via `gh` only; no local state, no caches.

## Validation Rules Summary

| Field                     | Constraint                                                                   | Failure mode  |
|---------------------------|------------------------------------------------------------------------------|---------------|
| `<phase>` (arg)           | non-empty, exact-case-sensitive match against `phase.tier` OR `phase.name`   | exit 2        |
| `--repo`                  | matches `/^[^/]+\/[^/]+$/`; present in the phase's repo set                   | exit 2        |
| `--assignee`              | matches `/^[A-Za-z0-9-]+$/`, non-empty                                       | exit 2        |
| manifest dir              | must exist; must contain ≥1 `*.yaml`                                          | exit 2 + hint |
| manifest YAML / schema    | must parse + validate via `EpicManifestSchema`                                | exit 1 + path |
| issue ref string          | matches `/^[^/]+\/[^/]+#\d+$/` (validated by manifest schema upstream)         | (unreachable) |
| `gh` write call           | non-zero exit captured as `MutationOutcome.error`, never throws out of loop  | exit 1 at end |

## Relationships

```text
                ┌─────────────────────┐
                │ EpicManifest (G0.1) │  read via readManifest
                └─────────┬───────────┘
                          │
                          ▼
                ┌─────────────────────┐
                │  ResolvedPhase      │  ← resolvePhase(manifests, phaseArg)
                └─────────┬───────────┘
                          │ issueRefs[*] → parseRef → ParsedIssueRef
                          ▼
                ┌─────────────────────┐
                │  QueueRow[]          │  ← gh issue view per ref
                └─────────┬───────────┘
                          │ filter eligibility.kind === 'eligible'
                          ▼
                ┌─────────────────────┐
                │ mutation loop       │  ← gh addAssignees + addLabel per row
                └─────────┬───────────┘
                          │ writes assignResult + labelResult
                          ▼
                ┌─────────────────────┐
                │  QueueResult         │  ← returned from runQueue()
                └─────────────────────┘
```
