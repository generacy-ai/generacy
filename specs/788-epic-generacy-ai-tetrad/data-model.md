# Data Model: `generacy cockpit` — state / advance / clarify-context

This document defines the in-process types this issue introduces and the on-the-wire output schemas the three verbs emit. Types live in `packages/generacy/src/cli/commands/cockpit/`; output schemas are also rendered as JSON Schema files under `contracts/` for downstream consumers.

## Entities

### IssueRef

In-process value carried by every verb.

```ts
interface IssueRef {
  /** GitHub owner login (e.g. "generacy-ai") */
  owner: string;
  /** GitHub repo name (e.g. "generacy") */
  repo: string;
  /** GitHub issue/PR number */
  number: number;
  /** "owner/repo" — convenience for gh CLI calls */
  nwo: string;
}
```

Validation rules:
- `owner` and `repo` non-empty, no `/`, no whitespace.
- `number` positive integer.
- `nwo` is always `${owner}/${repo}` — single field of truth derived from owner+repo.

Constructed exclusively by `parseIssueRef(input, config)` which accepts:
- `"123"` (bare number; requires exactly one repo in `config.repos` per AD-5)
- `"owner/repo#123"`
- `"https://github.com/owner/repo/issues/123"`
- `"https://github.com/owner/repo/pull/123"` (treated as issue-ref; GitHub PRs are issues)

### GateDefinition

Pure-function lookup table built once at module load.

```ts
interface GateDefinition {
  /** Gate name (e.g. "clarification", "plan-review") — what the user passes to --gate. */
  name: string;
  /** Full label name "waiting-for:<name>" */
  waitingLabel: string;
  /** Full label name "completed:<name>" */
  completedLabel: string;
}

/** Map keyed by gate name. */
declare const GATES: ReadonlyMap<string, GateDefinition>;
```

Derivation rule (`gate-vocabulary.ts`):
1. Walk `WORKFLOW_LABELS` from `@generacy-ai/workflow-engine`.
2. For each `waiting-for:<x>` whose pair `completed:<x>` also exists in the list, emit a `GateDefinition`.
3. Pairs where only the waiting side or only the completed side exists are **not** valid gates and are excluded from `GATES`. (Today this excludes `completed:setup`, `completed:specify`, `completed:clarify`, `completed:plan`, `completed:tasks`, `completed:implement`, `completed:validate`, `completed:children-complete`, `completed:epic-approval` because they have no `waiting-for:*` counterpart — though some do; see below.)
4. Order of `GATES.values()` matches `WORKFLOW_LABELS` order for stable `--help` output.

Pairs that DO produce gates (cross-referencing `label-definitions.ts`):
- `clarification`, `clarification-review`, `spec-review`, `plan-review`, `tasks-review`, `implementation-review`, `sibling-review`, `manual-validation`, `pr-feedback`, `address-pr-feedback`, `children-complete`, `epic-approval`, `dependencies`.

### ManualAdvanceMarker

Structured payload for the manual-advance issue comment (AD-1).

```ts
interface ManualAdvanceMarker {
  /** Gate name (e.g. "clarification") */
  gate: string;
  /** GitHub login of the actor running `cockpit advance` — resolved via `gh api user` */
  actor: string;
  /** ISO-8601 timestamp at which the advance happened */
  ts: string;
}
```

Rendered by `formatManualAdvanceComment(marker)` into:

```
<!-- generacy-cockpit:manual-advance gate=<gate> actor=<actor> ts=<ts> -->

Manually advanced `waiting-for:<gate>` → `completed:<gate>` by **@<actor>**.
```

Validation rules:
- `gate` matches `/^[a-z][a-z0-9-]*$/`.
- `actor` matches `/^[A-Za-z0-9-]+$/` (GitHub login charset).
- `ts` parses with `new Date(ts).toISOString() === ts` (round-trip ISO-8601).

These constraints exist so that misuse cannot inject HTML or markdown into the marker comment body.

### ClassifyStateOutput (FR-002)

`cockpit state` `--json` payload:

```ts
interface ClassifyStateOutput {
  /** Echo of input ref in "owner/repo#n" form */
  issue: string;
  /** Curated tier from @generacy-ai/cockpit: pending|active|waiting|error|terminal|unknown */
  state: CockpitState;
  /** The label that drove the classification, or "" for unknown */
  sourceLabel: string;
}
```

Text mode (default) prints one line:
```
owner/repo#123  active  phase:plan
```

### ClarifyContextOutput (FR-009)

`cockpit clarify-context` JSON payload. **Stable schema** — fields are always present, missing data is `null`/empty.

