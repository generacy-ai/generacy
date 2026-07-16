# Data Model: #958

Changes are largely behavioral. New shared constants, a new marker family, one monitor service, and one cockpit tool. Everything else is type-preserving edits to existing functions.

## New constants & modules

### `PENDING_ANSWER_LITERAL` + `isPendingAnswerValue`

**Location**: `packages/orchestrator/src/worker/pending-literal.ts` (new).

**Exports**:

```ts
export const PENDING_ANSWER_LITERAL = '*Pending*';

/**
 * True iff `v` should be treated as an unanswered clarification value.
 * Accepts: PENDING_ANSWER_LITERAL, empty string, whitespace-only,
 * any single `[<content>]`-bracketed placeholder (e.g. `[Leave empty for now]`,
 * `[TBD]`, `[TODO]`). Anything not matching one of these is NOT pending.
 */
export function isPendingAnswerValue(v: string): boolean;
```

**Invariants**:

- `isPendingAnswerValue('')` → `true`.
- `isPendingAnswerValue('   ')` → `true` (whitespace-only).
- `isPendingAnswerValue('*Pending*')` → `true`.
- `isPendingAnswerValue('[Leave empty for now]')` → `true`.
- `isPendingAnswerValue('[TBD]')` → `true`.
- `isPendingAnswerValue('[foo] bar')` → `false` (bracketed prefix + text is a real answer).
- `isPendingAnswerValue('A')` → `false`.
- Case-sensitive on `*Pending*`; case-insensitive brackets are not required (Q2 answer's bracketed rule is shape-based, not case-based).

**Consumers**:

- `packages/orchestrator/src/worker/clarification-poster.ts` — replaces `answerText !== '*Pending*'` at L303 with `!isPendingAnswerValue(answerText)`; replaces `answer !== '*Pending*'` at L502 with `!isPendingAnswerValue(answer)`; write-back regex builder at L738 uses `PENDING_ANSWER_LITERAL`.
- `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` — prompt at L55 becomes `**Answer**: ${PENDING_ANSWER_LITERAL}` (template string).
- `packages/generacy/src/cli/commands/cockpit/clarification-answer-marker.ts` — used to render a "no answer supplied for Q<n>" placeholder if the tool receives a sparse `{ [questionNumber]: string }` map.

**Cross-package import strategy**: `PENDING_ANSWER_LITERAL` is exported from `@generacy-ai/orchestrator/dist/worker/pending-literal.js` and imported by `workflow-engine` via a package-level re-export in `@generacy-ai/orchestrator`'s public `index.ts`. If a workflow-engine → orchestrator dependency inversion is undesirable (e.g. leads to a cycle), the constant lives in `@generacy-ai/workflow-engine` (or a fresh `@generacy-ai/speckit-constants` micro-package). Contract prefers the workflow-engine home to avoid the cycle.

### `CLARIFICATION_ANSWER_MARKERS` + match predicates

**Location**: `packages/orchestrator/src/worker/clarification-markers.ts` (extend existing).

**Additions**:

```ts
export const CLARIFICATION_ANSWER_MARKERS: readonly string[] = [
  '<!-- generacy-clarification-answers:',
] as const;

export function commentCarriesAnswerMarker(body: string): boolean;
export function matchClarificationAnswerMarker(body: string): string | undefined;
```

**Invariants** (parallel to `CLARIFICATION_QUESTION_MARKERS`):

- Column-0 match on `\n`-split lines. Quoted (`> `-prefixed) markers do not match.
- Case-sensitive ASCII.
- Growth path: append to the array; no other code changes required.

**Non-overlap with `CLARIFICATION_QUESTION_MARKERS`**: the answer prefix is `<!-- generacy-clarification-answers:` (plural `answers`, distinct suffix); the question family uses `<!-- generacy-clarifications:` (plural `clarifications`), `<!-- generacy-clarification:` (singular `clarification`), etc. No question-marker starts with `<!-- generacy-clarification-answers:` — they diverge at the character after `clarification`. A comment carrying an answer marker is not classified as a question marker.

### `IntegrationResult` extension

**Location**: `packages/orchestrator/src/worker/clarification-poster.ts` (existing type extended).

Before:

```ts
export interface IntegrationResult {
  integrated: number;
  reason?: 'no-spec-dir' | 'no-file' | 'no-pending' | 'no-answers' | 'no-changes';
}
```

After:

```ts
export interface IntegrationResult {
  integrated: number;
  reason?: 'no-spec-dir' | 'no-file' | 'no-pending' | 'no-answers' | 'no-changes' | 'aborted-cluster-self-detector';
  /** FR-010: questions that remained `*Pending*` after the integration pass. */
  parseFailures?: Array<{ questionNumber: number; reason: 'no-source-comment' | 'transition-with-question-headings' | 'pending-value' }>;
  /** FR-010: number of questions still pending after this integration pass. */
  pendingAfter?: number;
}
```

The `aborted-cluster-self-detector` reason is the FR-004 per-poll fail-closed signal (Q3 answer). Callers must not treat an abort as "no answers found" — the log line + relay event distinguish it.

### `ClarificationAnswerMonitorService`

**Location**: `packages/orchestrator/src/services/clarification-answer-monitor-service.ts` (new).

Class shape mirrors `MergeConflictMonitorService` (`packages/orchestrator/src/services/merge-conflict-monitor-service.ts`) verbatim, differing only in:

- Precondition labels: `WAITING_FOR_CLARIFICATION_LABEL = 'waiting-for:clarification'` (was `'waiting-for:merge-conflicts'`).
- Event detection: rather than "label pair is present," the monitor additionally fetches recent comments via `getIssueCommentsWithViewerAuth` and requires ≥1 comment with `viewerDidAuthor === false` newer than a threshold (D2 below).
- Queue command: `command: 'continue'` (was `'resolve-merge-conflicts'`).

```ts
export interface ClarificationAnswerEvent {
  owner: string;
  repo: string;
  issueNumber: number;
  issueLabels: string[];
  source: 'poll';
}

export interface ClarificationAnswerMonitorOptions {
  repositories: RepositoryConfig[];
  pollIntervalMs: number;
  adaptivePolling: boolean;
  maxConcurrentPolls: number;
}

export class ClarificationAnswerMonitorService {
  constructor(
    logger: Logger,
    createClient: GitHubClientFactory,
    queueManager: QueueManager,
    config: PrMonitorConfig,
    repositories: RepositoryConfig[],
    clusterGithubUsername?: string,
    tokenProvider?: () => Promise<string | undefined>,
    authHealth?: AuthHealthSink,
    githubAppCredentialId?: string,
  );
  async processClarificationAnswerEvent(event: ClarificationAnswerEvent): Promise<boolean>;
  async startPolling(): Promise<void>;
  stopPolling(): void;
  async poll(): Promise<void>;
  recordWebhookEvent(): void;
  getState(): Readonly<MonitorState>;
}
```

**"New comment" detection threshold**: the monitor keeps no cross-cycle memory of previously-seen comments (mirrors `MergeConflictMonitorService`'s statelessness). Instead: `enqueueIfAbsent` is the dedupe — if the phase loop has integrated on a previous cycle and re-paused (still `waiting-for:clarification` + `agent:paused`), the next cycle re-enqueues, but if the queue item is still in flight (or the last integration was a no-op), `enqueueIfAbsent` returns `false` and the cycle is a no-op. This is the same trade-off `MergeConflictMonitorService` makes: cheap, stateless, self-healing, occasionally redundant.

### `formatClarificationAnswerComment`

**Location**: `packages/generacy/src/cli/commands/cockpit/clarification-answer-marker.ts` (new).

Mirrors `formatManualAdvanceComment` (`packages/generacy/src/cli/commands/cockpit/manual-advance-marker.ts`).

```ts
export interface ClarificationAnswerMarker {
  batch: number;
  answers: Record<number, string>;
  actor?: string;
  ts: string;
}

export function formatClarificationAnswerComment(marker: ClarificationAnswerMarker): string;
```

**Output shape**:

```
<!-- generacy-clarification-answers:<batch> actor=<actor> ts=<iso> -->

## Answers — batch <batch>

Q1: <answer_1>
Q2: <answer_2>
...
```

**Validation** (regex-gated, mirrors `manual-advance-marker.ts`):

- `batch` must be a non-negative integer.
- `actor`, when present, must match `/^[A-Za-z0-9-]+$/`.
- `ts` must round-trip through `new Date(ts).toISOString()`.
- `answers` keys must all be positive integers; values must be non-empty strings (empty value → tool caller error, don't stamp an empty `Q<n>:` line).

The header carries the marker in the exact shape `commentCarriesAnswerMarker` looks for. The `Q<n>:` line format is the primary supported parser flow (spec §"Fix" and Observed B table row 1). Prose forms are deliberately not emitted.

### `runClarifyRelay` + `cockpit_relay_clarify_answers` MCP tool

**Location**:
- `packages/generacy/src/cli/commands/cockpit/clarify-relay.ts` (new).
- `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_relay_clarify_answers.ts` (new).

**CLI form** (`runClarifyRelay`): callable programmatically by `cockpit_relay_clarify_answers`; not registered as a CLI verb in v1 (adding a top-level `cockpit clarify-relay <issue>` verb is a follow-up; the skill invocation surface is the MCP tool).

```ts
export interface ClarifyRelayInput {
  issue: IssueRef;
  batch: number;
  answers: Record<number, string>;
  actor?: string;
}

export interface ClarifyRelayResult {
  commentUrl: string;
  completedLabel: 'completed:clarification';
}

export async function runClarifyRelay(
  input: ClarifyRelayInput,
  deps: ClarifyRelayDeps,
): Promise<ClarifyRelayResult>;
```

**MCP tool** (`cockpit_relay_clarify_answers`): Zod-validated input; wraps `runClarifyRelay`; returns `ToolResult<ClarifyRelayResult>`. Follows the same envelope as `cockpit_advance` (`packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_advance.ts`).

## Modified types

### `WorkerContext.item.queueReason`

No change to the enum, but the monitor emits `queueReason: 'resume'` items with `command: 'continue'`. The phase resolver already dispatches `continue` (mirror `MergeConflictMonitorService`'s emissions).

### `LabelManager.onGateHit`

FR-008 moves `onPhaseComplete(phase)` past the gate check. `onGateHit`'s current retract-the-completed-label branch (`packages/orchestrator/src/worker/label-manager.ts:226-229`, removes `completedLabel` alongside `phaseLabel`) becomes dead code: `completed:<phase>` is never applied before the gate check. The `removeLabels` list drops `completedLabel`; the fn signature is preserved.

Preserving a comment in-code explaining the reason (FR-008 in this spec) keeps a future reader from re-adding the retract branch after seeing "why isn't it removing completed?"

## Relationships / dependencies

- `pending-literal.ts` → imported by `clarification-poster.ts`, `clarify.ts` (workflow-engine), `clarification-answer-marker.ts` (cockpit).
- `clarification-markers.ts` (extended) → imported by `clarification-poster.ts` (author-scanner surface), `clarification-answer-marker.ts` (validates round-trip against the stamped marker).
- `clarification-answer-monitor-service.ts` → imports `AuthHealthSink` from `label-monitor-service.ts`, `filterByAssignee` from `identity.ts`, `QueueManager`+`QueueItem` from `types/monitor.js`, `JitTokenError` from `@generacy-ai/control-plane`, `GhAuthError` + `GitHubClientFactory` from `@generacy-ai/workflow-engine` — all reused from the merge-conflict monitor.
- `server.ts` → wires `ClarificationAnswerMonitorService` alongside `MergeConflictMonitorService` with the same DI arguments.
- `cockpit_relay_clarify_answers` (MCP tool) → registered in `packages/generacy/src/cli/commands/cockpit/mcp/server.ts` (`server.registerTool('cockpit_relay_clarify_answers', ...)`).
- Cockpit clarify skill (`.claude/skills/cockpit-clarify/*`) → invokes `cockpit_relay_clarify_answers` in place of the freehand `gh issue comment` step.
