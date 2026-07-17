# Data Model: FR-003 guard + FR-002 re-add

## Core additions in `packages/orchestrator/src/worker/label-manager.ts`

### `AllowGateComplete` (const enum-like frozen object)

```ts
/**
 * Closed union of legitimate writers of `completed:<human-gate>` labels.
 *
 * Currently a single member — `cockpit advance` (the CLI command that also
 * posts the `<!-- generacy-cockpit:manual-advance -->` audit comment). The CLI
 * writes labels over the wire via `gh addLabel` and does NOT invoke
 * `LabelManager`, so this token has zero in-process call sites today; it exists
 * as a public export for future in-process writers that will need to
 * explicitly opt in through the seam guard.
 *
 * DO NOT extend without a corresponding audit-comment marker design — see
 * spec §Out-of-scope for the `ApproveReview` case (#941 Q2 → B).
 */
export const AllowGateComplete = Object.freeze({
  CockpitAdvance: 'cockpit-advance',
} as const);

export type AllowGateComplete = typeof AllowGateComplete[keyof typeof AllowGateComplete];
```

### `HumanGateCompletionUnauthorizedError`

```ts
export class HumanGateCompletionUnauthorizedError extends Error {
  readonly label: string;
  readonly allowedTokens: readonly string[];

  constructor(label: string) {
    super(
      `refused to add "${label}": ` +
        `writing completed:<human-gate> requires an AllowGateComplete token ` +
        `(none passed). Only the cockpit-advance path may complete a human ` +
        `gate. See #941.`,
    );
    this.name = 'HumanGateCompletionUnauthorizedError';
    this.label = label;
    this.allowedTokens = Object.values(AllowGateComplete);
  }
}
```

### `HUMAN_GATE_SUFFIXES` (module-const derived set)

```ts
import { GATE_MAPPING, WORKFLOW_GATE_MAPPING } from './phase-resolver.js';

const HUMAN_GATE_SUFFIXES: ReadonlySet<string> = (() => {
  const s = new Set<string>(Object.keys(GATE_MAPPING));
  for (const map of Object.values(WORKFLOW_GATE_MAPPING)) {
    for (const gateName of Object.keys(map)) s.add(gateName);
  }
  return s;
})();

/** Returns true when `label` is `completed:<X>` and X is a known gate suffix. */
export function isHumanGateCompletion(label: string): boolean {
  if (!label.startsWith('completed:')) return false;
  return HUMAN_GATE_SUFFIXES.has(label.slice('completed:'.length));
}
```

### Modified `LabelManager.applyLabels` signature

```ts
private async applyLabels(
  labels: string[],
  allow?: AllowGateComplete,
): Promise<void> {
  // FR-003: reject unauthorized human-gate completion adds before any
  // network call. Throws HumanGateCompletionUnauthorizedError.
  if (allow == null) {
    for (const label of labels) {
      if (isHumanGateCompletion(label)) {
        throw new HumanGateCompletionUnauthorizedError(label);
      }
    }
  }
  // ... existing lineage-map enrichment + this.github.addLabels(...) unchanged.
}
```

### Call-site audit (all six current callers stay token-less)

| Method | Labels it writes | Contains `completed:<human-gate>`? |
|---|---|---|
| `onPhaseStart` | `phase:<phase>` | No |
| `onPhaseComplete` | `completed:<phase>` | No — phase names never alias gate suffixes |
| `onGateHit` | `waiting-for:<gate>, agent:paused` | No |
| `onError` | `failed:<phase>, agent:error` | No |
| `onResumeStart` | `agent:in-progress` | No |
| `ensureRepoLabelsExist` | (uses `createLabel`, not `addLabels`) | N/A |

No call site changes; the guard is a pure additive invariant.

## Additions in `packages/orchestrator/src/worker/pr-feedback-handler.ts`

### Module-level constants

```ts
/** #941 FR-002: gate label the fix-session must leave present on exit. */
const WAITING_FOR_IMPLEMENTATION_REVIEW_LABEL = 'waiting-for:implementation-review';
```

### New private method

```ts
/**
 * #941 FR-002: after the fix session terminates, assert that
 * `waiting-for:implementation-review` is still on the linked issue. If it is
 * missing (some other code path stripped it between pause and exit), emit a
 * structured `error` log AND idempotently re-add the label. Non-fatal on
 * failure — never throws so the shared `finally` in `handle()` cannot break
 * on `agent:in-progress` cleanup.
 *
 * Ordering: called from `handle()`'s shared `finally` BEFORE
 * `clearInProgressLabel(...)` so the terminal transient state is never
 * `{ agent:in-progress present, waiting-for:implementation-review absent }`.
 */