```ts
interface ClarifyContextOutput {
  /** Echo of input ref in "owner/repo#n" form */
  issue: string;
  /** The clarification comment selected per AD-3, or null if none */
  clarificationComment: ClarificationComment | null;
  /** Contents of specs/<branch>/spec.md, or null if not found */
  spec: SpecArtifact | null;
  /** Contents of specs/<branch>/plan.md, or null if not present */
  plan: PlanArtifact | null;
  /** Code references for the in-flight branch, or null if not on a feature branch */
  codeReferences: CodeReferences | null;
}

interface ClarificationComment {
  /** Comment body as posted */
  body: string;
  /** GitHub login of the comment author */
  author: string;
  /** Comment creation timestamp (ISO-8601) */
  createdAt: string;
  /** GitHub URL of the comment */
  url: string;
}

interface SpecArtifact {
  /** Absolute path on disk */
  path: string;
  /** File contents (UTF-8) */
  body: string;
}

interface PlanArtifact {
  path: string;
  body: string;
}

interface CodeReferences {
  /** Files touched on the in-flight branch vs. the base branch */
  touchedFiles: string[];
  /** URL of the open PR for the branch, or null */
  prUrl: string | null;
  /** Short text summary of the PR diff (≤4 KiB), or null if no PR */
  prDiffSummary: string | null;
}
```

Field-by-field rules:

| Field | Source | When null/empty | Cap |
|---|---|---|---|
| `clarificationComment` | gh timeline + comments per AD-3 | No comment after the latest `waiting-for:clarification` label event | n/a |
| `spec.body` | `specs/<branch>/spec.md` on disk | File not found at branch path or fallback path | Read whole file (no cap; specs are small) |
| `plan.body` | `specs/<branch>/plan.md` on disk | File not present (issue may not have run `/plan` yet) | Read whole file |
| `codeReferences.touchedFiles` | `gh pr diff --name-only` or `git diff --name-only <base>...<head>` | No branch / no diffs (returns `[]`, never null) | Unbounded list (file counts are not the size driver) |
| `codeReferences.prUrl` | `gh pr list --head <branch> --json url` | No open PR for branch | n/a |
| `codeReferences.prDiffSummary` | `gh pr diff --patch` truncated | No PR | **4 KiB** then `…[truncated]` suffix |

### AdvanceResult (internal)

Return shape from `runAdvance()`:

```ts
type AdvanceResult =
  | { kind: 'advanced'; gate: string; commentUrl: string }
  | { kind: 'already-advanced'; gate: string }
  | { kind: 'rejected'; reason: string; activeGate: string | null };
```

The `rejected` shape feeds the error message — `activeGate` is the actual `waiting-for:*` on the issue, or `null` if none is set.

## Relationships

```
WORKFLOW_LABELS  (workflow-engine)
        │
        │  pair waiting-for:<x> with completed:<x>
        ▼
   GATES (cockpit/gate-vocabulary.ts)
        │
        │  used by
        ▼
   advanceCommand ──┐
                    │
                    ├── parseIssueRef ──> IssueRef
                    │
                    ├── classify (cockpit) ──> CockpitState
                    │
                    └── GhCliWrapper / runner ──> gh CLI
```

```
clarifyContextCommand
    │
    ├── parseIssueRef ──> IssueRef
    │
    ├── findClarificationComment (gh timeline + comments) ──> ClarificationComment | null
    │
    ├── readSpecArtifacts(branch) ──> { SpecArtifact | null, PlanArtifact | null }
    │
    └── gatherCodeReferences(branch, repo) ──> CodeReferences | null
                    │
                    └── output: ClarifyContextOutput (stdout JSON)
```

## Invariants

- **GATES is read-only and static.** Construction happens once at module load. There is no mutation path.
- **Output JSON is stdout-only.** No `console.log` in helpers; all logging goes through `getLogger()` (stderr).
- **No file mutation.** None of the three verbs writes to disk in `specs/` or anywhere else. (`advance` writes to GitHub via comment + label; `state` and `clarify-context` are pure reads.)
- **Idempotency token = label state, not comment scan.** `advance` decides re-runs by checking for `completed:<gate>` on the issue, not by parsing comment history (AD-6).

## Edge Cases Worth Calling Out

1. **Issue is closed/merged** (FR-013, P2). All three verbs report `state: 'terminal'` and exit normally for `state`. `advance` refuses (you can't waiting-for a closed issue). `clarify-context` refuses (FR-008: must be in `waiting-for:clarification`).
2. **No `gh auth`**. The first gh call fails; `failIfNonZero` in the wrapper throws with `gh ... failed (exit N): ...`, surfaced to the user. FR-011 satisfied.
3. **Spec dir missing**. `clarify-context` emits `spec: null`. The consumer is required to handle this (stable schema).
4. **PR not yet opened on a branch**. `codeReferences.prUrl: null`, `codeReferences.prDiffSummary: null`, but `touchedFiles` still comes from `git diff` against the base branch (likely `develop`).
5. **Branch not in `specs/` layout** (e.g., running on `main`). `spec` and `plan` are `null`; `codeReferences` is also `null`.
6. **Gate name typo** (`--gate clarificaton`). Exit non-zero with: `Unknown gate "clarificaton". Valid gates: clarification, clarification-review, …`.
7. **Active gate ≠ requested gate**. Exit non-zero with: `Cannot advance gate "plan-review": issue is waiting on "clarification". Pass --gate clarification or resolve the active gate first.` No `--force` in v1 (AD-4).
