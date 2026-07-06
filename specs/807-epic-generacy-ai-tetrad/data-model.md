# Data Model: Cockpit `context` Bundles (#807)

All three bundle variants are emitted as single-line JSON on stdout. The top-level discriminator is `bundle.gate` (verbatim `waiting-for:*` label). Exit code semantics: `0` on any successful bundle; `1` on gh-IO failure; `2` on ref-parse failure; `3` on gate refusal (including PR-scoped gate with no resolvable PR, and `completed:validate` passed in).

## Shared types

```ts
export interface IssueRef {
  owner: string;                    // "generacy-ai"
  repo:  string;                    // "generacy"
  number: number;                   // 807
  nwo:   string;                    // "generacy-ai/generacy" — convenience for gh
}

export interface ResolvedIssueContext {
  ref: IssueRef;
  repo: string;                     // "generacy-ai/generacy" — same as ref.nwo (retained
                                     // for legacy call-site compatibility)
  gh: GhWrapper;                    // engine gh wrapper (extended per Phase 0)
}

export interface ArtifactOutput {
  path: string;                     // absolute or repo-root-relative
  body: string;
}

export interface ClarificationCommentOutput {
  body: string;
  author: string;
  createdAt: string;                // ISO-8601
  url: string;
}

export interface CodeReferences {
  prUrl: string;
  touchedFiles: string[];
  diffPatch: string;                // uncapped — code-references needs full patch
}

export type ContextGate =
  | 'waiting-for:clarification'
  | 'waiting-for:implementation-review'
  | 'waiting-for:spec-review'
  | 'waiting-for:plan-review'
  | 'waiting-for:tasks-review';
```

## Bundle 1 — Clarification (`waiting-for:clarification`)

```ts
export interface ClarificationBundle {
  issue: string;                    // "owner/repo#n"
  gate: 'waiting-for:clarification';
  clarificationComment: ClarificationCommentOutput | null;
  spec: ArtifactOutput | null;
  plan: ArtifactOutput | null;
  codeReferences: CodeReferences | null;
}
```

**Emission rule**: Fields shape unchanged from today's `clarify-context.ts` except for the added `gate` discriminator. `null` when the resource cannot be found (file missing, no unresolved clarification comment, no linked PR for code refs).

**Validation**:
- `issue` matches `/^[^/\s]+\/[^/\s]+#\d+$/`.
- `clarificationComment.createdAt` parses as ISO-8601 (spot-checked in tests).
- `spec.path` and `plan.path` end in `.md`.

## Bundle 2 — Implementation review (`waiting-for:implementation-review`)

```ts
export interface ImplementationReviewBundle {
  issue: string;                    // "owner/repo#n"
  gate: 'waiting-for:implementation-review';
  pr: {
    number: number;
    title: string;
    url: string;
    base: string;
    head: string;
    body: string;
    author: string | null;
    state: 'OPEN' | 'CLOSED' | 'MERGED';
    draft: boolean;
  };
  diff: string;                     // capped at 256 KiB
  diffTruncated: boolean;
  checks: Array<{
    name: string;
    state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED';
    conclusion?: string;
    url?: string;
  }>;
}
```

**Emission rule**: Delegates to `buildReviewContextPayload` from `shared/review-context-json.ts`. `issue` and `gate` are prepended at the `context.ts` layer; the payload builder is reused verbatim.

**Refusal rules**:
- If `gh.resolveIssueToPRRef(nwo, number)` returns `null`, exit **3** with diagnostic `Error: cockpit context: gate refusal: issue owner/repo#n at waiting-for:implementation-review but no linked PR resolved` (per Q4 → A).

## Bundle 3 — Artifact paths (`waiting-for:{spec,plan,tasks}-review`)

```ts
export interface ArtifactPathsBundle {
  issue: string;                    // "owner/repo#n"
  gate: 'waiting-for:spec-review' | 'waiting-for:plan-review' | 'waiting-for:tasks-review';
  artifacts: {
    spec:  ArtifactOutput | null;   // always emitted; null when file missing
    plan:  ArtifactOutput | null;
    tasks: ArtifactOutput | null;
  };
}
```

**Emission rule (Q1 → D)**: All three artifacts always emitted regardless of which review gate is active. `null` when the file does not exist under `specs/<branch>/` (with the same directory-discovery logic as today's `clarify-context` — `specs/<branch>/` first, then scan for `specs/<n>-*` prefix).

**Uniform shape justification**: Parallel to the clarification bundle's spec/plan pair. Reviewing a plan legitimately needs the spec alongside it; downstream consumers do not have to branch on which gate fired.

## Error path — CockpitExit contract

```ts
export class CockpitExit extends Error {
  readonly code: 0 | 1 | 2 | 3;
  constructor(code: 0 | 1 | 2 | 3, message: string) { … }
}
```

| Exit | Trigger | Diagnostic prefix |
|---|---|---|
| 0 | Successful bundle emitted to stdout | — |
| 1 | `gh` command failed (non-zero exit, malformed JSON, schema mismatch) | `Error: cockpit context: gh <op>: <reason>` |
| 2 | `parseIssueRef` threw (invalid ref shape, bare number without cwd inference) | `Error: cockpit context: parse issue: <reason>` |
| 3 | Gate refusal (no `waiting-for:*` label, unsupported gate, `completed:validate`, PR-scoped gate with no PR) | `Error: cockpit context: gate refusal: <reason>` |

## Resolver contract

```ts
export function parseIssueRef(input: string): IssueRef;                 // pure; throws on bare number
export async function resolveIssueContext(input: {
  issue: string;
  repo?: string;                    // internal-only override (Q5 clarification: no CLI surface)
  cwd?:  string;
}): Promise<ResolvedIssueContext>;
```

**Rules**:
- `parseIssueRef` accepts `owner/repo#N` or full `https://github.com/owner/repo/(issues|pull)/N` URL. Bare numbers throw.
- `resolveIssueContext` first tries `parseIssueRef`. If that throws with a bare-number reason, it attempts `git remote get-url origin` inference and re-parses as `<inferred>/<n>`.
- Both functions loud-fail — no silent fallbacks.

## Test data (fixtures)

Reuse existing fixtures from `__tests__/fixtures/` for gh JSON blobs. New fixtures added:
- `context.clarification.fixture.json` — labels, timeline, comments, PR-link body → clarification bundle golden.
- `context.implementation-review.fixture.json` — labels + PR-detail + checks → implementation-review bundle golden.
- `context.artifact-paths.fixture.json` — labels + on-disk spec/plan/tasks → artifact-paths bundle golden (matrix: any-1, any-2, all-3 present).
