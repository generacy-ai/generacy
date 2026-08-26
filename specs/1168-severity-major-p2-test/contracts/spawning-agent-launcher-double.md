# Contract: Spawning `AgentLauncher` test double (Q1→A)

A lightweight test double injected as `ReviewExecutor`'s `agentLauncher`. Its `launch()`
**really spawns** the scripted CLI fixture and returns a real `ChildProcessHandle`, keeping the
executor and verdict recomputation fully real (SC-002). It is NOT a verdict-steering stub.

Location: `packages/orchestrator/src/worker/__tests__/helpers/spawning-agent-launcher.ts`.

## Interface satisfied

The executor calls (`review-executor.ts:203`):

```ts
const handle = await this.agentLauncher.launch({
  intent: { kind: 'review', issueNumber, prompt, model?, effort? } as ReviewIntent,
  cwd: checkoutPath,
  env: {},
  credentials,
  provider,
});
child = handle.process;
```

So the double must expose `launch(request): Promise<LaunchHandle>` where `LaunchHandle`
(`launcher/types.ts:248`) is:

```ts
interface LaunchHandle {
  process: ChildProcessHandle;             // the real spawned child
  outputParser: OutputParser;              // minimal stub: { processChunk() {}, flush() {} }
  metadata: { pluginId: string; intentKind: string; [k: string]: unknown };
}
```

## `launch()` behavior (write/withhold path)

1. `child_process.spawn(process.execPath, [FIXTURE_PATH], { cwd: request.cwd, env: { ...process.env, FIXTURE_CHECKOUT_PATH, FIXTURE_WORKFLOW_ID, FIXTURE_MODE, FIXTURE_CANDIDATE_JSON } })`.
   The per-scenario env is closed over by the harness when it constructs the double.
2. Adapt the Node `ChildProcess` to `ChildProcessHandle` (`worker/types.ts:591`):
   - `stdin/stdout/stderr` → the child's streams (or `null`);
   - `pid` → `child.pid`;
   - `kill(signal?)` → `child.kill(signal)`;
   - `exitPromise` → `new Promise<number|null>((res) => child.on('exit', (code) => res(code)))`.
3. Return `{ process, outputParser: noopParser, metadata: { pluginId: 'test-spawning-double', intentKind: 'review' } }`.

## Constraints

- No verdict logic, no findings synthesis — the double only spawns and adapts. All verdict
  authority stays in `ReviewExecutor` + `computeVerdict` (SC-002).
- `env: {}` on the executor's launch request is intentionally empty (the executor does not add
  agent env); the double supplies the `FIXTURE_*` env itself.
- SC-002 verification: grep the new suite for direct `ReviewExecutor` construction wired into
  `PhaseLoopDeps.reviewExecutor` with this real-spawn double and no verdict-steering stub.

## Not used for failure paths (Q2→A)

The timeout and non-zero-exit scenarios do **not** use this double. They inject a
mocked / hanging `ChildProcessHandle` (EventEmitter-style, per
`phase-loop.remediate-timeout.integration.test.ts`) with a hand-constructed tiny
`phaseTimeoutMs`, so no genuinely-hanging real process is spawned.
