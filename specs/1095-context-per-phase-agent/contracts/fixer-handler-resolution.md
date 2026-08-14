# Contract: fixer-handler agent resolution parity

**Scope**: `validate-fix-handler` and `merge-conflict-handler` come to parity with `pr-feedback-handler`'s existing agent-config resolution.

## Reference implementation

`packages/orchestrator/src/worker/pr-feedback-handler.ts:859-880`:

```ts
const { provider, model } = resolveAgentForPhase(this.config, workflowName, 'implement');

this.logger.info(
  { cwd: checkoutPath, timeoutMs: this.config.phaseTimeoutMs, provider, model },
  'Spawning Claude CLI for PR feedback',
);

const handle = await this.agentLauncher.launch({
  intent: {
    kind: 'pr-feedback',
    prNumber,
    prompt,
    ...(model !== undefined ? { model } : {}),
  } as PrFeedbackIntent,
  cwd: checkoutPath,
  env: {},
  credentials: buildLaunchCredentials(this.config.credentialRole),
  provider,
});
```

Extended for this feature to also spread `effort` when set:

```ts
const { provider, model, effort } = resolveAgentForPhase(this.config, workflowName, 'implement');

const handle = await this.agentLauncher.launch({
  intent: {
    kind: 'pr-feedback',
    prNumber,
    prompt,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  } as PrFeedbackIntent,
  cwd: checkoutPath,
  env: {},
  credentials: buildLaunchCredentials(this.config.credentialRole),
  provider,
});
```

## validate-fix-handler — required change

**Current** (`packages/orchestrator/src/worker/validate-fix-handler.ts:126-141`):

```ts
const intent: ValidateFixIntent = {
  kind: 'validate-fix',
  prNumber,
  prompt,
  evidenceHash: hash,
};

const handle = await this.agentLauncher.launch({
  intent,
  cwd: checkoutPath,
  env: {},
  credentials: buildLaunchCredentials(this.config.credentialRole),
});
```

**Required** (matching pattern above, plus `workflowName` threaded through the handler method signature):

```ts
const { provider, model, effort } = resolveAgentForPhase(this.config, workflowName, 'implement');

const intent: ValidateFixIntent = {
  kind: 'validate-fix',
  prNumber,
  prompt,
  evidenceHash: hash,
  ...(model !== undefined ? { model } : {}),
  ...(effort !== undefined ? { effort } : {}),
};

const handle = await this.agentLauncher.launch({
  intent,
  cwd: checkoutPath,
  env: {},
  credentials: buildLaunchCredentials(this.config.credentialRole),
  provider,
});
```

**Caller change**: whoever invokes `runValidateFix()` (or equivalent public method) in the phase-loop must pass `item.workflowName` as a new argument. The item is already in scope at the call site.

## merge-conflict-handler — required change

**Current** (`packages/orchestrator/src/worker/merge-conflict-handler.ts:729-754`):

```ts
private async spawnAgentForConflict(
  checkoutPath: string,
  prompt: string,
  workflowId: string,
  issueNumber: number,
): Promise<boolean> {
  const handle = await this.agentLauncher.launch({
    intent: {
      kind: 'merge-conflict',
      issueNumber,
      prompt,
    } as MergeConflictIntent,
    cwd: checkoutPath,
    env: {},
    credentials: buildLaunchCredentials(this.config.credentialRole),
  });
  // ...
}
```

**Required** (add `workflowName: string` parameter; call `resolveAgentForPhase`; thread fields):

```ts
private async spawnAgentForConflict(
  checkoutPath: string,
  prompt: string,
  workflowId: string,
  issueNumber: number,
  workflowName: string,                                          // NEW
): Promise<boolean> {
  const { provider, model, effort } = resolveAgentForPhase(this.config, workflowName, 'implement');

  const handle = await this.agentLauncher.launch({
    intent: {
      kind: 'merge-conflict',
      issueNumber,
      prompt,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
    } as MergeConflictIntent,
    cwd: checkoutPath,
    env: {},
    credentials: buildLaunchCredentials(this.config.credentialRole),
    provider,
  });
  // ...
}
```

**Caller change**: the caller in `ClaudeCliWorker.handle()` (line ~445 per Explore-2 findings) already has `item.workflowName` in scope; pass it through.

## Q1 fallback — PR with no workflow label

When the PR has no resolvable `workflow:*`/`process:*` label, the caller passes `workflowName = "unknown"` (mirroring `pr-feedback-monitor-service.ts:1069-1108`). Then:

```
resolveAgentForPhase(config, "unknown", "implement")
```

walks:
1. `config.agents?.workflows?.["unknown"]?.phases?.implement` → undefined (no such workflow entry)
2. `config.agents?.workflows?.["unknown"]?.default` → undefined
3. `config.agents?.default` → whatever is configured (or undefined)
4. Falls through to `config.defaultsAgent` or `DEFAULT_PROVIDER='claude-code'` for `provider`; `undefined` for `model` and `effort`.

**Result**: when nothing is configured at any tier, the return is `{ provider: 'claude-code' }` — no model, no effort, byte-identical to today's ambient default (FR-010, SC-004).

**No workflow-invented fallback** — do NOT default `workflowName` to `"speckit-feature"` when unknown (Q1 explicitly rejected option A). This is critical for FR-010 parity on un-labeled PRs.

## Zero-config baseline (SC-004)

When the repo has no `agents` block:
- `resolveAgentForPhase` returns `{ provider: 'claude-code' }` (no model, no effort).
- Each fixer intent has neither `model` nor `effort` set.
- `LaunchRequest.provider = 'claude-code'` — the launcher's registry-lookup key is unchanged.
- Plugin builder emits argv with no `--model` and no `--effort`.

Byte-identical to pre-change baseline. Snapshot-tested per SC-004.
