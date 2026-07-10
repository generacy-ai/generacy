# Contract: Failure-alert comment for `stage: 'label-op'`

**Extends**: `specs/865-found-during-cockpit-v1/contracts/failure-alert-comment.md` (additive).
**Emitter**: `WorkerDispatcher.emitTerminalFailureRecovery(...)` (NEW), delegating to `StageCommentManager.postFailureAlert(...)`.
**Trigger**: `WorkerResult.status === 'failed-terminal'` on `runWorker`'s handler return.

## Additive extension to `FailureAlertData.stage`

The existing `FailureAlertStage` union grows one new value:

```ts
export type FailureAlertStage =
  | 'specify' | 'clarify' | 'plan' | 'tasks' | 'implement' | 'validate'
  | 'label-op';  // NEW in #889
```

## Body layout for `stage: 'label-op'`

Byte-shape matches the #865 contract exactly. Only the summary line's text differs:

```
<!-- generacy:failure-alert:label-op:<runId> -->
❌ **label operation failed** — `<labelOp>` at site `<site>` (exited 1).

<details><summary>stderr (last N lines)</summary>

```text
<ghStderr, backtick-neutralized>
```

</details>
```

**Field mappings**:

- `<runId>` — fresh `crypto.randomUUID()` minted at the dispatcher's terminal-recovery call site.
- `<labelOp>` — copied from `WorkerResult.failureMetadata.labelOp` (e.g., `"addLabels([waiting-for:merge-conflicts, agent:paused])"`).
- `<site>` — copied from `WorkerResult.failureMetadata.site` (`gate-hit` / `phase-start` / ...).
- `<ghStderr>` — copied from `WorkerResult.failureMetadata.ghStderr`, subjected to the existing backtick-neutralization (`.replace(/```/g, '`​``')`).
- `N` — `ghStderr.split('\n').length`.

## Deduplication

Follows the existing #865 rule: marker-scan against issue comments; a matching `(stage='label-op', runId=<X>)` marker in a prior comment suppresses re-posting. Because `runId` is fresh per dispatch, this only dedupes retried recovery attempts within the same dispatch call — the intended behavior.

## `evidence` construction

`StageCommentManager.postFailureAlert(...)` accepts an `evidence: { command; exitDescriptor; stderrTail }` object. For `stage: 'label-op'`:

- `command` — a printable rendition of the failing `gh` call, e.g. `"gh issue edit --add-label waiting-for:merge-conflicts"`. If `labelOp` already carries the operation description, `command` is `"gh issue edit"` and `labelOp` is the summary — the exact wording is decided at implementation-time to fit the existing summary-line grammar.
- `exitDescriptor` — always `"exited 1"` for label failures.
- `stderrTail` — copied from `failureMetadata.ghStderr` verbatim (backtick-neutralization applied by `renderFailureAlert`).

## Non-changes

- Marker prefix `<!-- generacy:failure-alert:` — unchanged.
- Marker suffix ` -->` — unchanged.
- `<details>` block structure — unchanged.
- `` ```text `` fence — unchanged.
- Dedup semantics — unchanged.