private async ensureImplementationReviewGate(
  github: GitHubClient,
  owner: string,
  repo: string,
  issueNumber: number,
  prNumber: number,
): Promise<void> {
  let labels: string[];
  try {
    const issue = await github.getIssue(owner, repo, issueNumber);
    labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
  } catch (err) {
    this.logger.warn(
      { err: String(err), issueNumber, prNumber },
      'ensureImplementationReviewGate: failed to read labels — non-fatal',
    );
    return;
  }

  if (labels.includes(WAITING_FOR_IMPLEMENTATION_REVIEW_LABEL)) {
    this.logger.debug(
      { issueNumber, prNumber },
      'ensureImplementationReviewGate: gate label already present',
    );
    return;
  }

  this.logger.error(
    {
      event: 'gate-label-missing-at-fix-exit',
      owner,
      repo,
      issueNumber,
      pr: prNumber,
    },
    'waiting-for:implementation-review missing at fix-session exit — re-adding (FR-002)',
  );

  try {
    await github.addLabels(owner, repo, issueNumber, [
      WAITING_FOR_IMPLEMENTATION_REVIEW_LABEL,
    ]);
  } catch (err) {
    this.logger.warn(
      { err: String(err), issueNumber, prNumber },
      'ensureImplementationReviewGate: failed to re-add gate label — non-fatal',
    );
  }
}
```

### Modified `finally` block

```ts
} finally {
  // #941 FR-002: re-assert waiting-for:implementation-review BEFORE
  // clearing agent:in-progress, so no transient state omits the gate.
  await this.ensureImplementationReviewGate(github, owner, repo, issueNumber, prNumber);
  await this.clearInProgressLabel(github, owner, repo, issueNumber);
}
```

## Data flow — the invariant

```
                     ┌───────────────────────────┐
   worker/monitor    │ orchestrator process      │
   emits label edit  │                           │
        │            │                           │
        v            │  ┌─────────────────────┐  │
   ┌──────────┐      │  │ LabelManager        │  │
   │ any code │──────┼─▶│ .applyLabels(…, ?)  │  │
   │ path     │      │  │  ├─ guard: reject   │──┼──▶ throw HumanGateCompletionUnauthorizedError
   └──────────┘      │  │  │   completed:<hg> │  │
                     │  │  │   without token  │  │
                     │  │  └─▶ github.addLabels│  │
                     │  └─────────────────────┘  │
                     └───────────────────────────┘
   cockpit advance  ─────────────────────────────────▶ GitHub API
   (CLI process, gh addLabel — no LabelManager)         (writes completed:<hg>
                                                         + posts audit comment)
```

Two-writer topology by construction: one in-process seam (guarded, no legitimate current writers of `completed:<human-gate>`), one out-of-process CLI (writes `completed:<hg>` + audit marker). Anyone else who wants to write `completed:<hg>` in-process must import `AllowGateComplete` and change the signature at the call site — a change that shows up in code review.

## Relationships to existing types

- `WorkflowPhase` (from `worker/types.ts`) — untouched. Phase suffixes stay disjoint from human-gate suffixes.
- `GateDefinition` (from `worker/config.ts`) — untouched. Guard reads `GATE_MAPPING` instead of the schema so a repo-level config override cannot silently expand the guarded set.
- `TerminalLabelOpError` (`worker/terminal-label-op-error.ts`) — untouched. If the guard throws inside `retryWithBackoff`, the third retry surfaces as `TerminalLabelOpError` with `cause: HumanGateCompletionUnauthorizedError`, which is the desired diagnostic shape for `WorkerResult.status === 'failed-terminal'`.
