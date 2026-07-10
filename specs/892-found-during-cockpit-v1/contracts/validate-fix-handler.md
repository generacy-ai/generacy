# Contract: `ValidateFixHandler`

**Feature**: `892-found-during-cockpit-v1`
**Covers**: FR-004, FR-005; Q3→B, Q4→A, Q5→A, D5, D7, D9.

## Purpose

Run **exactly one** autonomous agent attempt to fix a `failed:validate` red that persisted on a fresh merge-preview. Bounded by evidence hash: same red as before → escalation, no spawn. Terminates on no-diff (#883). Emits observability events on a distinct channel (`cluster.validate-fix`).

## Constructor

```ts
new ValidateFixHandler(
  config: WorkerConfig,          // provides credentialRole (Q5→A)
  agentLauncher: AgentLauncher,
  phaseTracker: PhaseTracker,
  logger: Logger,
  emitEvent?: (channel: string, payload: unknown) => void,   // POST /internal/relay-events wiring
)
```

- No new `WorkerConfig` fields. `credentialRole` is the existing field consumed by `PrFeedbackHandler`.
- `emitEvent` optional: cluster boots without relay wiring degrade to "logs only," matching sibling handler patterns.

## Invocation contract (ordering — D7)

`handle()` MUST be invoked from exactly one call site: `PhaseLoop`'s validate `catch` block, gated by `WorkerContext.resumeReason === 'base-advance'`. Any other call site is a spec violation.

Signature:

```ts
async handle(
  item: QueueItem,                                // { owner, repo, issueNumber, prNumber, baseBranch, ... }
  checkoutPath: string,                           // repo working tree (post-merge-preview)
  validateEvidence: {
    stdout: string;                               // full CLI stdout (FR-005 payload)
    stderr: string;
    exitCode: number;
  },
  github: GitHubClient,
): Promise<void>
```

## Execution

Sequential, all failure paths early-return with an emit:

1. **Hash evidence**
   - `const { hash, extract } = hashValidationEvidence(validateEvidence.stdout)`.
   - Log at `info`: `{ owner, repo, issueNumber, evidenceHash: hash, failureCount: extract.failures.length }`.

2. **Dedupe check**
   - `if (await phaseTracker.isDuplicate(owner, repo, issueNumber, `validate-fix:${hash}`))` → escalation:
     - `github.addLabels(owner, repo, issueNumber, ['blocked:stuck-validate-fix', 'agent:error'])`.
     - `github.removeLabels(owner, repo, issueNumber, ['phase:validate', 'agent:in-progress'])`.
     - `emitEvent?.('cluster.validate-fix', { status: 'escalated', reason: 'duplicate-evidence-hash', evidenceHash: hash, owner, repo, issueNumber, prNumber, timestamp: new Date().toISOString() })`.
     - `return` — no spawn.

3. **Mark processed** (write the key BEFORE spawning; spawn is the "one attempt" this key claims)
   - `await phaseTracker.markProcessed(owner, repo, issueNumber, `validate-fix:${hash}`)`.
   - Rationale: if the spawn crashes mid-flight, the key remaining prevents a duplicate attempt on cluster restart. The 24 h TTL bounds the "stuck without attempt" recovery window.

4. **Collect sibling-owned files** (Q4→A, D9)
   - `const siblingFiles = await collectSiblingOwnedFiles(github, owner, repo, item.baseBranch, item.prNumber)`.
   - Errors from `prDiffNames` per PR → per-PR `warn` log; continue with partial file set. A missed sibling risks duplication (defense-in-depth check at step 7 catches it), but never blocks the spawn.

5. **Build prompt**
   - Include full `validateEvidence.stdout` verbatim (FR-005).
   - Include `extract.failures` (rendered as "Failure 1: <id> — <firstError>" per line).
   - Include `siblingFiles` as a "Do not create these files (they belong to sibling PRs):" list.
   - Include hash: `Evidence hash: <hash>` (surfaces to agent for debugging).

6. **Spawn** (Q5→A — same role, same credentials as originating validate)
   ```ts
   const handle = await agentLauncher.launch({
     intent: { kind: 'validate-fix', prNumber: item.prNumber, prompt, evidenceHash: hash },
     cwd: checkoutPath,
     env: {},
     credentials: buildLaunchCredentials(config.credentialRole),
   });
   const exitCode = await handle.process.exitPromise;
   ```
   - Timeout: `config.phaseTimeoutMs` (same as `PrFeedbackHandler`).
   - Stdout captured via existing `OutputCapture` pattern.
   - `exitCode !== 0` is not fatal per se — the tree-change check in step 7 is the actual termination gate (#883).

7. **Commit + push + no-diff check** (#883 termination discipline)
   - `const hasChanges = await commitAndPushChanges(checkoutPath, item, `validate-fix: ${hash.slice(0, 12)}`)`.
   - Defense-in-depth sibling-file overlap check (D9):
     - `const committedFiles = await getCommittedFileNames(checkoutPath, previousHead)`.
     - `const overlap = committedFiles.filter(f => siblingFiles.includes(f))`.
     - If `overlap.length > 0`:
       - Revert commit locally (`git reset --hard HEAD~1`); no push (nothing to push yet — commit was local until the push line, so if the check fires after push, we push a revert commit instead).
       - Actually: implementation runs check *before* push. `commitAndPushChanges` split into `commitChanges` + `pushChanges` for this reason. See implementation notes below.
       - `github.addLabels(owner, repo, issueNumber, ['blocked:stuck-validate-fix'])`.
       - `emitEvent?.('cluster.validate-fix', { status: 'blocked', reason: 'sibling-file-overlap', evidenceHash: hash, overlappingFiles: overlap, owner, repo, issueNumber, prNumber, timestamp: … })`.
       - `return`.
   - If `hasChanges === false` (agent produced no diff — #883):
     - `github.addLabels(owner, repo, issueNumber, ['blocked:stuck-validate-fix'])`.
     - `emitEvent?.('cluster.validate-fix', { status: 'blocked', reason: 'no-diff', evidenceHash: hash, owner, repo, issueNumber, prNumber, timestamp: … })`.
     - `return`.
   - Push. Emit `{ status: 'attempted', evidenceHash: hash, … }`. Re-validate is triggered by the resume path picking up the push (existing behavior); this handler does NOT re-run validate itself.

## Sibling-guard implementation notes

- `collectSiblingOwnedFiles` implementation:
  ```ts
  private async collectSiblingOwnedFiles(github, owner, repo, baseBranch, ownPrNumber) {
    const openPRs = await github.listOpenPullRequests(owner, repo);
    const siblings = openPRs.filter(pr => pr.base === baseBranch && pr.number !== ownPrNumber);
    const files: string[] = [];
    for (const pr of siblings) {
      try {
        const names = await github.prDiffNames(`${owner}/${repo}`, pr.number);
        files.push(...names);
      } catch (err) {
        this.logger.warn({ owner, repo, siblingPr: pr.number, err: String(err) }, 'sibling prDiffNames failed; continuing');
      }
    }
    return [...new Set(files)];
  }
  ```
- `getCommittedFileNames`: `git diff --name-only <previousHead> HEAD` in the checkout — new file added → present; existing file modified → present. Overlap with `siblingFiles` = duplication.

## Failure modes

| Failure | Behavior |
|---------|----------|
| `hashValidationEvidence` throws | Bug — should never throw for valid stdout. Log `error`, escalate as if duplicate hash (safe default). |
| `phaseTracker.isDuplicate` degraded (Redis unavailable) → returns `false` | Spawn proceeds. Bound is `phaseTracker.markProcessed` also failing → the key is not written → next re-run also spawns. `blocked:stuck-validate-fix` label eventually applied after N no-diff attempts. Realistic: Redis outages are minutes; the 24 h TTL bound applies once Redis returns. |
| `agentLauncher.launch` throws | `warn` log, `blocked:stuck-validate-fix` label applied, emit `{ status: 'blocked', reason: 'launch-error', … }`. Key already marked processed; no auto-retry. |
| `commitAndPushChanges` throws mid-push | Local commit exists but not pushed. Next cycle sees `hasChanges === true` locally but the PR branch is stale. Detection: `git diff origin/<branch>...HEAD` non-empty. Implementation: `commitAndPushChanges` catches push errors, keeps local commit, emits `{ status: 'blocked', reason: 'push-error', … }`. |
| `github.addLabels` fails | Best-effort; log `warn`. Emit still fires. |
| `emitEvent` throws | Best-effort; log `warn`. Do NOT re-throw. Sibling handlers (`cluster.audit`, `cluster.credentials`) follow this pattern. |
| Sibling `prDiffNames` throws for one PR | Per-PR `warn` log; continue with partial file set. Post-hoc overlap check catches leakage. |

## Test surface

Injections: `agentLauncher` stub (returns handle with configurable exitCode + tree mutations), `phaseTracker` real `PhaseTrackerService` on `ioredis-mock`, `github` stub with canned methods.

Required test cases:
1. **First red on this hash** — `isDuplicate` returns false; assert `markProcessed` called; assert `agentLauncher.launch` called with `intent.kind === 'validate-fix'` and `credentials` from `credentialRole`.
2. **Duplicate hash** — `isDuplicate` returns true; assert NO `markProcessed`, NO `launch`; assert `escalation` event emitted with `reason: 'duplicate-evidence-hash'`.
3. **No-diff termination** — spawn returns exitCode 0 but no tree changes; assert `blocked` event with `reason: 'no-diff'`; assert `blocked:stuck-validate-fix` label added.
4. **Sibling file overlap** — spawn creates file `src/components/CopyButton.tsx`; `siblingFiles` includes it; assert commit reverted, `blocked` event with `reason: 'sibling-file-overlap'` and `overlappingFiles` array.
5. **Successful attempt** — spawn changes tree, no sibling overlap; assert push happens, `attempted` event emitted.
6. **Spawn crash** — `agentLauncher.launch` throws; assert `blocked` event with `reason: 'launch-error'`; assert key remains processed (so this doesn't retry).
7. **Sibling `prDiffNames` failure** — one sibling PR's diff throws; assert warn logged; assert spawn proceeds with partial file list.
8. **`credentialRole` inheritance** — construct with `config.credentialRole = 'speckit-feature'`; spawn call receives `credentials.role === 'speckit-feature'`.
9. **Idempotent event shape** — every emit path matches the schema in `data-model.md` (status is one of the enumerated values, evidenceHash is 64-hex, timestamp is ISO-8601).

## Non-goals

- Does NOT re-run validate itself. The resume path picks up the push and re-validates via existing `PhaseLoop` logic.
- Does NOT clear `failed:validate` on success. The next resume's `LabelManager.onStart('validate')` handles that.
- Does NOT touch `phase-tracker:process:*` or `phase-tracker:resume:*` keys. Its dedupe surface is `phase-tracker:validate-fix:<hash>` exclusively.
- Does NOT emit metadata to the epic-completion monitor. Cross-epic scope is out of the feature.
- Does NOT retry on any failure. Exactly one attempt per distinct evidence hash — subsequent attempts require operator DEL of the dedupe key (documented in `quickstart.md` troubleshooting).
